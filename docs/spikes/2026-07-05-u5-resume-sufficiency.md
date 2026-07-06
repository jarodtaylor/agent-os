# U5 Sufficiency Spike — raw-trail resume-sufficiency on messy cuts

**Date:** 2026-07-05 · **Owns:** plan §U5 execution note; decision #14's caveat ("re-check on messier mid-implementation resumes during U5").
**Question:** Can a *cold* agent — no repo, no prior conversation, no handoff — reconstruct in-flight state AND the correct next action from ONLY a mechanically-extracted raw breadcrumb trail (prompts + tool-call summaries + file-edits, no assistant narration, no tool results)?

## Verdict: GO — build U5. But read the ceiling as loudly as the pass.

- **Direction: recovered on all 5 cuts.** Every cold agent, closed-book, opus-class, correctly identified *what was in flight* and named *a correct next step* — across the full messiness spectrum.
- **Ceiling: 0/5 recovered tool-observations or exact decision-content without the repo. Confidence was MEDIUM on every cut, never high.** The trail tells a resuming agent *where it is and what to do next*; it does NOT carry *what the tools observed* (test pass/fail, error output, review verdicts) or the *substance* of a pending decision.

The gate is **GO** because even the pessimistic read says the same thing: **build U5, and add an observation layer.** That is the finding.

Upgrades decision #14 from **n=1 on a legible cut** to messy mid-implementation cuts. Closed-book held: all 5 self-reported `TOOLS_USED: none`; no answer cited repo detail absent from its trail.

Source: U14 config-write build session (`e0136f2e…jsonl`, 2026-07-04, ~4h, 197 breadcrumbs). Cut by truncating the real transcript at byte offsets (= what the tailer reads to `capture_cursor`; faithful crash sim). Trail = last 50 breadcrumbs before cut (faithful to the shipped U2-R6 cap). Ground truth = the real continuation.

## Scorecard — the load-bearing evidence is C1/C2/C4

| Cut | Stress tested | Direction | Weight |
|---|---|---|---|
| **C0** control/legible | clean boundary | recovered (exact) | **near-trivial** — next action was spelled out verbatim in the trail |
| **C1** mid multi-file edit | 7× "Edit schema.ts", no "what changed" | recovered | **load-bearing** — reoriented to the durable state file (`open-findings.md`) + `git diff`; trail = *pointer*, not payload |
| **C2** observation-free debug | NUL-byte detection, result not shown | recovered | **load-bearing** — inferred binary corruption + root cause from the action label; but had to give a *conditional* (needed the result it couldn't see) |
| **C3** interrupted async | codex review launched, result never landed | recovered (exact) | **near-trivial** — "wait for the background job" is generic-correct for any interrupted task |
| **C4** decision point | "make the CTO/CPO decision" — git-silent | recovered *process*, NOT *content* | **load-bearing** — reconstructed *which* decision + right process; could NOT recover the actual decision (needs review contents) |

Blind-judge independent verdict: **5 PASS / 0 PARTIAL / 0 FAIL on direction** — and it *independently* named the same ceiling: "the only recurring shortfall traced directly to not seeing tool/review OUTPUTS… it cost only precision, never direction." It also caught two precision misses the trail couldn't prevent: C1 missed the interleaved U1-regression sub-thread, and C4 couldn't name the specific fix. Corroboration only (it saw my *condensed* rendering of each answer and was told C4 became decision #16) — a sanity check, not bias-free ground truth — but it agrees with the honest read.

## The finding every agent surfaced (even the control): actions, not observations

The raw trail captures **what was done** (tool calls, edits) but not **what was observed** (test pass/fail, the NUL count, review verdicts). So resume *direction* was reliable, but resume *confidence* capped at *medium* — every agent's #1 gap was "I can't see the tool outputs."

## The fix: capture tool RESULTS (structural), not narration (contingent)

Observations must come from `toolUseResult` — **every tool call emits one, regardless of how terse or crash-ended the session is.** That is exactly the undisciplined case U5 exists for. (Assistant narration also carries observations — the ground-truth tails show SAY lines like "37 contract tests pass" — but narration is a *bonus*: it assumes the agent narrated. Don't build the observation layer on it.)

→ **U5 primary refinement:** capture a terse **digest** of key tool results — test pass/fail + counts, non-zero exits, a pointer/short digest of review output. Digests, not dumps; sensitivity rides the U4 redaction choke-point as designed. My spike extractor drops `toolUseResult` entirely — that is the gap to close.

## Jarod's marginal-value question — *supported*, not proven (2-point inference)

Behavioral read of what the cold agents actually did:
- **Code-state cut (C1):** the agent reached for `git diff` to see *what changed* — git carries the payload, the trail is a *pointer*. Marginal value LOWER.
- **Decision cut (C4):** git is silent; the trail was the only carrier of "which decision is pending + context." Marginal value HIGHER.

Two data points, not a controlled baseline → a good **working hypothesis**: weight U5 toward decision/intent capture (user directives, decision context) and treat code-edit breadcrumbs as lean pointers into git. If this becomes load-bearing for sequencing, *that's* when a live-cut repo-only baseline earns its cost — not now.

## U5 design implications (what to build)
1. **Capture terse tool-RESULT digests** (test pass/fail, errors, review pointer) — the observation layer. *(Refines the plan's authored breadth — the spike's job: "before building extraction breadth, run the sufficiency check.")*
2. **Use the Bash `description`/intent string** in tool-call summaries, not a raw truncated command — C2 resumed *only* because the label carried intent.
3. **Keep file-edit breadcrumbs lean** — "Edit X" suffices; no hunk-gists (`git diff` carries "what changed"). Keeps U5 lean.
4. **Filter obvious noise** — teammate idle-pings, `/clear`, command scaffolding.

## Honest limitations
- **One session's task-texture** (U14 build, CE-heavy — but representative for agents-os). Moment-diverse, not task-diverse; n=5 from one transcript.
- **Trail-only is the strong test** — strictly harder than production (which also has the repo). Passing trail-only ⇒ passes in deployment; no live cut needed for the gate.
- **Cold agents were opus-class.** Validates "a strong agent resumes"; a weaker resuming model may do worse.
