---
title: Substrate-first continuity — one machine record, human docs as projections
date: 2026-07-08
last_updated: 2026-07-20
category: docs/solutions/architecture-patterns
module: brain/handoff continuity
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - You keep "where we left off" state that BOTH a machine (an agent, a hook, a resume path) and a human (a README, a status doc) must read
  - Continuity is spread across multiple human-maintained docs that drift apart into competing sources of truth
  - A session/agent must resume with no context pasted, from whatever the last session durably recorded
  - You are writing a handoff / checkpoint / session-wrap step and deciding what writes first and what renders from it
tags: [continuity, handoff, source-of-truth, projection, single-source, anti-drift, staleness, brain, mcp]
related_components: [mcp, workstate, store, handoff-skill]
---

# Substrate-first continuity — one machine record, human docs as projections

## Context

agent-os attempt #1 died from **drift**: continuity ("where we left off", "what's next") lived in several human-maintained docs that were each edited independently, so they slowly disagreed and stopped being trustworthy. The instinct to fix this by "just keep the docs in sync" fails — two hand-edited sources always diverge under time pressure (exactly when you're clearing context). The question this pattern answers: when both a machine and a human need to read continuity state, **what is the single source of truth, and what merely renders it?**

The concrete instance: the `/handoff` session-wrap (U7). Before, the skill wrote the human docs (`START-HERE.md` ▶ NEXT, `DECISIONS.md`) as the record — and a fresh agent had no machine-readable "resume here" at all. After, the skill writes the Brain's `write_handoff` MCP tool **first**; the docs render that write.

## Guidance

Designate exactly **one machine-readable continuity record** and make everything else a projection of it:

1. **One record, written first.** A single structured record — here the Brain's handoff `cursor` `{next, lastDecided, inFlight}`, keyed `(project, sessionId)` — is the authoritative "where we left off." The wrap step writes it **before** touching any doc. Order is load-bearing: docs-first would make the machine record a lagging copy of the docs, reintroducing the drift.

2. **Docs are projections that must AGREE.** Human-facing docs (`START-HERE.md` ▶ NEXT, a mid-work `HANDOFF.local.md`) render fields of the one record. The rule at the write site: *if a doc wants to say something the record doesn't, fix the record, not the doc.* Agreement is a build-time property, not a discipline hope — the record's upsert key `(project, sessionId)` guarantees one row per session, and the projection is derived from it.

3. **A ledger is not a continuity record.** An append-only audit log (`DECISIONS.md`: what was decided + why) is a *complement*, not a competitor — it never answers "resume here," so it doesn't violate "one record." Keep the distinction explicit so nobody "consolidates" the ledger into the resume path or vice versa.

4. **Unreachable substrate → degrade loudly.** If the one record can't be written (server down, tool not registered this session), do NOT silently fall back to docs-as-source. Write the docs, but stamp a **mandatory, visible staleness flag** ("substrate NOT updated — the machine record is behind these docs; re-run when it's up"). Silent divergence between the record and its projections is the exact failure this pattern exists to prevent.

## Why This Matters

Drift is the top project risk (anti-drift is why the project exists at all). "Keep N docs in sync" is a losing discipline bet; "one record, everything else renders it" makes non-divergence structural. It also unlocks the machine consumer for free: because the record is machine-readable and written every wrap, a fresh agent's SessionStart hook can inject "resume here" with nothing pasted — the human docs and the agent's resume context are the *same* source, so they can't disagree. The staleness flag keeps the model honest when the substrate is down instead of quietly lying that the brain is current.

## When to Apply

- Any continuity/checkpoint/handoff state read by both a machine and a human.
- Whenever you catch yourself maintaining the "current status" in two places — pick one as the record, render the other.
- Building a session-wrap, resume, or "pick up where we left off" flow: decide the write order (record first) and the unreachable-path behavior (docs-only + staleness flag) up front.

