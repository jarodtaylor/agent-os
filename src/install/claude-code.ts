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
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergeConfig, removeConfigKeys, undo, type MergeResult } from "../configwrite/index";
import { resolveDataDir, resolvePort } from "../paths";
import { bunCommand, defaultRepoRoot, existingEntriesWithoutOurs, hooksWithoutOurs, readJson } from "./shared";

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

const claudeDir = (home: string): string => join(home, ".claude");
const settingsPath = (home: string): string => join(claudeDir(home), "settings.json");
const claudeJsonPath = (home: string): string => join(home, ".claude.json");

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
  // Pre-flight-parse BOTH targets before writing EITHER file (fail fast, with a friendly error, on a corrupt
  // existing config): the two mergeConfig writes below are not a cross-file transaction, so a corrupt
  // ~/.claude.json would otherwise throw AFTER settings.json is already mutated (a partial install). Parsing
  // both now makes the pair all-or-nothing on the realistic failure — an unparseable existing config. The
  // parsed values are DISCARDED: the RMW arrays are built inside the callback below from the engine's OWN
  // single read, so a concurrent CC write landing after this pre-flight can't be reverted (the non-atomic
  // double-read is closed — deepMerge REPLACES the arrays, so they must be rebuilt from the read that merges).
  readJson(settingsPath(home));
  readJson(claudeJsonPath(home));
  const settings = mergeConfig(
    settingsPath(home),
    (current: unknown) => {
      const config = current as Record<string, unknown> | undefined;
      return {
        hooks: {
          SessionStart: [
            ...existingEntriesWithoutOurs(config, "SessionStart", startCmd),
            // matcher = the "fresh/reset context" moments (KTD5); a mid-session `compact` is deliberately excluded.
            { matcher: "startup|resume|clear", hooks: [{ type: "command", command: startCmd, timeout: HOOK_TIMEOUT_S }] },
          ],
          SessionEnd: [
            ...existingEntriesWithoutOurs(config, "SessionEnd", endCmd),
            // no matcher ⇒ every end reason marks a graceful end (the point is "not a crash", whatever the reason).
            { hooks: [{ type: "command", command: endCmd, timeout: HOOK_TIMEOUT_S }] },
          ],
        },
      };
    },
    { dataDir },
  );

  // ── MCP server → ~/.claude.json ──────────────────────────────────────────────────────────────────────
  // deepMerge preserves OTHER servers (object-key merge), so no read-modify-write of `mcpServers` is needed.
  // `replaceSubtrees` wholesale-replaces the OWNED `mcpServers.agent-os` subtree instead of re-merging it, so a
  // PRE-EXISTING agent-os entry carrying a stale key we no longer write — a static `headers` embedding a token,
  // say — cannot survive the merge (Codex gate #1). Unreachable on the supported path (U6 only ever writes
  // `headersHelper`, never a static `headers`), but real for a hand-edited/foreign entry; the replace stays
  // idempotent (reproducing the same bytes ⇒ the engine no-ops on re-install).
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
    mcp = mergeConfig(claudeJsonPath(home), mcpPatch, { dataDir, replaceSubtrees: [`mcpServers.${SERVER_NAME}`] });
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
 * Reverse the install by TARGETED removal of only what we added — the correct reversal for configs a FOREIGN
 * process co-owns and rewrites continuously. CROSS-PROCESS by design: nothing here depends on install-time
 * journal state; it removes our keys from whatever is on disk NOW, so `agent-os uninstall` runs days later in a
 * fresh process. Returns the paths actually changed.
 *
 * Why not the whole-file `undo` restore this used to do: `~/.claude.json` is Claude Code's live-state file
 * (`numStartups`, `projects`, …), so by uninstall time it has almost always diverged from what install wrote —
 * the identity-checked `undo` would THROW rather than clobber it, leaving `mcpServers.agent-os` behind, and a
 * forced restore would wipe CC's accumulated state. Instead we delete ONLY our `mcpServers.agent-os` object key
 * (`removeConfigKeys`) and strip ONLY our own entries from the settings.json hook arrays (a callback
 * array-replace against the engine's own read), preserving everything else on both files however they've
 * diverged. Idempotent — our keys already absent ⇒ each write no-ops — and per-target try/catch so a
 * diverged/corrupt target never aborts removal of the other.
 */
export function uninstallClaudeCode(opts: { home?: string; dataDir?: string; repoRoot?: string } = {}): string[] {
  const home = opts.home ?? homedir();
  const dataDir = resolveDataDir(opts.dataDir);
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const removed: string[] = [];

  // ── Hooks → ~/.claude/settings.json — strip only OUR SessionStart/SessionEnd entries, keep the user's ──
  // Only when the file exists: mergeConfig would otherwise CREATE it, and uninstall must never write a
  // settings.json that never existed. `hooksWithoutOurs` yields an empty (no-op) patch when nothing is ours.
  const settings = settingsPath(home);
  if (existsSync(settings)) {
    try {
      const res = mergeConfig(
        settings,
        (current: unknown) =>
          hooksWithoutOurs(current, [
            ["SessionStart", bunCommand(repoRoot, "session-start.ts")],
            ["SessionEnd", bunCommand(repoRoot, "session-end.ts")],
          ]),
        { dataDir },
      );
      if (!res.noop) removed.push(settings);
    } catch (err) {
      console.error(`[agent-os] uninstall: could not remove our hooks from '${settings}':`, err);
    }
  }

  // ── MCP server → ~/.claude.json — delete only mcpServers.agent-os, preserving CC's live state ──
  const claudeJson = claudeJsonPath(home);
  try {
    const res = removeConfigKeys(claudeJson, [`mcpServers.${SERVER_NAME}`], { dataDir });
    if (!res.noop) removed.push(claudeJson);
  } catch (err) {
    console.error(`[agent-os] uninstall: could not remove '${SERVER_NAME}' from '${claudeJson}':`, err);
  }

  return removed;
}
