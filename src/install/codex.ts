/**
 * Codex installer (U8) — registers Agent OS's brain MCP server in `~/.codex/config.toml`, the
 * SessionStart hook in `~/.codex/hooks.json`, and a continuity pointer in `~/.codex/AGENTS.md`.
 * EVERY structured write goes through the U14 config-write engine (backup-first, atomic, journaled
 * undo) because these are Jarod's LIVE daily-driver configs (R11 / KTD6) — same discipline as the
 * Claude Code installer (`src/install/claude-code.ts`), mirrored here for the second harness.
 *
 * Three writes, in order — (c) is LAST because it's the most reversible (see below):
 *   (a) `~/.codex/config.toml`  — `[mcp_servers.agent-os]`, an object-key merge (deepMerge preserves
 *       every other server — `uidotsh`, `codebase-memory-mcp`, ... — without a read-modify-write). NO
 *       `type` field: Codex's own url-based servers (see the existing `uidotsh` entry) don't carry one.
 *       The STABLE Codex credential (`resolveCodexToken`) IS embedded here (unlike Claude Code's
 *       per-call headersHelper): Codex's HTTP-MCP client can only send a static header, so this is the
 *       one intentional narrowing of "installed config never embeds the token" (U8 decision A; the write
 *       passes the engine's `targetMode: 0o600` so the token-bearing config is PUBLISHED owner-only — the
 *       engine otherwise preserves a pre-existing file's mode). `[hooks.state]` is untouched — our patch never mentions `hooks`, and
 *       Codex owns its own hook-trust hashing there.
 *   (b) `~/.codex/hooks.json` — `hooks.SessionStart`, read-modify-write the WHOLE array (deepMerge
 *       REPLACES arrays — patch wins), exactly like the CC installer's settings.json hooks: strip our
 *       own prior entry by command match (idempotent re-install), then append ours, preserving every
 *       OTHER existing entry (Jarod's real hooks.json already has a herdr hook + a codebase-memory echo
 *       hook — both must survive).
 *   (c) `~/.codex/AGENTS.md` — a marked-block upsert (`<!-- agent-os:start/end -->`), NOT mergeConfig:
 *       U14 has no markdown mode. This write is reversible BY CONSTRUCTION (uninstall strips exactly the
 *       marked span, whatever else in the file has changed since install), so it deliberately skips the
 *       undo journal — a byte-exact whole-file backup would buy nothing a structural strip doesn't
 *       already guarantee, and would be a backup nothing ever restores from.
 *
 * Cross-file transactionality: pre-flight-parse BOTH structured targets before writing either, so the
 * realistic failure — one of them is corrupt — is all-or-nothing (mirrors installClaudeCode). If a LATER
 * write then fails for some other reason (symlink, permissions, a journal error), the earlier U14 writes
 * are rolled back via their `undoId` — best-effort, propagating the ORIGINAL error — so a failed install
 * never leaves a partial Codex configuration. The same rollback also revokes `codex.token` when THIS
 * install minted it fresh (never when it pre-existed) — otherwise a failed install would strand a live,
 * unreferenced credential the gate still accepts (see `installCodex`'s `tokenPreexisted` guard).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { mergeConfig, removeConfigKeys, undo, type MergeResult } from "../configwrite/index";
import { codexTokenPath, readCodexToken, resolveCodexToken, resolveDataDir, resolvePort, TOKEN_HEADER } from "../paths";
import { bunCommand, defaultRepoRoot, existingEntriesWithoutOurs, readJson, removeHooksIfPresent } from "./shared";

/** The brain's MCP server name in `~/.codex/config.toml` (mirrors the Claude Code `mcpServers.agent-os` key). */
const SERVER_NAME = "agent-os";
/** Per-hook timeout (seconds) — same ceiling as the Claude Code installer's hooks. */
const HOOK_TIMEOUT_S = 10;
/** Marks the AGENTS.md span we own, so re-install replaces it in place instead of duplicating it. */
const BLOCK_START = "<!-- agent-os:start -->";
const BLOCK_END = "<!-- agent-os:end -->";

export interface InstallOptions {
  /** Home dir whose `~/.codex/{config.toml,hooks.json,AGENTS.md}` are written. Defaults to `os.homedir()`;
   *  tests inject a temp dir so they never touch the real setup. */
  home?: string;
  /** Absolute repo root the installed hook command AND the AGENTS.md template are read from. Defaults to
   *  this module's own repo. */
  repoRoot?: string;
  /** Data dir for the engine's backups + undo journal, and the stable Codex token file. Defaults to the
   *  OS data dir; tests inject a temp dir. */
  dataDir?: string;
  /** Loopback port baked into the MCP `url`. Defaults to `resolvePort()` (what the server binds). */
  port?: number;
}

