# Decision Log — agent-os

The anti-drift ledger. Every decision + **why** + **which intent it serves**. Read this to see what's locked vs. still open. (Attempt #1 was abandoned to drift; this file is the guardrail.)

## Intent anchor (the north star we measure against)
> A local Agent OS that **acts** on my stack — one place to see and control all my agents, skills, tools, and context — with a shared **memory/brain** as the piece I most want.

**Canonical:** [`STRATEGY.md`](../STRATEGY.md) is the formal North Star. The quote above is the working-form restatement.

## Decisions made

| # | Date | Decision | Why | Intent served |
|---|---|---|---|---|
| 1 | 2026-07-01 | **North-star-first.** Establish + architect around the vision before choosing build order. A/B/C are **buckets of functionality**, not competing flagships. | Attempt #1 died from building before intent was clear. Understanding the north star first gives a foundation all buckets hang off. | Anti-drift; keep the build true to *why* he started. |
| 2 | 2026-07-01 | **Scope = "Rung 2":** a *local* control plane (one machine), but with the two seams built **remote-ready** so remote runtimes ("Rung 3") are a later extension, not a rewrite. | Remote is a real future want, but building it now is premature; shaping the seams now makes it cheap later. | "Acts on my stack" now; remote optionality preserved. |
| 3 | 2026-07-01 | **Migrate to `~/Code/personal/agent-os`;** treat "a studied template" as a **disposable reference** (pointer + distilled docs only, no code ported). | The template is inspiration, not a base. Distillation (teardown + graph) carries ~95% of its value. | Clean home, no template baggage. |
| 4 | 2026-07-01 | **Methodology = compound-engineering** (`ce-strategy` → `ce-brainstorm`/`ce-plan` → `ce-work`). | Jarod's proven workflow across projects; methodical strategy → plan → build. | Structure that resists drift. |
| 5 | 2026-07-01 | **North Star formalized** in [`STRATEGY.md`](../STRATEGY.md) (repo root, canonical). START-HERE and this log now point to it; other restatements should reference it, not diverge from it. | `ce-strategy` complete. The working-form anchor lived in ~4 places; one canonical doc stops the copies diverging. | Anti-drift: a single source of truth for *why* we're building. |
| 6 | 2026-07-01 | **Coordination stays its own track** (not folded into Observe+Control). | Jarod: "it'll drift out of Control as we dig in" — orchestration/autonomy ≠ a read/act control surface. | Clean seams; keeps the orchestration bet visible instead of buried. |
| 7 | 2026-07-01 | **Two-user model:** Jarod as operator **+** the agents as autonomous machine consumers of the substrate. | The brain/board must be agent-legible (MCP-native, typed), not just a human dashboard — this is *why* there are two seams. | Serves "acts on my stack" + the shared-brain intent; substrate built for machines, not only a UI. |
| 8 | 2026-07-01 | **Session handoffs feed the canonical record.** `/handoff` project skill updates `START-HERE.md` + `DECISIONS.md` (clean boundary) or a gitignored `docs/HANDOFF.local.md` (mid-work) — never a parallel "next session" block. | Operationalizes #5: continuity across contexts/agents without a competing state doc. Adapted from Jarod's cadre handoff skill. | Anti-drift is THE risk (attempt #2); a clean cross-session handoff keeps intent continuous. |
| 9 | 2026-07-01 | **Slices sequence the North Star; they never shrink it.** Anything excluded from a slice must appear in that plan's "Deferred, not cut" section with the trigger that promotes it. No brainstorm/plan may silently drop a North Star capability. | Jarod: lean cuts were starting to feel like stripping the product down to the easiest path — the exact discouragement pattern that makes him walk away from projects. | Anti-drift **and** anti-discouragement: slices stay small while the full vision stays visible and scheduled. |
| 10 | 2026-07-01 | **Slice 1 = the "parity-enabling cut":** Brain/board substrate seed (agents = primary consumer, Jarod secondary) + unified read inventory across all 4 runtimes (skills/MCP/plugins) + cross-runtime parity actions ("make skill/MCP X available in harness Y"). Run-steering and context inspector deferred **with promotion triggers** per #9. | O+C pains are *anticipated, not lived* — Jarod avoided multi-agent work because nothing centralized projects across harnesses. Slice ranked by "what un-collapses the team," not by lived pain. Consistent with the flagship-fork lean; does NOT close the ce-plan forks (build order, native writes). | "Acts on my stack" + the shared-brain wedge; keeps #6's Coordination boundary clean. |

## Open — deliberately deferred (do NOT decide until the phase that owns them)

These surfaced during design (the "6 forks") but are premature to lock. Parked here so they stay **visible, not lost**:

| Fork | Decide during | Current lean (NOT locked) |
|---|---|---|
| **Flagship / build order** (which bucket ships first) | `ce-plan` | A (observe+control) as first *visible* bucket; B (Dream) as its first act; C (brain) substrate built alongside, full brain = v1.1. |
| **Deployment model** (local / installable / sync-ready) | `ce-strategy` / architecture | Local `Bun.serve`, sync-ready interfaces. |
| **Which runtimes get native writes in v1** | `ce-plan` | Claude Code + Codex native; Hermes/OpenClaw read-only in v1. |
| **First real remote adapter** (vendor-cloud vs. own machine) | Rung 3 planning | Vendor-cloud first. |
| **Memory routing model** (agent-driven / orchestrated / hybrid) | Memory architecture (post-NotebookLM) | Hybrid (brain exposes retrieval as MCP tools). |
| **Substrate-first vs. thin vertical slice** | `ce-plan` | CTO lean: thin vertical slice (one runtime, one action, one write, end-to-end) before broadening. |

## How to add a decision
Append a row to **Decisions made** with the date, the decision, the **why**, and the **intent served**. If it closes an open fork, move that fork out of the deferred table and cite the decision number.
