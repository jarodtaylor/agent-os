/**
 * launchd supervision installer — runs the brain server as a macOS LaunchAgent (`RunAtLoad` + `KeepAlive`), so
 * it survives crashes and logout/login and a down substrate can never silently produce a cold start (KTD9).
 *
 * The plist is a file we OWN outright (no foreign process rewrites it), so it is published whole via the config-write
 * engine's `writeTextFile` — backup-first, atomic, journaled — and uninstall reverses it by replaying that journal
 * (backup-restore), not by deleting blindly: a plist that predates us is restored byte-identically, and a plist
 * edited since our write makes the identity-checked `undo` refuse rather than clobber it.
 *
 * Every `launchctl` call goes through an injectable runner so tests never touch the real launchd domain.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppliedButUnjournaledError, listUndo, undo, writeTextFile, type MergeResult } from "../configwrite/index";
import { ensureDataDir, resolveDataDir, resolvePort, SUPERVISOR_ENV } from "../paths";
import { acquireSingleInstanceLock } from "../server/single-instance";
import { defaultRepoRoot, errorText, type UninstallOutcome } from "./shared";

export const LAUNCHD_LABEL = "com.agent-os.server";

/** Runs `launchctl <args>` and reports its exit code + stderr. */
export type Launchctl = (args: string[]) => { code: number; stderr: string };

const realLaunchctl: Launchctl = (args) => {
  const res = Bun.spawnSync(["launchctl", ...args], { stdout: "ignore", stderr: "pipe" });
  return { code: res.exitCode, stderr: res.stderr.toString().trim() };
};

export interface LaunchdOptions {
  /** Home dir whose `~/Library/LaunchAgents` receives the plist. Defaults to `os.homedir()`; tests inject a temp dir. */
  home?: string;
  /** Repo root the agent runs the server from. Defaults to this module's own repo. */
  repoRoot?: string;
  /** Data dir for the server, its log, and the engine's backups + undo journal. Defaults to the OS data dir. */
  dataDir?: string;
  /** Port baked into the agent's environment. Defaults to `resolvePort()` — the same port the other installers dial. */
  port?: number;
  /** Absolute bun binary. launchd's PATH is minimal, so the plist must name it. */
  bunPath?: string;
  /** `launchctl` runner. Defaults to the real binary. */
  launchctl?: Launchctl;
  /** The user's launchd GUI domain id. Defaults to the current uid. */
  uid?: number;
}

export const plistPath = (home: string): string => join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const serviceTarget = (uid: number): string => `gui/${uid}/${LAUNCHD_LABEL}`;

function resolve(opts: LaunchdOptions) {
  return {
    home: opts.home ?? homedir(),
    repoRoot: opts.repoRoot ?? defaultRepoRoot(),
    dataDir: resolveDataDir(opts.dataDir),
    port: opts.port ?? resolvePort(),
    // PATH lookup first: a version manager's stable path (e.g. mise's `.../bun/latest/bin/bun`) survives a bun
    // upgrade, whereas `process.execPath` is the version-pinned binary a prune would delete from under the agent.
    bunPath: opts.bunPath ?? Bun.which("bun") ?? process.execPath,
    launchctl: opts.launchctl ?? realLaunchctl,
    uid: opts.uid ?? process.getuid?.() ?? 0,
  };
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Render `templates/com.agent-os.server.plist` with this install's values, XML-escaped (paths may contain `&`). */
export function renderPlist(v: { repoRoot: string; dataDir: string; port: number; bunPath: string }): string {
  const values: Record<string, string> = {
    LABEL: LAUNCHD_LABEL,
    BUN: v.bunPath,
    ENTRY: join(v.repoRoot, "src", "server", "index.ts"),
    REPO_ROOT: v.repoRoot,
    PORT: String(v.port),
    DATA_DIR: v.dataDir,
    SUPERVISOR_ENV,
    LOG: join(v.dataDir, "logs", "server.log"),
  };
  const template = readFileSync(join(v.repoRoot, "templates", `${LAUNCHD_LABEL}.plist`), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`launchd: unknown template placeholder '{{${key}}}'`);
    return xmlEscape(values[key]);
  });
}

const loadedIn = ({ launchctl, uid }: { launchctl: Launchctl; uid: number }): boolean =>
  launchctl(["print", serviceTarget(uid)]).code === 0;

/** Whether the plist is installed and the agent is currently loaded in the user's GUI domain. */
export function launchdStatus(opts: LaunchdOptions = {}): { installed: boolean; loaded: boolean } {
  const r = resolve(opts);
  return { installed: existsSync(plistPath(r.home)), loaded: loadedIn(r) };
}

export interface LaunchdInstallResult {
  plist: MergeResult;
  /** true when this call (re)bootstrapped the agent; false when it was already loaded with identical bytes. */
  bootstrapped: boolean;
}

/**
 * Publish the plist through the engine. If the write lands but its undo entry doesn't (`AppliedButUnjournaledError`),
 * nothing could later reverse it and RunAtLoad would start this failed install at the next login — so revert it here
 * (restore the backup, or delete a plist we created), only while it still holds the bytes we wrote.
 */