export interface AgentsMdResult {
  path: string;
  /** true when AGENTS.md did not exist and was created (containing just our block). */
  created: boolean;
  /** true when the file's bytes changed (false ⇒ a true no-op, same as MergeResult.noop). */
  changed: boolean;
}

export interface InstallResult {
  /** The `~/.codex/config.toml` MCP-registration write. */
  config: MergeResult;
  /** The `~/.codex/hooks.json` hook-registration write. */
  hooks: MergeResult;
  /** The `~/.codex/AGENTS.md` pointer-block upsert. */
  agentsMd: AgentsMdResult;
}

const codexDir = (home: string): string => join(home, ".codex");
const configTomlPath = (home: string): string => join(codexDir(home), "config.toml");
const hooksJsonPath = (home: string): string => join(codexDir(home), "hooks.json");
const agentsMdPath = (home: string): string => join(codexDir(home), "AGENTS.md");

/** Parse a TOML config file; `undefined` when absent. Throws on corrupt TOML, for the same fail-closed
 *  reason as `readJson` — this is a PRE-FLIGHT check only (mergeConfig re-parses authoritatively). */
function readToml(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`install: existing '${path}' is not valid TOML — fix or remove it before installing`);
  }
}

/** Roll back a set of prior successful merges, best-effort — never mask the original failure the caller is
 *  already propagating. */
function rollback(results: MergeResult[], dataDir: string): void {
  for (const r of results) {
    if (!r.undoId) continue;
    try {
      undo(r.undoId, dataDir);
    } catch (err) {
      // Best-effort — the original error is what propagates; log so a swallowed rollback failure isn't invisible.
      console.error(`[agent-os] install: rollback of '${r.targetPath}' failed (leaving it as-is):`, err);
    }
  }
}

/** Best-effort delete of `codex.token`, called from installCodex's rollback catches — but ONLY when THIS
 *  install minted the token fresh (callers guard with `!tokenPreexisted`). A failed install must not strand
 *  a live, unreferenced credential the gate still accepts (`config.toml`'s `mcp_servers.agent-os` entry gets
 *  rolled back, but resolveCodexToken already persisted the token file itself independently of that entry).
 *  A failed REINSTALL over a pre-existing token must PRESERVE it — never masks the original install error. */
function revokeMintedToken(dataDir: string): void {
  try {
    rmSync(codexTokenPath(dataDir), { force: true });
  } catch {
    // Best-effort — the original install error is what propagates.
  }
}

/** Bare `<!-- agent-os:start -->...<!-- agent-os:end -->` span matcher (no surrounding whitespace) — shared
 *  by the upsert's in-place replace and the uninstall's strip, so both agree on exactly what "our block" is. */
