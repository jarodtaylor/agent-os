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

## Provisioning (the Act half)

### Blueprint
A project's versioned single source of truth for its agent setup: a plain directory plus a manifest, living in the project repo. agent-os renders it into each harness's native surfaces; it carries no secrets and no machine-specific paths.

### Role bundle
One manifest entry mapping a role (Architect, Executor, QA, …) to its target harness, an optional model pin, and its files with transform types. Metadata is machine-readable but descriptive only — it drives file operations, never workflow sequencing.

### Front-gate
The shared validation every provisioning verb (plan, apply, status, propose) runs first: it checks the blueprint's manifest is a compatible version, then scans the blueprint's contents for secrets and machine-specific absolute paths, returning one typed result the verb branches on.

Its guarantee is scoped and its failures are content-free: a failure names the offending file, never its content. It fully certifies the manifest and whole-file sources; for a config-format source, a secret hidden behind an encoding escape surfaces only once the file is parsed, so that effective-form scan is deferred to where the parse happens (render for merges, apply for verbatim copies) — the front-gate's own pass over those is best-effort. A blueprint it passes is loadable and free of the leaked secrets and non-portable paths it does check for.

### Provision
The render → diff → apply push of a blueprint into native harness surfaces, reversibly and project-scoped. The same rendering powers the dry-run plan, the apply, and the drift report. Provision-down only — pulling harness-local changes back into a blueprint (adopt-up) is a separate, deferred concept.

### Seed template
The starter blueprint that ships with agent-os and is copied into a project by `init`, then hand-tuned. Template content is evidence-based but always tunable; only the mechanism is fixed.

### Drift
Divergence between a blueprint's rendered output and the live provisioned surface, detected read-only by the same diff machinery. Reported, never auto-reconciled.

### Run state
`RUN_STATE.md` — the cross-harness run file each role reads and rewrites as a workflow passes between harnesses (named `HANDOFF.md` in dogfood run 1). Runtime state, never a provisioned target; `init` scaffolds it once. Distinct from a Handoff (session-to-session continuity record) and from WorkState (the substrate's derived record). *Avoid:* calling this a handoff.

### Provision run
One `apply` batch: the ordered set of writes it made, recorded durably so `undo` can reverse the most recent run as a unit. Only the latest run is undoable; older runs' entries are refused as superseded.
