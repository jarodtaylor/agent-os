---
title: Presence semantics, not byte-level no-ops, in parse-reserialize config engines
date: 2026-07-10
category: docs/solutions/architecture-patterns
module: configwrite (U14 config-write engine)
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - Building a write engine that parses a foreign-owned file, computes a change, and reserializes it through a canonical formatter (config files, structured data files, any read-modify-write over a canonical serializer)
  - Idempotence is implemented as "byte-compare the freshly serialized result against what is on disk", not as a semantic question asked before serializing
  - The target file can be hand-edited or formatted differently than your own serializer would produce (different indent width, comments, key order)
  - A same-model or cross-model review keeps finding a new instance of what looks like an already-fixed "this should do nothing" bug
tags: [config-write, idempotence, presence-semantics, no-op, fail-closed, adversarial-review, reserialize, lesson-recurrence]
related_components: [configwrite, install]
---

# Presence semantics, not byte-level no-ops, in parse-reserialize config engines

## Context

U14's config-write engine (`src/configwrite/engine.ts`) is the one primitive every installer and future parity action uses to mutate Jarod's LIVE `~/.claude/settings.json`, `~/.claude.json`, and `~/.codex/*` — files a foreign process (Claude Code, Codex) also owns and rewrites continuously, and which are routinely NOT in the format the engine's own serializer would produce (4-space-indented JSON, hand-added TOML comments `smol-toml` drops on reserialize).

The engine's idempotence check has always included the obvious one: parse → transform → serialize → compare the fresh bytes to what's on disk → skip the write if they match (`engine.ts:253`). That check is correct for what it's built for — a repeat install reproducing the same canonical bytes it wrote last time — and structurally cannot catch a different case: an operation that resolves to "there was nothing here to change" (removing a key that was never set, uninstalling something never installed) on a file the engine has never written before. Reserializing an UNCHANGED parsed tree through a canonical formatter still produces bytes that differ from a foreign-formatted original, so the byte-compare reports "changed" and the engine dutifully backs up, writes, and journals a rewrite that reformats — and for TOML, silently strips comments from — a file nothing was actually done to.

This is not hypothetical: it is exactly the class that five rounds of cross-model (Codex) adversarial review on this branch kept finding, each round closing one INSTANCE of it a level further down, until the fix stopped being "add another guard" and became "give the engine one first-class presence decision every write path asks before it ever serializes."

## Guidance

**A byte-level no-op check answers the wrong question.** "Do the bytes I'm about to write match the bytes on disk" conflates two independent facts — *did anything semantically change* and *does this file happen to already be in my canonical format* — and only the first is what a caller means by "no-op." They diverge on every foreign-formatted file, which is most of them until this engine has written one itself. **Design the "is there anything to do" question in as an explicit semantic check on the PARSED value, decided before serialize is ever called — never as a defense discovered by comparing bytes after serializing.**

This engine ended up with four first-class primitives instead of accumulating guard patches:

1. **One shared three-outcome presence primitive.** `statTarget()` (`engine.ts:561`) returns `"present"` (a regular file), `"absent"` (a genuine `lstat` `ENOENT`), or THROWS — a symlink, `EACCES`, `ENOTDIR`, any lookup that didn't cleanly resolve. Indeterminate is an error, never silently absence. Both `mergeConfig` and `removeConfigKeys` share this ONE decision (`publish()`, `engine.ts:214`), which closed a separate merge-side bug for free: an unreadable existing file used to read as "doesn't exist" and get routed to the create path, where a temp-write+rename would clobber a file the engine never actually read.
2. **Exact leaf resolution for removal.** `removeKeys()` (`engine.ts:377`) returns `{ value, deleted }`, where `deleted` is true only when a path resolves to an OWN key that actually exists (`Object.hasOwn`, not truthiness — a `null`/`false`/`""` value still counts as present) or an in-range array index. A path whose parent exists but whose final key doesn't is not a deletion — it's nothing, and "nothing happened" must never re-serialize.
3. **An exported abstain sentinel.** `MERGE_NOOP` (`engine.ts:154`): when a transform (a removal, or a merge callback) determines nothing needs to change, it returns this symbol and `publish()` short-circuits BEFORE `serializeConfig` is ever called (`engine.ts:245`) — no serialize, no backup, no write, no journal, and on an absent target, no create. Because it's the engine's own exported sentinel, a caller can compute its abstain decision from the SAME parsed read the engine used, instead of running a separate pre-check against a second read.
4. **Fail-closed refusal where correctness can only be guarded against, not checked for.** A YAML anchor/alias (`a: &x {...}` + `b: *x`) resolves to a SHARED object identity in the parsed tree; an in-place key removal under one path silently mutates every other path aliased to the same object. There's no cheap presence check that makes this safe. `hasSharedIdentity()` (`engine.ts:459`) detects the shared-identity case and `publish()` refuses the removal outright (`engine.ts:233`) rather than risk a correct-looking removal that corrupts an untargeted alias. The real fix (copy-on-write before mutating) is deferred to issue #32 specifically because "refuse" is a sound interim answer and "silently maybe-corrupt" is not.