function blockSpanPattern(): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${esc(BLOCK_START)}[\\s\\S]*?${esc(BLOCK_END)}`);
}

/**
 * Upsert the marked pointer block into AGENTS.md: replace the existing `agent-os:start/end` span in place
 * if present (untouched surrounding content), else append one after a blank-line separator (creating the
 * file if it's absent). The body is read FRESH from `templates/agents-md-pointer.md` at repoRoot on every
 * call, so editing the template and re-installing updates the installed block. Idempotent: re-running with
 * an unchanged template yields byte-identical content, reported as `changed: false` (this write doesn't go
 * through the U14 engine, so it has no `noop` of its own — this is the equivalent signal).
 */
function upsertAgentsMdBlock(path: string, repoRoot: string): AgentsMdResult {
  const body = readFileSync(join(repoRoot, "templates", "agents-md-pointer.md"), "utf8").trim();
  const block = `${BLOCK_START}\n${body}\n${BLOCK_END}`;
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, "utf8") : "";

  const span = blockSpanPattern();
  let after: string;
  if (span.test(before)) {
    after = before.replace(span, block);
  } else if (existed) {
    after = `${before.replace(/\n+$/, "")}\n\n${block}\n`;
  } else {
    after = `${block}\n`;
  }

  if (existed && after === before) {
    return { path, created: false, changed: false };
  }
  // Atomic write (mirrors resolveCodexToken/the engine's temp+rename): a mid-write fault must never corrupt
  // Jarod's LIVE ~/.codex/AGENTS.md — a partial write lands only in the sibling temp, which a crash leaves
  // orphaned but never substitutes for the real file. A rename REPLACES the target's inode wholesale, so an
  // existing file's mode would otherwise be silently reset to the tmp's default — re-apply it first, exactly
  // as the engine's own mergeConfig does across its own temp+rename.
  const originalMode = existed ? statSync(path).mode & 0o777 : null;
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, after);
  if (originalMode !== null) chmodSync(tmp, originalMode);
  renameSync(tmp, path);
  return { path, created: !existed, changed: true };
}

/** Strip our marked block from AGENTS.md, collapsing the separator it leaves behind. Returns `false` (no-op)
 *  when the file is absent or carries no block of ours. When stripping empties the file (we created it fresh
 *  containing just the block), the file is deleted rather than left as an empty husk — the structural
 *  analogue of the U14 journal's `created ⇒ undo deletes it`. */
function stripAgentsMdBlock(path: string): boolean {
  if (!existsSync(path)) return false;
  const before = readFileSync(path, "utf8");
  if (!blockSpanPattern().test(before)) return false;

  const stripped = before.replace(blockSpanPattern(), "").replace(/\n{3,}/g, "\n\n");
  if (stripped.trim() === "") {
    rmSync(path, { force: true });
  } else {
    // Same atomic temp+rename as the upsert above — a mid-write fault must never corrupt the live file, and the
    // original mode survives the inode swap (see upsertAgentsMdBlock's comment; `path` is known to exist here).
    const originalMode = statSync(path).mode & 0o777;
    const tmp = `${path}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, stripped.replace(/\s+$/, "\n"));
    chmodSync(tmp, originalMode);
    renameSync(tmp, path);
  }
  return true;
}

/**
 * Register the MCP server + SessionStart hook + AGENTS.md pointer. Idempotent: a second run with the same
 * inputs re-derives identical bytes for all three targets, so config.toml/hooks.json no-op at the engine
 * level and AGENTS.md reports `changed: false`.
 */
