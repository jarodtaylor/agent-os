/**
 * Claude Code installer (U6) — registers Agent OS's two hooks in `~/.claude/settings.json` and the brain
 * MCP server in `~/.claude.json` (the "two files by design" split: KTD5 hooks vs. KTD1 MCP registration).
 * EVERY write goes through the U14 config-write engine (backup-first, atomic, journaled undo) because these
 * are Jarod's LIVE daily-driver configs (R11 / KTD6).
 *
 * The load-bearing subtlety: U14's `deepMerge` REPLACES arrays (patch wins), so a naive
 * `{hooks:{SessionStart:[ours]}}` patch would DROP Jarod's existing hooks. We therefore read-modify-write
 * the whole SessionStart/SessionEnd arrays — every existing entry that isn't ours, plus our fresh entry —
 * and pass the combined arrays as the patch. Stripping our own prior entry first makes re-install idempotent
 * (identical bytes ⇒ the engine no-ops). The MCP registration is an object key (`mcpServers.agent-os`), which
 * `deepMerge` merges safely without clobbering other servers, so it needs no read-modify-write.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listUndo, mergeConfig, undo, type MergeResult } from "../configwrite/index";
import { resolveDataDir, resolvePort } from "../paths";

/** The brain's MCP server name in `~/.claude.json` (mirrors the Codex `[mcp_servers.agent-os]` plan). */
const SERVER_NAME = "agent-os";
/** Per-hook timeout (seconds) written into the settings entries — well above the hooks' own ~1.5s
 *  self-limit, but far below CC's 600s default, so a wedged hook can't stall session start/teardown. */
const HOOK_TIMEOUT_S = 10;

export interface InstallOptions {
  /** Home dir whose `~/.claude/settings.json` + `~/.claude.json` are written. Defaults to `os.homedir()`;
   *  tests inject a temp dir so they never touch the real setup. */
  home?: string;
  /** Absolute repo root the installed hook commands point at. Defaults to this module's own repo. */
  repoRoot?: string;
  /** Data dir for the engine's backups + undo journal. Defaults to the OS data dir; tests inject a temp dir. */
  dataDir?: string;
  /** Loopback port baked into the MCP `url`. Defaults to `resolvePort()` (what the server binds). */
  port?: number;
}

export interface InstallResult {
  /** The `~/.claude/settings.json` hook-registration write. */
  settings: MergeResult;
  /** The `~/.claude.json` MCP-registration write. */
  mcp: MergeResult;
}

/** This repo's root: `src/install/claude-code.ts` → `../..`. */
function defaultRepoRoot(): string {
  return join(import.meta.dir, "..", "..");
}

const claudeDir = (home: string): string => join(home, ".claude");
const settingsPath = (home: string): string => join(claudeDir(home), "settings.json");
const claudeJsonPath = (home: string): string => join(home, ".claude.json");

/** The shell command CC runs for a hook / headers-helper: `bun run "<abs script>"` (quoted so a repo path
 *  containing spaces still executes as one argument). */
function bunCommand(repoRoot: string, script: string): string {
  return `bun run "${join(repoRoot, "hooks", script)}"`;
}

/** True iff a settings hook ENTRY already references our exact command — used to strip a prior install of
 *  ours before re-adding it, so re-install replaces (never duplicates). Exact-match avoids false positives
 *  against an unrelated user hook; a moved repo simply leaves its now-dead entry (fails open, harmless). */
function referencesCommand(entry: unknown, command: string): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some((h) => (h as { command?: unknown })?.command === command);
}

/** Parse a JSON config file; `undefined` when absent. Throws on corrupt JSON — never merge into a config we
 *  can't parse (mirrors the engine's own fail-closed parse). */
function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`install: existing '${path}' is not valid JSON — fix or remove it before installing`);
  }
}

/** The existing `hooks.<event>` entries with OUR entry (by `command`) stripped, so the caller can append a
 *  fresh one and re-install stays idempotent. Non-array / missing → []. */
function existingEntriesWithoutOurs(
  config: Record<string, unknown> | undefined,
  event: string,
  ourCommand: string,
): unknown[] {
  const hooks = (config?.hooks as Record<string, unknown> | undefined) ?? {};
  const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  return arr.filter((entry) => !referencesCommand(entry, ourCommand));
}

/**
 * Register the hooks + MCP server. Idempotent: a second run with the same inputs re-derives identical bytes,
 * so the engine no-ops (no new backup, no journal noise). Returns both engine results (created / no-op /
 * undoId / backup path).
 */