## Why This Matters

Every round of this was a working fix for the specific case it targeted, and every round left the class alive one layer further down — because each was a guard bolted onto the existing byte-comparison model rather than a change to what "no-op" meant. Issue #29 names the chain explicitly, in the order it was found: **"byte-compare → hooks presence gate → NOOP sentinel → leaf check."**

- **Byte-compare** (baseline): the original, structurally insufficient check described above.
- **Hooks presence gate** (`1359de7`): fixed it at the CALLER layer only. The shared hook-removal helper (`src/install/shared.ts`) learned to build an empty patch when nothing of ours was present, and to presence-gate the `mergeConfig` call itself with an `existsSync` check — protecting exactly one caller (hook uninstall) and leaving `removeConfigKeys`, and every other `mergeConfig` caller, unprotected.
- **NOOP sentinel** (`419894f`): moved the guard INTO the engine — `removeConfigKeys`'s own transform started reporting a `deleted` flag, and the caller's presence gate was tightened from `existsSync` to `lstat` semantics (a dangling symlink no longer misread as "absent, nothing to do"). But `deleted` was computed coarsely enough that a parent-exists/leaf-absent path still counted as a deletion — so removing an absent KEY (the single most common uninstall case: a key that was never installed) still slipped through and reformatted the file. Codex's own gate verdict flagged this as "the 3rd instance of the no-write-when-clean class" and invoked a standing project rule directly: **lesson #3** in `tasks/lessons.md` ("The Codex gate reasons from UNCONDITIONAL invariants — a scoped defer is a CTO call, not a re-run"), first recorded during a completely unrelated unit (U5, 2026-07-05), which says plainly: *"STOP partial-fixing after the 2nd no-ship on one area — a recurring finding there means it's a coherent design […] that belongs at its natural home, not a 3rd patch."*
- **Leaf check** (`7fe4d0d`): the design-level fix the lesson called for — `Object.hasOwn`-exact leaf resolution plus the unified `statTarget()` — explicitly framed in its own commit message as *"the sanctioned lesson-#3 re-entry: design change, not a third patch."* Applying the same presence lens uniformly (not just to the reported removal case) is what caught the unrelated merge-side clobber-create bug as a bonus — it was never filed as its own issue, only found because the fix unified ONE primitive across both call paths instead of patching removal alone.
- **Two more rounds followed the design pass**, closing what it didn't reach: `cba712e` promoted `MERGE_NOOP` to the engine's own exported sentinel, letting the hook-removal helper delete its last caller-side pre-check entirely (closing the race where a separate precheck read and the engine's own later parse of the same file could disagree — a concurrent foreign write landing between the two could still make a clean file get reformatted); `264ddcb` found a structurally different presence question — shared object IDENTITY under YAML aliasing — that no exactness-of-key-lookup fix could address, and drew the line at fail-closed refusal instead of chasing a sixth guard.

**The pattern worth internalizing: when review keeps finding a new instance of a bug you already "fixed," check whether the fix moved the guard or moved the model.** A guard stops the instance in front of it and leaves the mechanism that produces the next instance untouched — four call sites, one root cause. Lesson #3 exists precisely to name the trigger for stopping that loop (the *second* no-ship on the same area), and this unit is a second, independently confirmed application of a rule first learned nine days earlier in an unrelated part of the codebase — the concrete case for writing lessons down instead of re-discovering them per incident.

Two sibling disciplines from the same unit reinforce the same "state what's actually guaranteed, don't imply more" instinct:

- **Typed applied-but-unjournaled outcomes.** When the atomic rename succeeds but the follow-up undo-journal write then throws, the mutation is LIVE but unrecorded — a distinct failure mode from "never applied." `AppliedButUnjournaledError` (`engine.ts:74`) carries `targetPath`/`backupPath` so a caller classifies it as `removed` plus a `warnings` entry, never as `failed` — collapsing the two would either hide a live mutation as an apparent no-op, or double-count a successful removal as an error.
- **A scope claim is only honest if the code that would violate it says so.** The engine's own header (`engine.ts:20`) states plainly that it holds no cross-process lock and does no optimistic-concurrency check — a foreign write landing in the read→rename window is SUPERSEDED, not prevented, recoverable only via the backup. That's issue #28, deliberately not claimed as solved by the presence-semantics work, because presence semantics answer "does this exist," not "did someone else just change it while we were looking."

Every conditional defer in this unit left BOTH a tracking issue (#27, #28, #31, #32) AND a narrowing comment at the exact place a future reader would otherwise assume more safety than the code provides. A defer that isn't logged in the code itself, not just in a review transcript, decays into a claim nobody remembers to doubt.

## When to Apply

- Building any write engine that parses a file into a value, computes a candidate next value, and reserializes it through a canonical formatter — config files (JSON/TOML/YAML), structured data files, generated source — where the target may already exist in a format your own serializer wouldn't reproduce byte-for-byte.
- Before reaching for "compare the output bytes to the input bytes" as your ONLY idempotence check. Keep it — it is still the right second-order check for "did a real, byte-identical-on-reapply change land" — but pair it with a semantic "is there anything to do" decision made against the PARSED value, before serialization, for the "nothing resolved" case the byte-compare structurally cannot catch on a foreign-formatted file.
- Any time a review — same-model or cross-model — reports a second or third instance of what looks like an already-fixed bug. Check whether the previous fix added a guard at one call site or changed what the underlying check means. If it's guards, expect a next instance, and treat the recurrence itself (not the severity of any one finding) as the signal to change the model, per lesson #3.
- Any in-place mutation of a parsed tree (deleting a key, splicing an array) where the parser can hand back ALIASED/shared object identities (YAML anchors, some template formats) — a presence check on keys is not the same guarantee as a safety check on identity, and the two need separate guards.

## Examples

**The insufficient check — no-op decided by comparing output bytes to input bytes, after an unconditional serialize:**
```ts
// Old shape: always transform, always serialize, THEN ask "did anything change".
const next = transform(base);          // e.g. removeKeys(base, ["mcpServers.agent-os"])
const nextText = serializeConfig(format, next);
if (existed && nextText === currentText) return { noop: true, /* ... */ };
// Re-serializing an untouched foreign-formatted file never equals its original bytes,
// so this check reports "changed" and writes — reformatting a file nothing altered.
```

**The fix — presence decided semantically, before serialize ever runs (`engine.ts:172-184`, `245-247`):**
```ts
// removeConfigKeys's transform
(base) => {
  const { value, deleted } = removeKeys(base, keyPaths);   // hasOwn-exact leaf resolution
  return deleted ? value : MERGE_NOOP;                      // abstain BEFORE serialize
},
{ createIfAbsent: false, guardsRemoval: true },

// publish()'s short-circuit — runs before serializeConfig is ever called:
if (next === MERGE_NOOP) {
  return { targetPath, noop: true, created: false, undoId: null, backupPath: null };
}
```

**The presence primitive both merge and removal share (`engine.ts:561-573`):**
```ts
function statTarget(path: string): "present" | "absent" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return "absent";
    throw err; // EACCES / ENOTDIR / EIO / … — indeterminate, never silently "absent"
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`configwrite: refusing to write '${path}' — it is a symlink; ...`);
  }
  return "present";
}
```

## Related

- `src/configwrite/engine.ts` — `statTarget`, `removeKeys`, `MERGE_NOOP`, `hasSharedIdentity`, `publish` (the mechanics this doc documents).
- `tasks/lessons.md` — lesson #3, "The Codex gate reasons from UNCONDITIONAL invariants — a scoped defer is a CTO call, not a re-run" (originated U5, invoked by name in issue #29 and commit `7fe4d0d` during this unit).
- `docs/solutions/design-patterns/building-installers-on-the-config-write-engine.md` — the caller-facing mechanics of building on this engine (deepMerge's array-replace asymmetry, cross-file transactionality); this doc is the engine-internal complement — how the engine itself got its no-op semantics right.
- `docs/solutions/architecture-patterns/cross-harness-credential-second-location-race-generator.md` — a sibling "guard-patch vs. model-change" story from the same project: same shape (successive reviews finding new edges of one mechanism until the fix addressed the model), different subsystem.
- Commits `1359de7`, `419894f`, `7fe4d0d`, `cba712e`, `264ddcb` on `feat/u14-targeted-removal` — the five-round arc this doc describes (preceded by `93911df`, the same-model review pass that introduced the shared primitives these rounds hardened).
- Issues #29 (NOOP sentinel misses missing-leaf removals) and #30 (lookup failures read as absence) — resolved by this unit. Issues #27 (`replaceSubtrees` key reorder), #28 (single-process scope / lost foreign write), #31 (hook ownership by exact command string), #32 (YAML alias copy-on-write) — deliberately deferred residuals, each tracked with an issue AND a narrowing code comment.
