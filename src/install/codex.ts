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
 *       one intentional narrowing of "installed config never embeds the token" (U8 decision A;
 *       config.toml is 0600). `[hooks.state]` is untouched — our patch never mentions `hooks`, and
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
 * never leaves a partial Codex configuration.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { listUndo, mergeConfig, undo, type MergeResult } from "../configwrite/index";
import { resolveCodexToken, resolveDataDir, resolvePort, TOKEN_HEADER } from "../paths";
import { bunCommand, defaultRepoRoot, existingEntriesWithoutOurs, readJson } from "./shared";

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
    } catch {
      // Best-effort — the original error is what propagates.
    }
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
  writeFileSync(path, after);
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
    writeFileSync(path, stripped.replace(/\s+$/, "\n"));
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

  // Ensure ~/.codex exists so the atomic writes below have a home on a fresh machine. mode:0700 applies ONLY
  // when this CREATES it (owner-only, a safe default); an EXISTING ~/.codex is deliberately left alone — it's
  // Codex's dir to own, not ours to tighten (same reasoning as the CC installer's ~/.claude).
  mkdirSync(codexDir(home), { recursive: true, mode: 0o700 });

  // Pre-flight-parse BOTH structured targets before writing EITHER: the two mergeConfig writes below are not
  // a cross-file transaction, so a corrupt hooks.json would otherwise throw AFTER config.toml is already
  // mutated (a partial install). AGENTS.md is plain text — no "corrupt" state to pre-empt.
  readToml(configTomlPath(home)); // parsed only to fail fast; mergeConfig re-reads it authoritatively below
  const currentHooks = readJson(hooksJsonPath(home));

  // ── (a) MCP server → ~/.codex/config.toml ────────────────────────────────────────────────────────────
  // Object-key merge (mcp_servers.agent-os) — deepMerge preserves every OTHER server, so no read-modify-
  // write is needed here (same reasoning as the CC installer's ~/.claude.json MCP write).
  const config = mergeConfig(
    configTomlPath(home),
    {
      mcp_servers: {
        [SERVER_NAME]: {
          url: `http://127.0.0.1:${port}/mcp`,
          // The STABLE Codex credential (U8 decision A): Codex's HTTP-MCP client sends only a static
          // header, so — unlike CC's per-call headersHelper — the token IS embedded here, in this 0600
          // config, mirroring how the existing `uidotsh` entry embeds its own bearer token.
          http_headers: { [TOKEN_HEADER]: resolveCodexToken(dataDir) },
        },
      },
    },
    { dataDir },
  );

  // ── (b) SessionStart hook → ~/.codex/hooks.json ──────────────────────────────────────────────────────
  // Read-modify-write the WHOLE array (deepMerge would REPLACE it): strip our own prior entry, append ours,
  // keep every other existing entry (Jarod's herdr hook + codebase-memory echo hook must survive).
  const startCmd = bunCommand(repoRoot, "codex-session-start.ts");
  const sessionStart = [
    ...existingEntriesWithoutOurs(currentHooks, "SessionStart", startCmd),
    // Same matcher as the pre-existing codebase-memory echo hook — the "fresh/reset context" moments.
    { matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: startCmd, timeout: HOOK_TIMEOUT_S }] },
  ];
  let hooks: MergeResult;
  try {
    hooks = mergeConfig(hooksJsonPath(home), { hooks: { SessionStart: sessionStart } }, { dataDir });
  } catch (err) {
    // config.toml is now LIVE. Roll it back so a failed install never leaves the MCP server registered
    // without the hook (all-or-nothing across both structured targets).
    rollback([config], dataDir);
    throw err;
  }

  // ── (c) Pointer block → ~/.codex/AGENTS.md — LAST (most reversible: a structural strip, not a restore) ──
  let agentsMd: AgentsMdResult;
  try {
    agentsMd = upsertAgentsMdBlock(agentsMdPath(home), repoRoot);
  } catch (err) {
    rollback([config, hooks], dataDir);
    throw err;
  }

  return { config, hooks, agentsMd };
}

/**
 * Reverse the install: restore config.toml + hooks.json from the U14 undo journal (cross-process by design,
 * mirrors `uninstallClaudeCode`), and strip the AGENTS.md marked block. Per-target try/catch so one diverged
 * target never aborts the others. Returns the paths actually restored/cleaned.
 *
 * KNOWN LIMITATION (shared with uninstallClaudeCode): undo is a byte-exact WHOLE-FILE restore, identity-
 * checked so it THROWS rather than clobber a file changed since install. `~/.codex/config.toml` is Codex's
 * own continuously-rewritten live-state file (model/approval settings, trust hashes, plugin state), so its
 * undo has a real chance of being SKIPPED by uninstall time — leaving the (harmless) `mcp_servers.agent-os`
 * entry behind. The correct reversal is TARGETED removal, deferred pending the same U14 key-removal primitive
 * `uninstallClaudeCode` is waiting on.
 */
export function uninstallCodex(opts: { home?: string; dataDir?: string } = {}): string[] {
  const home = opts.home ?? homedir();
  const dataDir = resolveDataDir(opts.dataDir);
  const entries = listUndo(dataDir);
  const restored: string[] = [];

  for (const target of [configTomlPath(home), hooksJsonPath(home)]) {
    const entry = entries.findLast((e) => e.targetPath === target);
    if (!entry) continue;
    try {
      undo(entry.id, dataDir);
      restored.push(target);
    } catch (err) {
      // Diverged since install (identity check) or otherwise unrestorable — skip it, keep the loop going.
      console.error(`[agent-os] uninstall: could not restore '${target}' (changed since install?):`, err);
    }
  }

  // AGENTS.md never went through the undo journal — its reversal is the structural inverse of the upsert,
  // which tolerates the rest of the file having changed since install (unlike the journal's identity check).
  const agentsMd = agentsMdPath(home);
  try {
    if (stripAgentsMdBlock(agentsMd)) restored.push(agentsMd);
  } catch (err) {
    console.error(`[agent-os] uninstall: could not strip pointer block from '${agentsMd}':`, err);
  }

  return restored;
}