export function installCodex(opts: InstallOptions = {}): InstallResult {
  const home = opts.home ?? homedir();
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const dataDir = resolveDataDir(opts.dataDir);
  const port = opts.port ?? resolvePort();
  // Captured BEFORE any write below can mint one (resolveCodexToken runs INSIDE the config.toml patch built
  // a few lines down): tells the rollback catches whether THIS install created codex.token, so a failed
  // install revokes only the credential it minted itself and never revokes a prior install's still-valid one.
  // SEMANTIC check (readCodexToken — a valid non-empty token pre-existed), not path-existence: an empty or
  // whitespace-only leftover file passes `existsSync` but `resolveCodexToken` treats it as absent and mints
  // fresh OVER it, so `existsSync` alone would misreport "preexisted" and rollback would skip cleanup,
  // stranding the freshly-minted token as a live credential the gate (which reads codex.token fresh per
  // request) keeps accepting after a failed install.
  const tokenPreexisted = readCodexToken(codexTokenPath(dataDir)) !== null;

  // Ensure ~/.codex exists so the atomic writes below have a home on a fresh machine. mode:0700 applies ONLY
  // when this CREATES it (owner-only, a safe default); an EXISTING ~/.codex is deliberately left alone — it's
  // Codex's dir to own, not ours to tighten (same reasoning as the CC installer's ~/.claude).
  mkdirSync(codexDir(home), { recursive: true, mode: 0o700 });

  // Pre-flight-parse BOTH structured targets before writing EITHER: the two mergeConfig writes below are not
  // a cross-file transaction, so a corrupt hooks.json would otherwise throw AFTER config.toml is already
  // mutated (a partial install). AGENTS.md is plain text — no "corrupt" state to pre-empt.
  //
  // Honest narrowing of the "never leaves a partial install" claim: the rollback try/catch below covers
  // writes (b) hooks.json and (c) AGENTS.md — each undoes everything written BEFORE it if it fails. The
  // FIRST write (a) config.toml is NOT itself wrapped in a rollback try, so it has a narrow post-atomic-
  // rename window where mergeConfig's own undo-journal write throws (see engine.ts's `committed` split):
  // the credential would then be live on disk with no rollback attempted. This is a pre-existing property
  // of the shared U14 engine, not specific to Codex — the Claude Code installer's settings.json write has
  // the identical gap — tracked with the decision-#16 config-write robustness cluster. The full fix
  // (journal-before-publish, or committed-failure metadata the caller can act on) belongs in the engine
  // itself and is deferred.
  readToml(configTomlPath(home)); // parsed only to fail fast; mergeConfig re-reads it authoritatively below
  readJson(hooksJsonPath(home)); // pre-flight fail-fast; the hooks RMW array is built from the engine's OWN read below

  // ── (a) MCP server → ~/.codex/config.toml ────────────────────────────────────────────────────────────
  // Object-key merge (mcp_servers.agent-os) — deepMerge preserves every OTHER server, so no read-modify-write
  // is needed here (same reasoning as the CC installer's ~/.claude.json MCP write). `replaceSubtrees` wholesale-
  // replaces the OWNED mcp_servers.agent-os subtree instead of re-merging it, so a stale key on a pre-existing
  // entry — an old embedded token left in a foreign `http_headers`, say — cannot survive (idempotent: the
  // stable resolveCodexToken means a re-install reproduces identical bytes ⇒ the engine no-ops).
  const config = mergeConfig(
    configTomlPath(home),
    {
      mcp_servers: {
        [SERVER_NAME]: {
          url: `http://127.0.0.1:${port}/mcp`,
          // The STABLE Codex credential (U8 decision A): Codex's HTTP-MCP client sends only a static
          // header, so — unlike CC's per-call headersHelper — the token IS embedded here, in this config
          // (published owner-only 0600 via the engine's targetMode below), like the existing `uidotsh` bearer.
          http_headers: { [TOKEN_HEADER]: resolveCodexToken(dataDir) },
        },
      },
    },
    // targetMode 0600: this file embeds the bearer token, so publish it owner-only — never rename it into place
    // at a pre-existing looser mode and tighten afterwards (that leaves a world-readable window a local observer
    // could catch). The engine still journals the original mode, so uninstall restores pre-install permissions.
    { dataDir, targetMode: 0o600, replaceSubtrees: [`mcp_servers.${SERVER_NAME}`] },
  );

  // ── (b) SessionStart hook → ~/.codex/hooks.json ──────────────────────────────────────────────────────
  // Read-modify-write the WHOLE array (deepMerge would REPLACE it): strip our own prior entry, append ours,
  // keep every other existing entry (Jarod's herdr hook + codebase-memory echo hook must survive). The callback
  // builds the array from the engine's OWN read, so a concurrent Codex write can't land after a pre-read and be
  // reverted (closes the non-atomic double-read — the hooks.json pre-flight above is fail-fast only).
  const startCmd = bunCommand(repoRoot, "codex-session-start.ts");
  let hooks: MergeResult;
  try {
    hooks = mergeConfig(
      hooksJsonPath(home),
      (current: unknown) => ({
        hooks: {
          SessionStart: [
            ...existingEntriesWithoutOurs(current, "SessionStart", startCmd),
            // Same matcher as the pre-existing codebase-memory echo hook — the "fresh/reset context" moments.
            { matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: startCmd, timeout: HOOK_TIMEOUT_S }] },
          ],
        },
      }),
      { dataDir },
    );
  } catch (err) {
    // config.toml is now LIVE. Roll it back so a failed install never leaves the MCP server registered
    // without the hook (all-or-nothing across both structured targets).
    rollback([config], dataDir);
    if (!tokenPreexisted) revokeMintedToken(dataDir);
    throw err;
  }

  // ── (c) Pointer block → ~/.codex/AGENTS.md — LAST (most reversible: a structural strip, not a restore) ──
  let agentsMd: AgentsMdResult;
  try {
    agentsMd = upsertAgentsMdBlock(agentsMdPath(home), repoRoot);
  } catch (err) {
    rollback([config, hooks], dataDir);
    if (!tokenPreexisted) revokeMintedToken(dataDir);
    throw err;
  }

  return { config, hooks, agentsMd };
}

