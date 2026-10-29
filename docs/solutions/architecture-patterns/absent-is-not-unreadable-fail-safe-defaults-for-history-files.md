---
title: "Absent" is not "unreadable" — choose the fail-safe default per caller for history files
date: 2026-10-28
category: docs/solutions/architecture-patterns
module: provision (U10 U6 provision layer — batch-status sidecar + known-projects registry)
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - A reader of an append-only state/history file (JSONL sidecar, registry, journal) returns an EMPTY result for every failure, so "file does not exist" and "file exists but could not be read" look identical to callers
  - A mutating caller's safety depends on that history being complete (to know a change was already reverted, or that a name is already bound)
  - A fail-safe is documented as "unknown degrades to the previous behavior" but the newer records unlock states the previous behavior could never reach
  - A cross-model adversarial gate flags the same defect shape in a second file after you fixed it in the first
tags: [fail-safe, history-files, absent-vs-unreadable, per-caller-policy, append-only, jsonl, undo, registry, adversarial-review, lesson-recurrence]
related_components: [provision, batch-status, registry, runs]
---

# "Absent" is not "unreadable" — choose the fail-safe default per caller for history files

## Context

The U10 U6 provision layer keeps two append-only JSONL history files, both read through `readFileBounded` (`src/provision/internal.ts:67`). It returns `{ ok: false, reason: "absent" | "blocked" }`: `absent` is a genuine `ENOENT`; `blocked` means the file EXISTS but is oversized (past the 16 MiB bound), non-regular (directory, FIFO), or unreadable (`EACCES`).

Both readers collapsed every failure to an EMPTY MAP:

1. `readBatchStatuses` (`src/provision/batch-status.ts`) — the batch terminal-state sidecar (`committed` / `rolled-back` / `undone`). Its stated fail-safe was "unknown ⇒ eligible for undo; degrades to pre-#50 behavior." But `undone` records are what make walking back history possible (undo B, then undo A, over one path). Lose the WHOLE file and a spent batch B looks live again; disk once more matches B's `postHash`, so a bare `undo` re-applies B's backup — resurrecting a reverted change while reporting success. "Degrade to the old behavior" was false: the old system could never reach that state.
2. `registerProject` (`src/provision/registry.ts`) — trusted the empty map from `readKnownProjects` as "this name is free." A write-only (mode 0200) registry let `init` append a record that silently rebound an existing logical project name to a different root.

The Codex adversarial gate flagged this twice in one session, in two different files (rounds against the sidecar, then the registry). Same defect shape recurring in a second file is the signal to write it down. Threat model is decision #45's: local single-user. This is NOT attacker-owns-HOME — an oversized file or a permissions slip is ordinary.

## Guidance

**"No history" is a legitimate state; "history I could not read" is lost information. Never let a reader fold the two into one empty result and then let a mutating caller trust it.** Ask, per CALLER, which direction is safe, and split two cases the code had conflated:

- **PER-ITEM unknown** (no record for this batch/name; an ABSENT file means nothing was ever recorded) → keep the existing fail-safe default (eligible for undo; name is free).
- **WHOLE-HISTORY unknown** (file exists, cannot be read) → a MUTATING caller whose safety depends on the history **refuses**.

Applied here (commits `d7f849a` for the sidecar, `df15800` for the registry):

- `batchHistoryReadable()` (`src/provision/batch-status.ts:126`) is `read.ok || read.reason === "absent"`. `undoBatch` (`src/provision/runs.ts:191`) asks it FIRST, before selection or any disk touch, and returns a `failed` outcome with fixed text and a fixed path (no file content).
- `registerProject` (`src/provision/registry.ts:89`) checks `readFileBounded` for `blocked` at the top and returns `write-failed` rather than appending.
- **Read-only consumers keep the empty map.** Drift (`liveProvisionedTargets`, `runs.ts:122`) treats "everything still live" as the answer when history is lost, which OVER-reports drift — its safe direction. `readKnownProjects` lookups likewise stay fail-closed on the empty map (an unknown name is a refusal). The reader's docstring now says so, and points mutating callers at the guard.

## Why This Matters

- **The empty result has two meanings, and only one is safe to act on.** For a lookup, "nothing known" is already the refusing direction. For a mutation that is gated on history ("is this batch already spent?", "is this name already bound?"), "nothing known" reads as permission. The same return value is correct for one caller and a silent-corruption path for the other.
- **"Degrades to the previous behavior" is only a valid fail-safe if the previous behavior could reach every state the new records unlock.** Before the sidecar existed, a spent batch could never look live again, so there was nothing to degrade TO. Check the claim against the old system's reachable states, not its code path.
- **Success-reporting resurrection is the worst failure mode here.** The undo "worked," exit clean, and re-applied a reverted change. A refusal is loud and recoverable; a silent rebind or re-apply is neither.
- **The registry was the same bug in a new file.** Fixing only the sidecar would have left the class alive one layer over, which is the guard-vs-model trap from [[presence-semantics-not-byte-level-noop-checks]]: here the "model change" is making absent-vs-blocked a first-class distinction at the reader, and the caller policy explicit.
- **Growth now fails visibly.** Issue #58 (sidecar compaction) is deferred; until it lands, a sidecar past the bound makes `undo` refuse with a clear message instead of silently losing its records.