function publishPlist(r: ReturnType<typeof resolve>): MergeResult {
  const path = plistPath(r.home);
  const content = renderPlist(r);
  try {
    return writeTextFile(path, content, { dataDir: r.dataDir });
  } catch (err) {
    if (!(err instanceof AppliedButUnjournaledError)) throw err;
    let outcome = "plist reverted";
    try {
      if (readFileSync(path, "utf8") !== content) outcome = "plist changed since our write; left in place";
      else if (err.backupPath) copyFileSync(err.backupPath, path);
      else rmSync(path, { force: true });
    } catch (revertErr) {
      outcome = `plist NOT reverted: ${errorText(revertErr)}`;
    }
    throw new Error(`launchd: ${err.message} (${outcome})`, { cause: err });
  }
}

/**
 * Write the plist and load the agent. Idempotent: identical bytes on an already-loaded agent is a full no-op.
 * Changed bytes reload it (bootout, then bootstrap) so launchd runs the new definition. If the bootstrap fails, a
 * plist this call wrote is rolled back — a failed install never leaves an unloaded plist that would surprise-start
 * at the next login.
 */
export function installLaunchd(opts: LaunchdOptions = {}): LaunchdInstallResult {
  const r = resolve(opts);
  // launchd opens the log paths but never creates their directory.
  ensureDataDir(r.dataDir);
  mkdirSync(join(r.dataDir, "logs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(r.home, "Library", "LaunchAgents"), { recursive: true });

  const loaded = loadedIn(r);
  // An unsupervised server already holding the data dir's lock would make every launchd-spawned child exit at
  // boot, and KeepAlive would respawn it forever — a silent crash loop. Probe the lock (and release it at once)
  // unless our own agent is the holder.
  if (!loaded) {
    try {
      acquireSingleInstanceLock(r.dataDir)();
    } catch (err) {
      throw new Error(`launchd: an agent-os server is already running outside launchd — stop it, then install (${errorText(err)})`);
    }
  }

  const plist = publishPlist(r);
  if (plist.noop && loaded) return { plist, bootstrapped: false };

  const bootstrap = () => r.launchctl(["bootstrap", `gui/${r.uid}`, plistPath(r.home)]);
  if (loaded) r.launchctl(["bootout", serviceTarget(r.uid)]);
  const boot = bootstrap();
  if (boot.code !== 0) {
    // Roll back the plist this call wrote; if we stopped a running agent to reload it, start the restored definition
    // again rather than leave the server down. Each step is guarded on its own and any failure is appended to the
    // error, so a server left down is never silent — and the original bootstrap failure is never masked.
    const notes: string[] = [];
    try {
      if (plist.undoId) undo(plist.undoId, r.dataDir);
    } catch (err) {
      notes.push(`plist rollback failed: ${errorText(err)}`);
    }
    if (loaded) {
      const again = bootstrap();
      if (again.code !== 0) notes.push(`previous agent NOT restarted (exit ${again.code}): ${again.stderr}`);
    }
    throw new Error(`launchd: bootstrap failed (exit ${boot.code}): ${boot.stderr}${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}`);
  }
  return { plist, bootstrapped: true };
}

/**
 * Stop the agent and reverse the plist by replaying its undo journal newest-first (backup-restore), stopping at the
 * write that created it. Cross-process by design: it reads the on-disk journal, so it works days after install.
 * A refused restore (the plist was hand-edited) is reported in `failed`, never thrown.
 */
export function uninstallLaunchd(opts: LaunchdOptions = {}): UninstallOutcome {
  const r = resolve(opts);
  const path = plistPath(r.home);
  const outcome: UninstallOutcome = { removed: [], failed: [], warnings: [] };

  if (loadedIn(r)) {
    const out = r.launchctl(["bootout", serviceTarget(r.uid)]);
    if (out.code !== 0) outcome.failed.push({ path: serviceTarget(r.uid), error: `bootout exit ${out.code}: ${out.stderr}` });
  }

  try {
    for (const entry of listUndo(r.dataDir).filter((e) => e.targetPath === path).reverse()) {
      if (!existsSync(path)) break;
      if (undo(entry.id, r.dataDir) === "reversed" && !outcome.removed.includes(path)) outcome.removed.push(path);
      if (entry.created) break;
    }
  } catch (err) {
    console.error(`[agent-os] uninstall: could not restore '${path}':`, err);
    outcome.failed.push({ path, error: errorText(err) });
  }
  return outcome;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "install") {
    const { plist, bootstrapped } = installLaunchd();
    console.log(`[agent-os] ${plist.targetPath}: ${plist.noop ? "unchanged" : "written"}; ${bootstrapped ? "agent (re)loaded" : "agent already loaded"}`);
  } else if (cmd === "uninstall") {
    const { removed, failed } = uninstallLaunchd();
    console.log(`[agent-os] removed: ${removed.join(", ") || "(nothing)"}`);
    if (failed.length > 0) {
      for (const f of failed) console.error(`[agent-os] failed: ${f.path}: ${f.error}`);
      process.exit(1);
    }
  } else if (cmd === "status") {
    const { installed, loaded } = launchdStatus();
    console.log(`[agent-os] plist ${installed ? "installed" : "absent"}; agent ${loaded ? "loaded" : "not loaded"}`);
  } else {
    console.error("usage: bun run supervise <install|uninstall|status>");
    process.exit(2);
  }
}
