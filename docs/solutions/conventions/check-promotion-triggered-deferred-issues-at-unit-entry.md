---
title: Grep the deferred issues for promotion triggers naming this unit before writing the ce-work brief
date: 2026-07-22
category: docs/solutions/conventions
module: ".claude/skills/unit-loop/SKILL.md (step 1 entry gate + step 2 ce-work); GitHub deferred-labelled issues (decision #21)"
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - "Starting a unit-loop / ce-work run — before writing the implementation brief for the unit"
  - "A deferred issue's promotion trigger is phrased as an event ('before U<N>/<component> ships', 'when the first X lands') rather than a fixed date"
  - "Building the first code that performs an operation a prior unit explicitly parked (the first writer, the first network caller, the first consumer of an untrusted input)"
  - "Deciding what belongs in a unit's scope beyond the plan's own requirements list"
tags:
  - unit-loop
  - deferred-issues
  - promotion-trigger
  - ce-work-brief
  - adversarial-gate
  - scope
---

# Grep the deferred issues for promotion triggers naming this unit before writing the ce-work brief

## Context

Deferred work in this repo is tracked as GitHub issues with the `deferred` label (decision #21), each carrying a **promotion trigger** — the condition under which the parked work must be done. Many triggers are *event*-phrased, not date-phrased: "before U5/apply ships", "on the first VPS run", "when the first non-Claude harness enters rotation". An event-phrased trigger fires silently — nothing in the plan's own requirements list, the ce-work brief, or the code review will mention it, because the obligation lives in a *separate* issue written rounds or weeks earlier.

The plan (`ce-plan` output) tells you what a unit must *build*. It does not re-derive what earlier units *deferred onto* this one. That gap is the failure mode.

## Guidance

At unit-loop entry (step 1) — before writing the ce-work brief (step 2) — enumerate the open deferred issues and scan each body for a promotion trigger that names this unit or describes an operation this unit is the first to perform. Fold any match into the brief as explicit scope.

```bash
gh issue list --label deferred --state open --limit 100 \
  --json number,title,body \
  --jq '.[] | select(.body | test("U5|before .*apply|first .*write"; "i")) | "#\(.number) \(.title)"'
```

Adjust the `test(...)` alternation to the current unit id and the operations it introduces (writes, network calls, credential reads, untrusted-input parsing). A hit means the issue's fix is *in scope for this unit*, not a future one — put it in the brief with the issue number, so ce-work implements it and the code review has something to check against.

## Why This Matters

On U10 U5 (the provisioning apply/undo unit), issue **#43** — "effective-form secret scan of config-format sources before apply writes them" — carried the promotion trigger *"before U5/apply ships (it is the first code that writes parser-consumed formats to disk)"*. The trigger had fired: U5/apply was exactly that first writer. Yet the ce-work brief omitted it, `ce-work` didn't build it, all nine `ce-code-review` personas missed it, and `ce-simplify-code` missed it — because every one of those layers reasons from the code and the plan in front of it, and #43 was neither. Only the **Codex adversarial gate** (round 1) caught it, and closing it there cost a full fold-plus-re-run cycle (~15 min of gate wall-time plus the fold) that a 30-second `gh issue list` at entry would have avoided. The gate is the *backstop* for this class, not the intended catch point — an event-triggered obligation is cheapest to honor at the boundary the event names.

The concrete fix #43 asked for is itself a reusable pattern worth recognizing: an **effective-form content scan**. A raw-byte scan of a parser-consumed format (JSON/TOML/YAML) misses a secret or machine-specific path hidden behind an encoding escape (JSON `\uXXXX`) — the raw bytes read clean, but the parser decodes them at load. To certify what actually reaches disk you must scan the **decoded** form (`containsSecret(JSON.stringify(parsed))`), and that check is *egress defense* belonging at the code that writes, not only at the loader's front-gate (a direct caller, or bytes changed after validation, bypass an upstream-only gate). Scan the patch/value you contribute, never the merge result — foreign existing content legitimately holds the user's own secrets.

## When to Apply

Every unit-loop entry. It is highest-value when the unit is the *first* to perform some operation a prior unit named in a deferral — the first writer, the first consumer of untrusted input, the first credential reader — because that is exactly when an event-phrased trigger fires and exactly when no other pipeline layer will surface it.

## Examples

**Missed (U5, the cost):** brief written from the plan only → `ce-work` → simplify → 9-persona review all pass → Codex gate round 1 no-ships on the unbuilt #43 effective-form scan → fold + re-run. One avoidable round.

**Applied (the 30-second entry step):**

```bash
# At unit-loop entry for U6:
gh issue list --label deferred --state open --json number,title,body \
  --jq '.[] | select(.body | test("U6|CLI|undo verb|registry"; "i")) | "#\(.number): \(.title)"'
# → #50 (default-undo needs durable batch terminal-state — owner U6 CLI undo)
# → #51 (symlink-root realpath at the registry ingress — owner U6 registry)
# Both fold into the U6 brief as explicit scope, before ce-work starts.
```
