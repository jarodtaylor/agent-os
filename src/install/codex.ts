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
 *       The STABLE Codex credential IS embedded here (unlike Claude Code's per-call headersHelper):
 *       Codex's HTTP-MCP client can only send a static header, so this is the one intentional narrowing
 *       of "installed config never embeds the token" (U8 decision A; the write passes the engine's
 *       `targetMode: 0o600` so the token-bearing config is PUBLISHED owner-only — the engine otherwise
 *       preserves a pre-existing file's mode). Since issue #24 this entry is the credential's ONLY home:
 *       the gate reads the token straight back out of this file (`codex-credential.ts`), so there is no
 *       second copy to keep in sync — the class of lifecycle races that cost U8 five gate passes is gone.
 *       `[hooks.state]` is untouched — our patch never mentions `hooks`, and Codex owns its own
 *       hook-trust hashing there.
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
 * never leaves a partial Codex configuration. Rolling back the config.toml write now also revokes the
 * credential FOR FREE, because the credential IS that entry (issue #24): there is no separate token file
 * left behind to strand, so the whole mint-provenance/revoke-on-failure apparatus U8 needed is deleted.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CODEX_SERVER_NAME as SERVER_NAME, codexConfigPath, extractCodexToken, readCodexToken } from "../codex-credential";
import { mergeConfig, undo, type MergeResult } from "../configwrite/index";
import { resolveDataDir, resolvePort, TOKEN_HEADER } from "../paths";
import { bunCommand, defaultRepoRoot, errorText, existingEntriesWithoutOurs, readJson, removeHooksIfPresent, removeKeysIfPresent, type UninstallOutcome } from "./shared";
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
  /** Data dir for the engine's backups + undo journal. Defaults to the OS data dir; tests inject a temp dir. */
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
// config.toml's path comes from `codex-credential.ts`, NOT a local copy: it is where the credential lives, so
// the installer that writes it, the gate that reads it, and the uninstaller that strips it must agree on one
// definition (a local duplicate is exactly the second-source mistake this issue exists to remove). Wrapped
// (not aliased directly) so `home` stays REQUIRED like its siblings below — `codexConfigPath`'s param is
// optional for the server's bare production call, and a bare `configTomlPath()` slip here would silently
// resolve to the real ~/.codex instead of a test's fixture home.
const configTomlPath = (home: string): string => codexConfigPath(home);
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
  // Atomic write (mirrors the engine's temp+rename): a mid-write fault must never corrupt
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
  const existingConfig = readToml(configTomlPath(home)); // fail-fast on corrupt TOML; mergeConfig re-reads authoritatively below
  readJson(hooksJsonPath(home)); // pre-flight fail-fast; the hooks RMW array is built from the engine's OWN read below

  // REUSE the credential already embedded in config.toml; mint only when there isn't one (fresh install, or a
  // prior entry carrying no/blank header). Minting unconditionally would rotate the token on EVERY re-install —
  // rewriting the config, breaking the idempotent-no-op contract below, and cutting off a live Codex session
  // mid-flight. This read is the entire replacement for U8's mint/persist/provenance machinery: the credential's
  // one location is also the place we check before minting, so "did a token already exist?" has a single answer.
  const token = extractCodexToken(existingConfig) ?? randomUUID();

  // ── (a) MCP server → ~/.codex/config.toml ────────────────────────────────────────────────────────────
  // Object-key merge (mcp_servers.agent-os) — deepMerge preserves every OTHER server, so no read-modify-write
  // is needed here (same reasoning as the CC installer's ~/.claude.json MCP write). `replaceSubtrees` wholesale-
  // replaces the OWNED mcp_servers.agent-os subtree instead of re-merging it, so a stale key on a pre-existing
  // entry — an old header field we no longer write, say — cannot survive (idempotent: reusing the already-
  // embedded token, above, means a re-install reproduces identical bytes ⇒ the engine no-ops).
  const config = mergeConfig(
    configTomlPath(home),
    {
      mcp_servers: {
        [SERVER_NAME]: {
          url: `http://127.0.0.1:${port}/mcp`,
          // The STABLE Codex credential (U8 decision A): Codex's HTTP-MCP client sends only a static
          // header, so — unlike CC's per-call headersHelper — the token IS embedded here, in this config
          // (published owner-only 0600 via the engine's targetMode below), like the existing `uidotsh` bearer.
          // This entry is now the credential's SOLE home — the gate reads it back from these very bytes.
          http_headers: { [TOKEN_HEADER]: token },
        },
      },
    },
    // targetMode 0600: this file embeds the bearer token, so publish it owner-only — never rename it into place
    // at a pre-existing looser mode and tighten afterwards (that leaves a world-readable window a local observer
    // could catch). The engine journals the original mode, but a targeted uninstall deliberately never loosens it
    // back — a file tightened here STAYS 0600 after removal (keeps 0600 by design — see uninstallCodex; issue #33).
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
    // without the hook (all-or-nothing across both structured targets). Rolling back the entry IS the
    // credential revocation now — a freshly minted token existed only inside it, so nothing is stranded
    // and no "did we mint it?" provenance has to be tracked to avoid clobbering a prior install's token.
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
 * Reverse the install by TARGETED removal of only what we added — the correct reversal for the configs Codex
 * co-owns and rewrites continuously. CROSS-PROCESS by design (nothing depends on install-time journal state; it
 * removes our keys from whatever is on disk NOW), mirroring `uninstallClaudeCode`. Per-target try/catch so one
 * diverged/corrupt target never aborts the others. Returns an `UninstallOutcome`: the paths actually changed,
 * plus any per-target failures — so a caller can tell "nothing to remove" from "a target could not be cleaned".
 *
 * **Revocation INVERTED with issue #24 — read this before touching (a) or (d).** U8 revoked by deleting a
 * separate `codex.token`, which made removal (a) merely cosmetic: a leftover `mcp_servers.agent-os` entry was
 * already INERT because the gate's credential lived elsewhere. Now the entry *is* the credential, so (a) is the
 * revocation and there is NO second file backstopping it. Two consequences, both enforced in (d):
 *   - a config.toml strip that FAILS must fail the whole call LOUDLY — it is a live credential left behind;
 *   - success is verified against the credential itself, not against the removal mechanism reporting OK.
 * A (b)/(c) failure still reports through `failed` — a leftover hook or pointer grants no access.
 *
 * Three targeted removals, each tolerant of a target that diverged since install (the whole point — the old
 * whole-file `undo` restore THREW on the near-always-diverged live-state files and left our entries behind):
 *   (a) config.toml — delete only `mcp_servers.agent-os` (removeConfigKeys), which REVOKES the credential. This
 *       is what the byte-exact undo couldn't do: config.toml is Codex's live-state file (model/approval
 *       settings, trust hashes), so its identity-checked undo was near-always SKIPPED; removeConfigKeys deletes
 *       our key from the live file whatever else changed.
 *   (b) hooks.json — strip only OUR SessionStart entry (a callback array-replace), preserving every other hook.
 *       A leftover hook grants nothing (it authenticates with the PER-BOOT token), but removing it is what
 *       actually deactivates Codex consumption. Exact-command match on the current repoRoot: a repo-MOVED
 *       leftover points its command at a now-missing script and already fails open (inert).
 *   (c) AGENTS.md — strip our marked block (structural inverse of the upsert; it never went through the journal).
 *   (c2) legacy `codex.token` — delete any pre-#24 credential file this unit orphaned, so uninstalling after an
 *        upgrade from U8 fully revokes even against a still-running pre-#24 gate that reads it live.
 *   (d) VERIFY the credential is gone — the security-critical post-condition, run LAST so (a)–(c2) all happen
 *       even when it is about to throw.
 */
export function uninstallCodex(opts: { home?: string; dataDir?: string; repoRoot?: string } = {}): UninstallOutcome {
  const home = opts.home ?? homedir();
  const dataDir = resolveDataDir(opts.dataDir);
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const removed: string[] = [];
  const failed: UninstallOutcome["failed"] = [];
  const warnings: UninstallOutcome["warnings"] = [];

  // ── (a) MCP server → ~/.codex/config.toml — delete only mcp_servers.agent-os. THIS IS THE REVOCATION. ──
  // Shared uninstall-side key stripper (same single-read presence semantics + per-target isolation as the CC
  // installer's claude.json removal). config.toml was PUBLISHED 0600 at install (it embeds the token) and the
  // targeted removeConfigKeys preserves the file's CURRENT mode, so it STAYS 0600 after removal — we deliberately
  // never loosen it back. A secret added to the file while Agent OS held it at 0600 would be exposed by widening
  // the mode on uninstall, so tightening is never autonomously reversed (keeps 0600 by design; full mode-lifecycle
  // restoration: issue #33). A corrupt/symlinked config.toml that can't be stripped lands in `failed` — and since
  // #24 that is a LIVE CREDENTIAL left behind, which (d) escalates from a report into a throw.
  const configOutcome = removeKeysIfPresent(configTomlPath(home), [`mcp_servers.${SERVER_NAME}`], {
    dataDir,
    errLabel: SERVER_NAME,
    failedSuffix: " — this entry EMBEDS the Codex credential, so it is still live; remove it manually",
  });
  removed.push(...configOutcome.removed);
  failed.push(...configOutcome.failed);
  warnings.push(...configOutcome.warnings);

  // ── (b) SessionStart hook → ~/.codex/hooks.json — strip only OUR entry, keep every other hook ──
  // Shared uninstall-side stripper. The engine's SINGLE read drives everything: an absent or already-clean
  // hooks.json makes the callback abstain (MERGE_NOOP), so nothing is created or written; per-target isolation
  // means a diverged/corrupt hooks.json is reported in `failed`, never aborts the AGENTS.md strip or token revocation.
  const hooksOutcome = removeHooksIfPresent(
    hooksJsonPath(home),
    [["SessionStart", bunCommand(repoRoot, "codex-session-start.ts")]],
    { dataDir, errLabel: "could not remove our SessionStart hook from" },
  );
  removed.push(...hooksOutcome.removed);
  failed.push(...hooksOutcome.failed);
  warnings.push(...hooksOutcome.warnings);

  // ── (c) Pointer block → ~/.codex/AGENTS.md — structural strip, tolerant of the rest of the file changing ──
  // NOTE: `stripAgentsMdBlock` writes directly (no U14 engine, no journal), so it can never raise
  // AppliedButUnjournaledError — its catch stays a plain `failed` classifier, unlike the engine-backed (a)/(b).
  const agentsMd = agentsMdPath(home);
  try {
    if (stripAgentsMdBlock(agentsMd)) removed.push(agentsMd);
  } catch (err) {
    console.error(`[agent-os] uninstall: could not strip pointer block from '${agentsMd}':`, err);
    failed.push({ path: agentsMd, error: errorText(err) });
  }

  // ── (c2) Legacy migration — remove any pre-#24 `codex.token` this unit orphaned ──
  // U8 kept a SECOND copy of the credential in `dataDir/codex.token`, read DIRECTLY by the gate. #24 deleted
  // that path, so a fresh install never writes it again — but uninstalling AFTER upgrading from a pre-#24
  // install would otherwise leave the old file on disk, where a STILL-RUNNING pre-#24 gate (which reads it
  // live per request) keeps honoring the "revoked" credential until restart. Remove it so the upgrade path
  // fully revokes. A survivor is escalated to the loud (d) throw below — it is a credential file a stale gate
  // reads, and "revocation must fail loud" is the #24 inversion. Path inlined (not via a helper) precisely
  // because this file is legacy: nothing in the #24 world should reference it as a live credential source.
  const legacyTokenPath = join(dataDir, "codex.token");
  let legacyTokenSurvives = false;
  if (existsSync(legacyTokenPath)) {
    try {
      rmSync(legacyTokenPath, { force: true });
    } catch (err) {
      console.error(`[agent-os] uninstall: error deleting legacy '${legacyTokenPath}':`, err);
    }
    if (existsSync(legacyTokenPath)) legacyTokenSurvives = true;
    else removed.push(legacyTokenPath);
  }

  // ── (d) VERIFY revocation — the security-critical post-condition, checked at every credential surface ──
  // Runs LAST on purpose: (a)/(b)/(c)/(c2) are independent cleanups that must all happen even when this throws.
  //
  // 1. Did the strip itself fail? Then our entry — which EMBEDS the credential — is still in the file. We must
  //    not return normally: unlike U8, no `rm codex.token` follows to neutralize it. Note this case is NOT
  //    covered by check 2: a strip usually fails because the file is unparseable, and an unparseable config
  //    reads back as "no token" — inert TODAY, but live again the moment the operator repairs the syntax. So
  //    the mechanism failing is its own escalation, independent of what the credential reads as right now.
  if (configOutcome.failed.length > 0) {
    // Surface the underlying cause(s) the strip already computed — a bare "could not remove" strands a
    // programmatic caller (the realistic consumer of a thrown exception, vs. a human watching the stderr
    // `console.error` one frame up) with no idea WHY. Safe to interpolate: `failed[].error` is `errorText`
    // of the engine's own error, whose corrupt-TOML message carries only a LOCATION (`parseLocation` uses the
    // parser's numeric line/column, never its source-frame message — see configwrite/engine.ts), so it can't
    // leak an adjacent MCP server's bearer token from the same file. A test asserts the message stays
    // token-free.
    const causes = configOutcome.failed.map((f) => f.error).join("; ");
    throw new Error(
      `[agent-os] uninstall: FAILED to revoke the Codex credential — could not remove 'mcp_servers.${SERVER_NAME}' from '${configTomlPath(home)}', which embeds the stable token (${causes}). Remove that entry manually, then re-run uninstall.`,
    );
  }
  // 1b. Did a legacy pre-#24 `codex.token` survive cleanup (c2)? A still-running pre-#24 gate reads that file
  //     live, so a survivor is an un-revoked credential on the upgrade path — fail loud, same class as a failed
  //     config strip. The common case (no such file — every #24 install) skips (c2) entirely and never reaches this.
  if (legacyTokenSurvives) {
    throw new Error(
      `[agent-os] uninstall: FAILED to revoke the Codex credential — the legacy '${legacyTokenPath}' could not be removed, so a pre-#24 gate would keep honoring it. Remove it manually, then re-run uninstall.`,
    );
  }
  // 2. Is a usable credential still readable? Asked with `readCodexToken` — the SAME reader the security gate
  //    consults — so success is verified against the property that actually matters ("the gate will accept
  //    nothing from this file") instead of trusting the removal to have done what it reported.
  //    HONEST NOTE: given check 1, no currently reachable path satisfies this — a strip that reports success
  //    really has removed the key. It is kept as a cheap post-condition on a security-critical operation: it
  //    costs one read, and it is the assertion that would catch a future engine change whose "removed" no
  //    longer means what it means today. Deliberately unreached, not dead.
  if (readCodexToken(configTomlPath(home)) !== null) {
    throw new Error(
      `[agent-os] uninstall: FAILED to revoke the Codex credential — a token is STILL readable from '${configTomlPath(home)}' after removal, so it remains LIVE against the gate. Remove 'mcp_servers.${SERVER_NAME}' manually, then re-run uninstall.`,
    );
  }

  return { removed, failed, warnings };
}