/**
 * Reverse the install by TARGETED removal of only what we added — the correct reversal for the configs Codex
 * co-owns and rewrites continuously — then REVOKE the stable Codex credential (delete `codex.token`).
 * CROSS-PROCESS by design (nothing depends on install-time journal state; it removes our keys from whatever is
 * on disk NOW), mirroring `uninstallClaudeCode`. Per-target try/catch so one diverged/corrupt target never
 * aborts the others — but credential revocation itself is NOT best-effort: it runs LAST, after the cleanups,
 * and THROWS if `codex.token` still exists afterward, so a caller never mistakes a non-revoking uninstall for
 * success. Returns the paths actually changed (the credential revocation is not a file "change" and is
 * deliberately not in that list).
 *
 * Three targeted removals, each tolerant of a target that diverged since install (the whole point — the old
 * whole-file `undo` restore THREW on the near-always-diverged live-state files and left our entries behind):
 *   (a) config.toml — delete only `mcp_servers.agent-os` (removeConfigKeys). This is what the byte-exact undo
 *       couldn't do: config.toml is Codex's live-state file (model/approval settings, trust hashes), so its
 *       identity-checked undo was near-always SKIPPED; removeConfigKeys deletes our key from the live file
 *       whatever else changed. The codex.token revocation below is now DEFENCE IN DEPTH — it still neutralizes
 *       any entry left behind should this removal itself fail (a corrupt/symlinked config).
 *   (b) hooks.json — strip only OUR SessionStart entry (a callback array-replace), preserving every other hook.
 *       A leftover hook is NOT neutralized by revoking codex.token (it authenticates with the PER-BOOT token),
 *       so removing it is what actually deactivates Codex consumption. Exact-command match on the current
 *       repoRoot: a repo-MOVED leftover points its command at a now-missing script and already fails open (inert).
 *   (c) AGENTS.md — strip our marked block (structural inverse of the upsert; it never went through the journal).
 */
export function uninstallCodex(opts: { home?: string; dataDir?: string; repoRoot?: string } = {}): string[] {
  const home = opts.home ?? homedir();
  const dataDir = resolveDataDir(opts.dataDir);
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const removed: string[] = [];

  // ── (a) MCP server → ~/.codex/config.toml — delete only mcp_servers.agent-os, preserve Codex's live state ──
  const configToml = configTomlPath(home);
  try {
    const res = removeConfigKeys(configToml, [`mcp_servers.${SERVER_NAME}`], { dataDir });
    if (!res.noop) removed.push(configToml);
  } catch (err) {
    // A corrupt / symlinked / unwritable config.toml can't be targeted-removed. The entry lingers, but the
    // codex.token revocation below makes it INERT (it authenticates with codex.token, which we delete).
    console.error(
      `[agent-os] uninstall: could not remove '${SERVER_NAME}' from '${configToml}' — any leftover entry is neutralized by the codex.token revocation below; remove it manually:`,
      err,
    );
  }

  // ── (b) SessionStart hook → ~/.codex/hooks.json — strip only OUR entry, keep every other hook ──
  // Shared uninstall-side stripper: exists-guarded (never CREATE a hooks.json by uninstalling), no-op-gated,
  // per-target try/catch so a diverged/corrupt hooks.json never aborts the AGENTS.md strip or token revocation.
  removed.push(
    ...removeHooksIfPresent(
      hooksJsonPath(home),
      [["SessionStart", bunCommand(repoRoot, "codex-session-start.ts")]],
      { dataDir, errLabel: "could not remove our SessionStart hook from" },
    ),
  );

  // ── (c) Pointer block → ~/.codex/AGENTS.md — structural strip, tolerant of the rest of the file changing ──
  const agentsMd = agentsMdPath(home);
  try {
    if (stripAgentsMdBlock(agentsMd)) removed.push(agentsMd);
  } catch (err) {
    console.error(`[agent-os] uninstall: could not strip pointer block from '${agentsMd}':`, err);
  }

  // ── (d) Revoke the stable Codex credential — delete codex.token so the next boot re-mints fresh ──
  // Revocation is the one security-critical step here — it must not fail silently. rmSync({force}) ignores
  // ENOENT (already gone = success) but can throw on EPERM/EACCES/EISDIR; verify the file is truly gone and
  // FAIL LOUD if not, so a caller never treats a non-revoking uninstall as complete. This runs LAST, on
  // purpose — the (a)/(b)/(c) removals above are independent best-effort cleanups and must still happen even
  // when revocation is about to throw.
  try {
    rmSync(codexTokenPath(dataDir), { force: true });
  } catch (err) {
    console.error(`[agent-os] uninstall: error deleting '${codexTokenPath(dataDir)}':`, err);
  }
  if (existsSync(codexTokenPath(dataDir))) {
    throw new Error(
      `[agent-os] uninstall: FAILED to revoke the Codex credential — '${codexTokenPath(dataDir)}' could not be removed, so the stable token remains LIVE against the gate. Remove it manually, then re-run uninstall.`,
    );
  }

  return removed;
}
