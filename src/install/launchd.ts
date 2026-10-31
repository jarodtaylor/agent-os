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
import { AppliedButUnjournaledError, hashContent, listUndo, undo, writeTextFile, type MergeResult } from "../configwrite/index";
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

/** Whether the server on `port` answers `/health` as the launchd-supervised instance. Injected by tests. */
export type HealthProbe = (port: number) => Promise<boolean>;

const realHealthProbe: HealthProbe = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok && ((await res.json()) as { supervisor?: unknown }).supervisor === "launchd";
  } catch {
    return false;
  }
};

export interface LaunchdOptions {
  /** Home dir whose `~/Library/LaunchAgents` receives the plist. Defaults to `os.homedir()`; tests inject a temp dir. */
  home?: string;
  /** Repo root the agent runs the server from. Defaults to this module's own repo. */
  repoRoot?: string;
  /** Data dir for the server and its log. Defaults to the OS data dir. */
  dataDir?: string;
  /** Port baked into the agent's environment. Defaults to `resolvePort()` — the same port the other installers dial. */
  port?: number;
  /** Absolute bun binary. launchd's PATH is minimal, so the plist must name it. */
  bunPath?: string;
  /** `launchctl` runner. Defaults to the real binary. */
  launchctl?: Launchctl;
  /** The user's launchd GUI domain id. Defaults to the current uid. */
  uid?: number;
  /** Readiness check run after every (re)load. Defaults to polling `/health` on `port`. */
  healthy?: HealthProbe;
  /** How long a (re)loaded agent has to answer `/health` before the install is treated as failed. */
  readyTimeoutMs?: number;
}

export const plistPath = (home: string): string => join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const serviceTarget = (uid: number): string => `gui/${uid}/${LAUNCHD_LABEL}`;
/** Where the plist's backups + undo journal live. Keyed to `home` like the plist path itself, NOT to the server's
 *  configurable data dir: a reinstall with a different data dir must still find the whole journal chain, or
 *  uninstall would stop short and restore a RunAtLoad plist instead of removing it. */
const installStateDir = (home: string): string => join(home, "Library", "Application Support", "agent-os");

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
    healthy: opts.healthy ?? realHealthProbe,
    readyTimeoutMs: opts.readyTimeoutMs ?? 15_000,
    stateDir: installStateDir(opts.home ?? homedir()),
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
    return writeTextFile(path, content, { dataDir: r.stateDir });
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

/** Poll the readiness probe until it passes or the timeout elapses. */
async function becameHealthy(r: ReturnType<typeof resolve>): Promise<boolean> {
  const deadline = Date.now() + r.readyTimeoutMs;
  do {
    if (await r.healthy(r.port)) return true;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  return false;
}

/**
 * Write the plist, load the agent, and wait until the server it starts answers `/health` as supervised. Idempotent:
 * identical bytes on an already-loaded, healthy agent is a full no-op. Changed bytes reload it (bootout, then
 * bootstrap). A load that fails — launchctl refuses it, or the server never becomes healthy (a taken port, a crash at
 * boot) — is rolled back: the new agent is stopped and the plist this call wrote is restored. It does NOT restart an
 * agent it stopped for a reload: install is run by hand, so a failure throws an error that says the server is down,
 * and the operator fixes the cause and re-runs install. A failed install never reports success for a server that is
 * not up, and every rollback step that fails is named in the error.
 */
export async function installLaunchd(opts: LaunchdOptions = {}): Promise<LaunchdInstallResult> {
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
  const log = join(r.dataDir, "logs", "server.log");
  if (plist.noop && loaded) {
    // Nothing to change — but an already-loaded agent that is not answering is not "installed"; say so.
    if (!(await becameHealthy(r))) throw new Error(`launchd: the agent is loaded but its server is not healthy — see ${log}`);
    return { plist, bootstrapped: false };
  }

  const target = serviceTarget(r.uid);
  if (loaded) {
    // Stop the running agent so the new definition can load. If it won't stop, nothing has changed yet except the
    // plist on disk — restore it and say the old server is still running, rather than bootstrap over it.
    const out = r.launchctl(["bootout", target]);
    if (out.code !== 0 || loadedIn(r)) {
      let restored = "previous plist restored";
      try {
        if (plist.undoId) undo(plist.undoId, r.stateDir);
      } catch (err) {
        restored = `the new plist was NOT rolled back and will load at the next login: ${errorText(err)}`;
      }
      throw new Error(`launchd: could not stop the running agent to reload it (bootout exit ${out.code}: ${out.stderr}) — the previous server is still running; ${restored}`);
    }
  }
  const boot = r.launchctl(["bootstrap", `gui/${r.uid}`, plistPath(r.home)]);
  let failure: string;
  if (boot.code !== 0) failure = `bootstrap failed (exit ${boot.code}): ${boot.stderr}`;
  else if (await becameHealthy(r)) return { plist, bootstrapped: true };
  else failure = `the server did not become healthy within ${r.readyTimeoutMs}ms — see ${log}`;

  // Roll back. Each step is checked on its own and named in the error if it fails, so nothing is left in a bad state
  // silently — and the original failure is never masked.
  const notes: string[] = [];
  if (boot.code === 0) {
    // Stop the failing agent, or KeepAlive keeps restarting it.
    const out = r.launchctl(["bootout", target]);
    if (out.code !== 0 || loadedIn(r)) notes.push(`the failing agent is still loaded (bootout exit ${out.code}) — stop it with: launchctl bootout ${target}`);
  }
  try {
    if (plist.undoId) undo(plist.undoId, r.stateDir);
  } catch (err) {
    notes.push(`the new plist was NOT rolled back and will start at the next login: ${errorText(err)}`);
  }
  if (loaded) notes.push("the server is DOWN (its agent was stopped for the reload) — fix the cause, then re-run install");
  throw new Error(`launchd: ${failure}${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}`);
}

/**
 * Stop the agent and reverse the plist by replaying its undo journal newest-first (backup-restore), stopping at the
 * write that created it. Cross-process by design: it reads the on-disk journal, so it works days after install.
 *
 * Each step undoes the next-older entry whose written bytes match the plist on disk NOW, not simply the next entry —
 * so an uninstall that died partway resumes where it stopped (even across a reinstall in between), and a repeated
 * uninstall after a pre-existing plist was restored is a clean no-op. The cursor is the file itself, so every step
 * stays identity-checked.
 * A plist that matches nothing we wrote or restored (hand-edited) is reported in `failed` and left in place.
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
    if (!existsSync(path)) return outcome;
    const entries = listUndo(r.stateDir).filter((e) => e.targetPath === path).reverse();
    // Follow the chain by content: each step undoes the next-older entry whose written bytes are what the file holds
    // now, so interrupted uninstalls and reinstalls in between (journal branches) never derail the replay.
    let current = hashContent(readFileSync(path));
    let matched = false;
    for (const entry of entries) {
      if (entry.postHash !== current) continue;
      matched = true;
      if (undo(entry.id, r.stateDir) === "reversed" && !outcome.removed.includes(path)) outcome.removed.push(path);
      if (entry.created || !existsSync(path)) break;
      current = hashContent(readFileSync(path));
    }
    if (!matched) {
      const restoredAlready = entries.some((e) => e.backupPath && existsSync(e.backupPath) && hashContent(readFileSync(e.backupPath)) === current);
      if (!restoredAlready && entries.length > 0) outcome.failed.push({ path, error: "plist changed since agent-os wrote it — left in place" });
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
    const { plist, bootstrapped } = await installLaunchd();
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
