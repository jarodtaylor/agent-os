# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Build loop

### Unit
One numbered slice of the implementation plan (U1, U9, …), scoped to ship independently through the unit-loop. A unit is mechanism-sized — small enough for one build-review-gate cycle, large enough to leave a working capability behind.

### Unit-loop
The required per-unit pipeline: build, simplify, multi-persona code review, cross-model adversarial gate, learning capture, then a PR that must reach green CI. A unit is not done at "code works" — it is done when the loop's gates have all passed or been explicitly overridden.

### Adversarial gate
A cross-model review — a non-Claude model challenging the unit's design and assumptions — required before a unit's PR opens. *Avoid:* Codex gate (the current reviewer, not the concept).

The gate's verdict is ship or no-ship, and the review must have run on the exact commit being PRed. Its findings are judged against the project's written threat model; a no-ship with a properly logged scoped defer still satisfies the gate.

### Scoped defer
An explicit ruling that a gate or review finding is acknowledged but not fixed now. A legitimate scoped defer narrows the claimed invariant honestly everywhere it is stated, files the full fix with a concrete promotion trigger, and logs the override loudly — it is a visible decision, never a silent skip.

## Inventory (the Observe half)

### Inventory
The cross-harness list of what is installed and active right now — skills, MCP servers, plugins — computed from live disk on every scan and never persisted. A removed item simply stops appearing; there is no cache to reconcile and no phantom rows.

### Scanner
The per-harness observer that reads that harness's own on-disk configuration and returns its slice of the Inventory. Scanners are fail-soft: an unreadable or malformed surface degrades to empty rather than aborting, and a scanner that throws anyway degrades only its own runtime, never the whole sweep.

### Runtime
The harness an inventory item was observed in. Distinct from Source on purpose: the observer is never conflated with the observed.

### Source
The producer of a record — who wrote it, not where it was seen. For scanned inventory items the Source is agent-os itself, because the OS's scanner is what observed them.

### Degraded
The state of a surface or runtime whose read failed during a scan: it contributes nothing to the Inventory while the rest of the sweep completes. Degradation is reported, never fatal — the opposite of a scan that fails wholesale because one config was broken.

### Harness
An external AI agent runtime (a coding CLI or app, such as Claude Code or Codex) that agent-os observes and provisions. agent-os is not itself a harness — it works on harnesses from outside, and they keep working with or without it.