Do **not** force this on genuinely independent artifacts: a decision ledger, a changelog, and a resume-pointer are different *kinds* of state — one-record applies within a kind (the resume pointer), not across all docs.

## Examples

Write order at the wrap site (record first, then project):

```text
Step 3 (FIRST):  write_handoff({ project: <abs repo path>, source,
                   cursor: { next, lastDecided, inFlight } })   // the ONE record, keyed (project, sessionId)
Step 4 (AFTER):  START-HERE.md ▶ NEXT   := cursor.next          // projection — must equal the record
                 START-HERE.md flip line := cursor.lastDecided  // projection
                 DECISIONS.md            += decision row         // ledger (audit log, NOT a resume record)
```

Unreachable-substrate fallback (degrade loudly, never silently):

```text
if write_handoff unavailable OR errors:
    write the docs anyway
    prepend a visible flag: "⚠️ Substrate NOT updated this wrap (server unreachable) —
        the machine continuity record is BEHIND these docs; re-run write_handoff once it's up."
    # never pretend the record was written; a fresh session's resume will show older/no state
```

Verifying "exactly one record" behaviorally (the property that makes agreement structural): two writes in one session with different cursors → the read returns **one** record carrying the latest cursor (upsert on `(project, sessionId)`, not a duplicate). See `tests`/the VS3 acceptance for U7.

## Related

- `docs/DECISIONS.md` #27 (U7 shipped this pattern) · #8/KTD8 (the handoff is the one continuity record, keyed `(project, sessionId)`).
- `.claude/skills/handoff/SKILL.md` — the wrap step that implements record-first + projections + staleness fallback (note: `.claude/` is gitignored/local-only).
- `src/mcp/tools.ts` `write_handoff` (the record's write path) · `src/workstate/response.ts` (`read_work_state` / `GET /work-state`, the read that projections and the SessionStart hook share).

## Update — the record's *home* is substrate-OPTIONAL (2026-07-20, decision #51)

The pattern's **core holds unchanged**: designate exactly ONE continuity record, make everything else a projection, keep a ledger (DECISIONS) distinct from the resume-record, and never let projections silently diverge. What the handoff-hardening side quest (plan `2026-07-20-002`) corrected is the over-specification that the one record must be the **machine substrate, written first, always**:

1. **The record need not be a machine store.** Before U15's always-on server exists, agent-os had **no running substrate** — so the substrate-first skill hit the "unreachable → staleness flag" path on *every* handoff, stamping a "⚠️ substrate NOT updated" apology onto a state that was never actually degraded. That noise confused the primary user (*"I honestly have no clue what that even means"*). The fix: **today the ONE record IS `START-HERE.md` ▶ NEXT** — a human doc that is simultaneously the record and the view (one artifact, so "projections must agree" is trivially satisfied — there is nothing to keep in sync). Once U15 ships, `write_handoff` becomes the machine record written FIRST and START-HERE ▶ NEXT becomes its agreeing projection — the model this doc originally described. Structured machine-readability is what the substrate *adds* then, not a property the markdown record claims today.

2. **"Degrade loudly" is NARROWED, not removed.** The staleness flag (§Guidance step 4) is correct **only** when a substrate that is *supposed* to be running errors mid-write. "There is no substrate yet" is the normal state, not a divergence — flagging it lies about a degradation that isn't there. Crash-safety is now carried separately by a Stop-hook breadcrumb (`.claude/session-breadcrumb.md`) surfaced by a SessionStart resume-check, so the record itself doesn't have to double as the autosave.

**Generalized lesson:** "one record + projections" is the durable invariant; *which artifact holds the record* is an instantiation detail that should track what actually exists (a doc when there's no machine store, the substrate once there is) — don't hard-code the record's home into the pattern, and don't emit a "degraded" apology for the absence of infrastructure that was never required to be present. See [[cross-harness-credential-second-location-race-generator]] for the sibling "don't force one policy on all consumers" move.