## When to Apply

Checklist when you add or review a reader of persisted state/history:

1. Does the reader return the same value for "absent" and "exists but unreadable"? If yes, list its callers.
2. For each caller, ask: if this were EMPTY because the history was lost, which direction does the caller err? Over-report / refuse (safe) vs proceed / allow (unsafe).
3. For every mutating caller that errs toward proceeding, add an explicit "readable or absent" guard BEFORE any decision or disk touch, and refuse with fixed, content-free text.
4. For read-only callers, leave the empty-map behavior and say in the docstring why that direction is safe.
5. Re-read any fail-safe phrased as "degrades to the previous behavior." Can the old system actually reach the state the new data protects against? If not, the default is not a degradation; it is a new hazard.
6. When a gate flags this in one file, grep for every other `readFileBounded` / equivalent consumer in the layer and answer 1-4 for each now, not on the next round.

## Examples

**The conflated read — every failure becomes "unknown everywhere ⇒ eligible":**
```ts
const read = readFileBounded(path);
// absent, oversized, non-regular, or unreadable — unknown for every batch, which is the fail-safe (eligible)
if (!read.ok) return out;
```
Correct for an absent file and for drift; wrong as the input to a mutating undo.

**The split — the mutating caller asks the whole-history question first (`runs.ts:191`, `batch-status.ts:126`):**
```ts
export function batchHistoryReadable(dataDir?: string): boolean {
  const read = readFileBounded(batchStatusPath(resolveDataDir(dataDir)));
  return read.ok || read.reason === "absent";
}

// undoBatch, before selection or any disk touch:
if (!batchHistoryReadable(dataDir)) {
  const error = "batch terminal-state history exists but cannot be read — refusing to undo (a spent batch could be re-applied)";
  return { batchId: batchId ?? null, reversed: [], alreadyReversed: [], superseded: [], failed: [{ path: batchStatusPath(resolveDataDir(dataDir)), error }] };
}
```

**Registry (`registry.ts:89`):**
```ts
const history = readFileBounded(knownProjectsPath(resolved));
if (!history.ok && history.reason === "blocked") {
  return { kind: "write-failed", name, error: "the known-projects registry exists but cannot be read — refusing to register (an existing binding could be overwritten)" };
}
```

**Regression-test approach.**

- Sidecar (`tests/provision-apply.test.ts`, "gate round 7: terminal-state history that EXISTS but cannot be read refuses undo — never resurrects"): build the walk-back (apply A, apply B, undo B, undo A), then `rmSync` the sidecar and `mkdirSync` a DIRECTORY at the same path. A directory deterministically hits the non-regular guard and is portable; `chmod 000` is fragile (root bypasses it). Assert the bare `undo` and an explicit-id `undo` both refuse with "cannot be read" and the project file stays at its walked-back bytes. Then remove the directory and assert an ABSENT history proceeds, pinning the per-item/whole-history split in both directions.
- Registry (`tests/provision-registry.test.ts`, "an existing but UNREADABLE registry refuses registration — never a silent rebind"): `chmod 0o200` makes the read fail while an append would still succeed, which is exactly the hazard. Wrap in `test.skipIf(process.getuid?.() === 0)` since root can read a 0200 file, restore the mode in `finally`, and assert the file bytes are unchanged and the original binding still resolves.

## Related

- `src/provision/internal.ts` (`readFileBounded`, `ReadOutcome`), `src/provision/batch-status.ts` (module docstring: "THE FAIL-SAFE INVARIANT has TWO cases"), `src/provision/registry.ts`, `src/provision/runs.ts` (`undoBatch`, `liveProvisionedTargets`).
- Commits `d7f849a` and `df15800` on `feat/u10-u6-cli-seed-template`.
- Decision #45 (local single-user threat model); issue #58 (sidecar compaction, deferred).
- [[presence-semantics-not-byte-level-noop-checks]] — same shape: indeterminate lookups must be an error, never silently "absent"; and the guard-vs-model lesson on recurring review findings.
- [[one-pure-extractor-per-caller-failure-policy]] — the sibling principle: failure policy belongs to the caller, not the shared reader. Here the shared reader keeps returning the empty map, and the mutating caller adds its own refusal on top.
