---
title: Building config installers/deprovisioners on the U14 config-write engine
date: 2026-07-08
last_updated: 2026-07-10
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
U6 built Agent OS's first real installer — registering Claude Code's hooks in `~/.claude/settings.json` and the brain MCP server in `~/.claude.json` — on top of the U14 config-write engine (`src/configwrite/engine.ts`: `mergeConfig` → `deepMerge` → backup → atomic write → `undo` journal; decision #16, KTD6). The engine's contract is backup-first, atomic, **merge-don't-clobber** writes to the user's LIVE daily-driver configs. Building a *correct* installer on it surfaced one load-bearing asymmetry that's still true today, and one real gap — `deepMerge` alone can neither remove a key nor replace a subtree — that every consumer since has hit: U8's Codex installer (`~/.codex/config.toml`, `~/.codex/hooks.json`) confirmed it wasn't a one-off, and U10 (parity provisioning) is next. That gap is now **closed** (issue #21: `removeConfigKeys`, a callback-style patch form, and `replaceSubtrees` shipped as first-class engine primitives — see `docs/solutions/architecture-patterns/presence-semantics-not-byte-level-noop-checks.md` for how the engine's own no-op semantics on top of those primitives then got fully correct). The durable question this doc answers: **what does a correct install/uninstall look like on this engine, using the primitives it actually provides?**

## Guidance

**1. `deepMerge`'s asymmetry is the thing to internalize: objects RECURSE, arrays + scalars REPLACE (patch wins).**
- **Array-valued config sections need caller-side read-modify-write.** Claude Code's `hooks.SessionStart` / `hooks.SessionEnd` are arrays. A naive `{hooks:{SessionStart:[ours]}}` patch REPLACES the whole array → **silently drops the user's existing hooks**. Instead: read the current array, strip *your own* prior entry (dedupe by exact command string, so re-install is idempotent — identical bytes ⇒ the engine no-ops), append your fresh entry, and pass the WHOLE combined array as the patch.
- **Object-keyed sections merge safely — no RMW.** `mcpServers.<name>` is an object key; `deepMerge` preserves sibling servers automatically.

**2. Targeted removal and wholesale subtree replace are first-class engine primitives — reach for them, don't reinvent them.** This used to be a gap (`deepMerge` alone only recurses into matching object keys; it can neither remove one nor replace a subtree wholesale). Issue #21 proposed the fix and it has since shipped:
- **Uninstall / deregistration → `removeConfigKeys(path, keyPaths, opts)`.** Deletes only the named dotted key paths (or array indices) on the SAME backup-then-atomic-write-then-journal discipline as `mergeConfig`. This is the correct reversal for a config you only partially own that a foreign process rewrites continuously — whole-file `undo` is identity-checked and still *throws* on the near-always-diverged live file (`~/.claude.json`'s `numStartups`, `projects`, …); `removeConfigKeys` instead deletes `mcpServers.agent-os` from whatever is on disk NOW, preserving everything else however it's diverged. A path that doesn't resolve (nothing installed, or already removed) is a true no-op, not a reformat — the engine treats "resolves to nothing" as a semantic outcome decided before it ever serializes, not something inferred by comparing bytes after the fact (see the presence-semantics doc linked below for exactly how deep that had to go to hold up under review).
- **Stale-key cleanup on install → `mergeConfig(path, patch, { replaceSubtrees: [...] })`.** Strips the named subtree from the base before the patch re-adds it, so a pre-existing entry carrying a key you no longer write — e.g. a static `headers` embedding a token, when you now write only a `headersHelper` — cannot survive the merge. Still idempotent: reproducing the same bytes on re-install still no-ops.
- **The callback-patch form closes the installer's non-atomic double-read.** Both primitives accept `(current) => patch` in place of a static patch: the callback computes its result from the engine's OWN parsed read, so a read-modify-write (stripping your own array entry before re-adding it, or building an uninstall diff) never depends on a separate pre-read that a concurrent foreign write could land between and have silently reverted. A callback (or static patch) may also abstain entirely by returning the engine's exported `MERGE_NOOP` sentinel — `publish` then guarantees ZERO filesystem effects: no serialize, no backup, no write, no journal, and no create on an absent target. That's what makes "uninstall something never installed" a true no-op instead of a rewrite — without it, re-serializing even an unchanged parsed tree through the engine's canonical formatter reformats (and for TOML, strips comments from) a foreign-formatted file that had nothing to remove.

**3. The engine gives PER-FILE safety, not cross-file transactionality.** If one logical install writes two files, a failure on the second (symlink target, unwritable, journal error) leaves the FIRST file's changes live — e.g. hooks registered but the MCP server not. Two guards, together:
- **Pre-flight parse BOTH targets before writing EITHER** — fails before any write on the common case (an unparseable existing config).
- **Roll the first write back if the second throws** — wrap the second `mergeConfig` and, on failure, `undo(first.undoId)` before re-throwing, so the pair is all-or-nothing.

**4. Two adjacent patterns worth reusing:**
- **`headersHelper` as the KTD6 token-delivery mechanism for a shell-out-only integration point.** Claude Code's native MCP client can't read our per-boot token file, so instead of embedding a (stale-by-next-boot) token in `~/.claude.json`, register a `headersHelper` COMMAND that reads the token fresh at every connection. Same "read at call time, never embed" discipline (KTD6), generalized to a client that can only invoke a command string.
- **Fail-open hook convention.** A hook that runs on every session must never block or slow it. Collapse *every* failure — server down, missing token, timeout, and critically a valid-JSON **wrong-shape** 200 from a foreign process squatting the port — to "emit nothing, exit 0", via a shared fetch-with-timeout helper + a coarse response-shape guard + an entry-level `main().catch()`.

## Why This Matters
These are the user's LIVE daily-driver configs (R11/KTD6): a merge bug **drops the user's own hooks**, a wrong reversal **wipes Claude Code's live state**, and a non-atomic cross-file install leaves a **half-installed** setup. The asymmetry and the remove/replace gap were non-obvious — the engine's own docstring anticipated the array case but deferred a first-class solution for the other two. The strongest signal that this was a real trap and not a corner case: two independent review layers hit the *same* subtree-gap root cause from different angles — `ce-code-review`'s correctness lens caught the **uninstall** side (undo throws on the diverged file), and the **cross-model Codex gate** independently escalated the **install** side to high severity (a pre-existing embedded token surviving the merge). Getting the pattern written down means the next installer starts from the known-good shape instead of re-discovering the array-clobber and the whole-file-restore traps against a user's real config.

The gap closed exactly as issue #21 proposed — but shipping `removeConfigKeys`, `replaceSubtrees`, and the callback-patch form wasn't the end of the story. Getting THEIR no-op semantics fully correct took five more rounds of cross-model review after they landed: the removal path itself kept reformatting foreign-formatted files on a "nothing to remove" resolution until presence became a first-class, pre-serialize decision rather than a post-serialize byte comparison. That deeper story is documented separately: `docs/solutions/architecture-patterns/presence-semantics-not-byte-level-noop-checks.md`.

## When to Apply
- Building any installer, provisioner, or **deprovisioner** on the config-write engine — U8's Codex installer (`~/.codex/config.toml`, `~/.codex/hooks.json`) already reused this exact shape as the second consumer; U10 (parity provisioning) is next.
- Writing to a config file a foreign tool also owns and mutates (the whole-file-restore trap is specifically about these).
- Needing idempotent re-install (dedupe your own entry) or a clean uninstall — reach for `removeConfigKeys` (targeted removal), never whole-file `undo` restore, for a config a foreign process also owns.

## Examples

**Array read-modify-write (preserve the user's entries, stay idempotent):**
```ts
// deepMerge REPLACES arrays, so hand it the whole desired array: existing-minus-ours + ours — and build it
// INSIDE the callback from the engine's OWN read (`current`), never a separate pre-read (guidance 2 above).
mergeConfig(settingsPath, (current) => ({
  hooks: {
    SessionStart: [
      ...existingEntriesWithoutOurs(current, "SessionStart", ourCommand), // strip our prior entry
      { matcher: "startup|resume|clear", hooks: [{ type: "command", command: ourCommand }] },
    ],
  },
}), { dataDir }); // object-keyed hooks.* merges; the arrays are replaced wholesale
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

**Targeted-removal uninstall (current — `src/install/claude-code.ts`, `uninstallClaudeCode`), tolerant of the diverged live-state file:**
```ts
// Object-keyed: delete only our key, preserving whatever else CC has written since install.
const res = removeConfigKeys(claudeJsonPath(home), [`mcpServers.${SERVER_NAME}`], { dataDir });
if (!res.noop) removed.push(claudeJsonPath(home));   // res.noop === true ⇒ nothing of ours was there

// Array-valued (hooks): a callback reads the engine's OWN parse and abstains via MERGE_NOOP when
// none of our hooks remain — no separate pre-check to race against a concurrent CC write.
mergeConfig(settingsPath(home), (current) => {
  const patch = hooksPatchWithoutOurs(current, events);   // {} when nothing of ours is present
  return Object.keys(patch).length === 0 ? MERGE_NOOP : patch;
}, { dataDir });
```
Per-target `try/catch` still isolates one diverged/corrupt target from aborting the others' removal — that discipline from the old whole-file-`undo` loop carried over unchanged; only the reversal PRIMITIVE changed.

**Lived confirmation (2026-07-08).** U7's live-VS1 dogfood ran this exact install→uninstall against the REAL `~/.claude` on a heavily-configured daily-driver (5 existing SessionStart hooks + 3 MCP servers). Confirmed on a live machine, not just in tests: `settings.json` undo restored cleanly; **`~/.claude.json` undo was correctly REFUSED** by the identity check — Claude Code had live-rewritten it since install (~40 min earlier), so it had diverged, and `undo` threw rather than clobber CC's newer state. The `mcpServers.agent-os` entry lingered exactly as predicted. At the time, with no targeted-removal primitive yet, the only safe fix was a hand-rolled surgical key-delete with an atomic write (never a whole-file rewrite):

```python
d = json.loads(open(path).read())          # read the LIVE file (CC may have just rewritten it)
d["mcpServers"].pop("agent-os", None)       # delete only our key — preserve CC's live state
out = json.dumps(d, indent=2, ensure_ascii=False)  # indent=2 matches Node's JSON.stringify(obj,null,2)
# write to a temp file in the same dir, then os.replace(tmp, path)  — atomic, minimal-diff
```

This upgraded the whole-file-restore trap from *predicted* (decision #26) to *observed on a live daily-driver* — the strongest evidence that targeted removal needed to exist, not a corner case. It is now exactly what `removeConfigKeys` automates: `uninstallClaudeCode` runs this same surgical delete, atomically, with a backup and undo journal entry, no hand-rolled script required (resolved by issue #21).

## Related
- `src/install/claude-code.ts` — the installer this documents; `src/install/codex.ts` — the second consumer (U8), same shape reused; `src/install/shared.ts` — the hook-removal helper (`removeHooksIfPresent`, `hooksPatchWithoutOurs`) both installers share; `src/configwrite/engine.ts` — `deepMerge` / `mergeConfig` / `removeConfigKeys` / `MERGE_NOOP` / `undo`.
- DECISIONS #16 (U14 config-write engine invariants) and KTD6 (config-write discipline: backup → merge → gate → undo; token read at call time, never embedded).
- Issue #21 ("U14 config-write: subtree replace/remove primitive + callback patch for correct install/uninstall") — proposed exactly the primitives this doc now documents as shipped. Uninstall targeted-removal was a deliberate CTO defer (decision A during U6's review loop) until this landed.
- `docs/solutions/architecture-patterns/presence-semantics-not-byte-level-noop-checks.md` — the engine-internal complement: how `removeConfigKeys` and `mergeConfig`'s own no-op semantics got fully correct (five rounds of cross-model review) after the primitives in this doc first shipped — a byte-level no-op check alone still reformatted foreign-formatted files on a "nothing to remove" resolution.
- U6 (Claude Code consumption + clean-end hooks) — where the pattern was worked out.