export function installClaudeCode(opts: InstallOptions = {}): InstallResult {
  const home = opts.home ?? homedir();
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const dataDir = resolveDataDir(opts.dataDir);
  const port = opts.port ?? resolvePort();

  // Ensure CC's config dir exists so settings.json's atomic write has a home on a fresh machine. mode:0700
  // applies ONLY when this CREATES it (owner-only, a safe default); we deliberately do NOT chmod an existing
  // ~/.claude — it is Claude Code's dir to own, and tightening a live daily-driver dir is not ours to do.
  mkdirSync(claudeDir(home), { recursive: true, mode: 0o700 });

  // ── Hooks → ~/.claude/settings.json — read-modify-write the arrays (deepMerge would REPLACE them) ──────
  const startCmd = bunCommand(repoRoot, "session-start.ts");
  const endCmd = bunCommand(repoRoot, "session-end.ts");
  const current = readJson(settingsPath(home));
  // Pre-flight the SECOND target too, before writing EITHER file: the two mergeConfig writes below are not a
  // cross-file transaction, so a corrupt ~/.claude.json would otherwise throw AFTER settings.json is already
  // mutated (a partial install). Parsing it now makes the pair all-or-nothing on the realistic failure — an
  // unparseable existing config. mergeConfig re-reads it authoritatively for the actual merge.
  readJson(claudeJsonPath(home));
  const sessionStart = [
    ...existingEntriesWithoutOurs(current, "SessionStart", startCmd),
    // matcher = the "fresh/reset context" moments (KTD5); a mid-session `compact` is deliberately excluded.
    { matcher: "startup|resume|clear", hooks: [{ type: "command", command: startCmd, timeout: HOOK_TIMEOUT_S }] },
  ];
  const sessionEnd = [
    ...existingEntriesWithoutOurs(current, "SessionEnd", endCmd),
    // no matcher ⇒ every end reason marks a graceful end (the point is "not a crash", whatever the reason).
    { hooks: [{ type: "command", command: endCmd, timeout: HOOK_TIMEOUT_S }] },
  ];
  const settings = mergeConfig(
    settingsPath(home),
    { hooks: { SessionStart: sessionStart, SessionEnd: sessionEnd } },
    { dataDir },
  );

  // ── MCP server → ~/.claude.json ──────────────────────────────────────────────────────────────────────
  // deepMerge preserves OTHER servers (object-key merge), so no read-modify-write of `mcpServers` is needed.
  // KNOWN LIMITATION (tracked follow-up): merge also RE-MERGES the agent-os subtree rather than replacing it,
  // so a PRE-EXISTING agent-os entry carrying a static `headers` (embedded token) would keep it. Unreachable
  // on the supported path — U6 only ever writes `headersHelper`, never a static `headers` key, so nothing
  // Agent OS produces embeds a token; only a hand-edited or foreign-tool entry could. The wholesale-replace
  // fix shares the U14 key-removal/replace primitive the deferred targeted-uninstall needs.
  //
  // Cross-file transactionality: the settings write above is now LIVE. If this MCP write fails (symlink
  // target, unwritable, a journal error — anything the pre-flight parse couldn't foresee), roll the settings
  // write back so a failed install never leaves the hooks live without the MCP server (all-or-nothing across
  // both Claude surfaces). Best-effort rollback; the ORIGINAL error is what propagates.
  const mcpPatch = {
    mcpServers: {
      [SERVER_NAME]: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        // headersHelper runs fresh per connection and reads the per-boot token file at call time (KTD6) —
        // the token is never embedded in this static config. See hooks/mcp-headers.ts.
        headersHelper: bunCommand(repoRoot, "mcp-headers.ts"),
      },
    },
  };
  let mcp: MergeResult;
  try {
    mcp = mergeConfig(claudeJsonPath(home), mcpPatch, { dataDir });
  } catch (err) {
    if (settings.undoId) {
      try {
        undo(settings.undoId, dataDir);
      } catch {
        // Rollback is best-effort — never mask the original MCP-write failure that we're propagating.
      }
    }
    throw err;
  }

  return { settings, mcp };
}

/**
 * Reverse the install by restoring each target from the U14 undo journal — CROSS-PROCESS by design (reads the
 * on-disk journal, finds the most-recent mutation of each target, and undoes it), so `agent-os uninstall` can
 * run days later in a fresh process. Returns the paths actually restored.
 *
 * KNOWN LIMITATION (tracked follow-up): undo is a byte-exact WHOLE-FILE restore, identity-checked so it THROWS
 * rather than clobber a file changed since install. `~/.claude/settings.json` is relatively static, so its undo
 * usually succeeds; but `~/.claude.json` is Claude Code's continuously-rewritten live-state file, so it has
 * almost always diverged by uninstall time and its undo is SKIPPED — leaving the (harmless) `mcpServers.agent-os`
 * entry behind. The correct reversal is TARGETED removal (delete only what we added, preserving CC's live state),
 * which needs a U14 key-removal primitive that does not exist yet — deferred. Per-target try/catch here ensures
 * a skipped/diverged target never aborts the loop (which would otherwise leave BOTH files unrestored).
 */
export function uninstallClaudeCode(opts: { home?: string; dataDir?: string } = {}): string[] {
  const home = opts.home ?? homedir();
  const dataDir = resolveDataDir(opts.dataDir);
  const entries = listUndo(dataDir);
  const restored: string[] = [];
  for (const target of [claudeJsonPath(home), settingsPath(home)]) {
    const entry = entries.findLast((e) => e.targetPath === target);
    if (!entry) continue;
    try {
      undo(entry.id, dataDir);
      restored.push(target);
    } catch (err) {
      // Diverged since install (identity check) or otherwise unrestorable — skip it, keep the loop going so
      // the other target is still restored. See the KNOWN LIMITATION above (targeted-removal follow-up).
      console.error(`[agent-os] uninstall: could not restore '${target}' (changed since install?):`, err);
    }
  }
  return restored;
}
