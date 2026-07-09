---
title: Building config installers/deprovisioners on the U14 config-write engine
date: 2026-07-08
last_updated: 2026-07-08
category: docs/solutions/design-patterns
module: install/config-write engine
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - Building an installer/provisioner that writes a shared config file through the U14 config-write engine (mergeConfig)
  - You need to REMOVE or REPLACE what you wrote (uninstall, deprovision, or clean a stale key), not just add it
  - The target config is one a foreign process also owns and rewrites continuously (e.g. Claude Code's ~/.claude.json)
  - You write more than one config file in a single logical install and want all-or-nothing across them
tags: [config-write, deepmerge, installer, uninstall, idempotent, read-modify-write, headers-helper, fail-open, claude-code]
related_components: [install, configwrite, hooks, server]
---

# Building config installers/deprovisioners on the U14 config-write engine

## Context
U6 built Agent OS's first real installer — registering Claude Code's hooks in `~/.claude/settings.json` and the brain MCP server in `~/.claude.json` — on top of the U14 config-write engine (`src/configwrite/engine.ts`: `mergeConfig` → `deepMerge` → backup → atomic write → `undo` journal; decision #16, KTD6). The engine's contract is backup-first, atomic, **merge-don't-clobber** writes to the user's LIVE daily-driver configs. Building a *correct* installer on it surfaced one load-bearing asymmetry and one real gap that every future consumer (U8 Codex installer, U10 provisioning) will hit. The durable question this answers: **what does a correct install/uninstall look like on this engine, and where does the engine stop short?**

## Guidance

**1. `deepMerge`'s asymmetry is the thing to internalize: objects RECURSE, arrays + scalars REPLACE (patch wins).**
- **Array-valued config sections need caller-side read-modify-write.** Claude Code's `hooks.SessionStart` / `hooks.SessionEnd` are arrays. A naive `{hooks:{SessionStart:[ours]}}` patch REPLACES the whole array → **silently drops the user's existing hooks**. Instead: read the current array, strip *your own* prior entry (dedupe by exact command string, so re-install is idempotent — identical bytes ⇒ the engine no-ops), append your fresh entry, and pass the WHOLE combined array as the patch.
- **Object-keyed sections merge safely — no RMW.** `mcpServers.<name>` is an object key; `deepMerge` preserves sibling servers automatically.

**2. The gap: `deepMerge` can neither REMOVE a key nor REPLACE a subtree — it always re-merges matching object keys.** This bites two ways:
- **Uninstall / deregistration.** You cannot delete `mcpServers.agent-os` via a merge. And whole-file backup-restore (`undo`) is the WRONG reversal for a config you only PARTIALLY own that a foreign process rewrites continuously: `~/.claude.json` is Claude Code's live-state file (`numStartups`, `projects`, …), so by uninstall time it has almost always diverged from what install wrote. `undo` is identity-checked → it *throws* on the diverged file; even a forced restore would **wipe the owner's accumulated state**. The correct reversal is **targeted removal** — delete only the keys/entries you added, preserving everything else.
- **Stale-key cleanup on install.** A PRE-EXISTING entry carrying a key you no longer write — e.g. a static `headers` embedding a token, when you now write only a `headersHelper` — SURVIVES the merge, because the merge re-merges the `agent-os` subtree rather than replacing it. Fixing needs the same wholesale-replace primitive.
- → **Deferred follow-up:** add a U14 `removeConfigKeys` / replace-subtree primitive (+ a callback-style patch `(current) => patch` so a read-modify-write happens against the engine's OWN single read, closing the installer's non-atomic double-read). Until then: whole-file `undo` in a per-target `try/catch` (a diverged target is skipped, never aborts the loop), with the limitation documented at the call site.

**3. The engine gives PER-FILE safety, not cross-file transactionality.** If one logical install writes two files, a failure on the second (symlink target, unwritable, journal error) leaves the FIRST file's changes live — e.g. hooks registered but the MCP server not. Two guards, together:
- **Pre-flight parse BOTH targets before writing EITHER** — fails before any write on the common case (an unparseable existing config).
- **Roll the first write back if the second throws** — wrap the second `mergeConfig` and, on failure, `undo(first.undoId)` before re-throwing, so the pair is all-or-nothing.

**4. Two adjacent patterns worth reusing:**
- **`headersHelper` as the KTD6 token-delivery mechanism for a shell-out-only integration point.** Claude Code's native MCP client can't read our per-boot token file, so instead of embedding a (stale-by-next-boot) token in `~/.claude.json`, register a `headersHelper` COMMAND that reads the token fresh at every connection. Same "read at call time, never embed" discipline (KTD6), generalized to a client that can only invoke a command string.
- **Fail-open hook convention.** A hook that runs on every session must never block or slow it. Collapse *every* failure — server down, missing token, timeout, and critically a valid-JSON **wrong-shape** 200 from a foreign process squatting the port — to "emit nothing, exit 0", via a shared fetch-with-timeout helper + a coarse response-shape guard + an entry-level `main().catch()`.

## Why This Matters
These are the user's LIVE daily-driver configs (R11/KTD6): a merge bug **drops the user's own hooks**, a wrong reversal **wipes Claude Code's live state**, and a non-atomic cross-file install leaves a **half-installed** setup. The asymmetry and the remove/replace gap are non-obvious — the engine's own docstring anticipated the array case but deferred a first-class solution. The strongest signal that this is a real trap and not a corner case: two independent review layers hit the *same* subtree-gap root cause from different angles — `ce-code-review`'s correctness lens caught the **uninstall** side (undo throws on the diverged file), and the **cross-model Codex gate** independently escalated the **install** side to high severity (a pre-existing embedded token surviving the merge). Getting the pattern written down means the next installer starts from the known-good shape instead of re-discovering the array-clobber and the whole-file-restore traps against a user's real config.

## When to Apply
- Building any installer, provisioner, or **deprovisioner** on the config-write engine — U8 (Codex: `~/.codex/config.toml`) and U10 (parity provisioning) are the immediate next consumers.
- Writing to a config file a foreign tool also owns and mutates (the whole-file-restore trap is specifically about these).
- Needing idempotent re-install (dedupe your own entry) or a clean uninstall (you need targeted removal, which is the deferred primitive — don't reach for whole-file restore).

## Examples

**Array read-modify-write (preserve the user's entries, stay idempotent):**
```ts
// deepMerge REPLACES arrays, so hand it the whole desired array: existing-minus-ours + ours.
const existing = existingEntriesWithoutOurs(current, "SessionStart", ourCommand); // strip our prior entry
const sessionStart = [...existing, { matcher: "startup|resume|clear", hooks: [{ type: "command", command: ourCommand }] }];
mergeConfig(settingsPath, { hooks: { SessionStart: sessionStart } }, { dataDir }); // object-keyed hooks.* merges; the arrays are replaced wholesale
```

**Cross-file transactional install (roll back the first write if the second fails):**
```ts
const settings = mergeConfig(settingsPath(home), { hooks: {...} }, { dataDir });
try {
  mcp = mergeConfig(claudeJsonPath(home), { mcpServers: {...} }, { dataDir });
} catch (err) {
  if (settings.undoId) { try { undo(settings.undoId, dataDir); } catch {} } // best-effort; original error propagates
  throw err;
}
```

**Uninstall today (per-target, tolerant of the diverged live-state file):**
```ts
for (const target of [claudeJsonPath(home), settingsPath(home)]) {
  const entry = listUndo(dataDir).findLast((e) => e.targetPath === target);
  if (!entry) continue;
  try { undo(entry.id, dataDir); }               // ~/.claude.json is ~always diverged → this throws
  catch (err) { console.error(`uninstall: skipped '${target}' (changed since install?)`, err); }
}
// KNOWN LIMITATION: the diverged ~/.claude.json is skipped, so mcpServers.agent-os lingers (harmless — CC
// marks the absent server unavailable). Targeted removal is the deferred U14 primitive.
```

**Lived confirmation (2026-07-08).** U7's live-VS1 dogfood ran this exact install→uninstall against the REAL `~/.claude` on a heavily-configured daily-driver (5 existing SessionStart hooks + 3 MCP servers). Confirmed on a live machine, not just in tests: `settings.json` undo restored cleanly; **`~/.claude.json` undo was correctly REFUSED** by the identity check — Claude Code had live-rewritten it since install (~40 min earlier), so it had diverged, and `undo` threw rather than clobber CC's newer state. The `mcpServers.agent-os` entry lingered exactly as predicted. Until the deferred primitive lands, the manual removal is a surgical key-delete with an atomic write (never a whole-file rewrite):

```python
d = json.loads(open(path).read())          # read the LIVE file (CC may have just rewritten it)
d["mcpServers"].pop("agent-os", None)       # delete only our key — preserve CC's live state
out = json.dumps(d, indent=2, ensure_ascii=False)  # indent=2 matches Node's JSON.stringify(obj,null,2)
# write to a temp file in the same dir, then os.replace(tmp, path)  — atomic, minimal-diff
```

This upgraded the whole-file-restore trap from *predicted* (decision #26) to *observed on a live daily-driver* — the single strongest reason the deferred targeted-removal primitive is real and not a corner case.

## Related
- `src/install/claude-code.ts` — the installer this documents; `src/configwrite/engine.ts` — `deepMerge`/`mergeConfig`/`undo`.
- DECISIONS #16 (U14 config-write engine invariants) and KTD6 (config-write discipline: backup → merge → gate → undo; token read at call time, never embedded).
- Deferred GitHub issue (label `deferred`): "U14: subtree replace/remove primitive + callback patch" — the remove/replace gap's tracked fast-follow (unblocks targeted uninstall, install stale-key cleanup, and the non-atomic double-read). Uninstall targeted-removal was a deliberate CTO defer (decision A during U6's review loop).
- U6 (Claude Code consumption + clean-end hooks) — where the pattern was worked out.
