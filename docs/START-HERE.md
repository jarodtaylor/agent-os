# START HERE — agent-os

> New session (human or AI)? Read this first. It's the fastest path to *"I know what's going on."*
> You should **not** need to re-read the whole repo to be productive — this doc + `DECISIONS.md` are the state.

## What this project is
Jarod's own **Agent OS**: a local-first personal control plane that **acts** on his AI stack — see + control all agents / skills / tools / context in one place — with a shared **memory/brain** for all his agents. Greenfield, for his own daily use. Inspired by, **not** a port of, the "a studied template" template (distilled in `docs/reference/studied-template/`).

## Intent anchor (north star, working form)
> A local Agent OS that **acts** on my stack — one place to see and control all my agents, skills, tools, and context — with a shared **memory/brain** as the piece I most want.

**Canonical North Star: [`STRATEGY.md`](../STRATEGY.md)** (formalized 2026-07-01). The quote above is the working-form restatement.

## The vision so far
**Three buckets of functionality** — all in scope, none cut:
- **A. Observe + Control** — see every agent/skill/tool/context across runtimes, and *act* on them (install / toggle / run / hand off). The "acts, not observes" core.
- **B. Daily prescription** — a Dream-style audit that prescribes *and runs* the highest-leverage actions.
- **C. The Agent Brain** — a shared 4-layer memory across all agents (Jarod's headline interest — see `MEMORY-SYSTEM-VISION.md`).

**The architecture that serves all buckets** (this *is* "architecting around the north star"):
- **Seam #1 — typed data contract** (one zod schema, producer + consumer).
- **Seam #2 — runtime/agent abstraction** (one adapter interface every runtime implements).
- **Shared-state substrate** — a local **MCP Gateway** (all runtimes point at it; hosts the brain-as-MCP-server) + a **Task Board** (blackboard coordination). The brain = shared state behind the gateway.

**Scope decided: "Rung 2"** — a *local* control plane on one machine, but with those two seams built **remote-ready**, so driving agents on other machines / a VPS later ("Rung 3") is an *extension*, not a rewrite.

## Where we are RIGHT NOW
- ✅ **Understand + Design + Migrate + `ce-strategy`** (2026-07-01) — teardown distilled, slate + memory vision written, North Star canonical in [`STRATEGY.md`](../STRATEGY.md).
- ✅ **`ce-brainstorm`** (2026-07-01) — slice 1 scoped: the **"parity-enabling cut"** (Brain/board substrate seed, agents-primary + 4-runtime inventory + parity actions). Decisions #9 (slices sequence, never shrink) and #10 logged.
- ✅ **`ce-doc-review` ×2** — requirements hardened by a 6-reviewer panel (8 fixes), plan hardened by a 5-reviewer round-2 panel (11 findings walked through and applied: capture-time redaction, token model, in-process capture, session-keyed handoffs, U13/U14/U15).
- ✅ **`ce-plan`** (2026-07-01) — **implementation-ready plan: [`docs/plans/2026-07-01-001-feat-slice-1-substrate-parity-plan.md`](plans/2026-07-01-001-feat-slice-1-substrate-parity-plan.md)**. Forks closed by decision #11: thin vertical slice · Claude Code + Codex writes · **Brain seed is the v1 flagship**.
- ⏳ **Next: `ce-work` on the slice-1 plan.** Start with **U13** (throwaway resume spike — it *gates* Phase A: validate trail-resume + injection quality before building anything). Branch off fresh `main` (`feat/slice-1-substrate`); code era begins → feature branches + PRs from here on (docs-to-main exception is over). KTDs 1–9 are decided — don't re-litigate.

## Read next (in order)
1. `docs/plans/2026-07-01-001-feat-slice-1-substrate-parity-plan.md` — THE plan (scan headings: Goal Capsule → unit index → U13).
2. `docs/DECISIONS.md` — decisions 1–11 locked; 3 forks still open (deployment, remote adapter, memory routing).
3. `docs/FEATURE-SLATE.md` / `docs/MEMORY-SYSTEM-VISION.md` — design grounding.
4. `docs/reference/studied-template/the rebuild notes.md` — the distilled borrow/fix/cut lessons.

## Open threads
- ✅ **NotebookLM connected** (2026-07-01) — `notebooklm` CLI authenticated + skill installed (`~/.claude/skills/notebooklm`); 11 notebooks verified. Memory-relevant: **"AI Second Brain"** (`ba4b1af4…`), **"AgentOS"** (`0db2b38d…`), **"Claude, Hermes, and NotebookLM"** (`7d55c036…`). This unlocks the v1.1 Brain deepening + the memory-routing fork — pull the sources when the memory architecture phase starts (not during slice-1 build).
- **U12 spike** owns OpenClaw/Hermes lane discovery (capture/consumption + Hermes 9119 write surface) — findings land in DECISIONS.md.
- **3 remaining deferred forks** (deployment model, first remote adapter, memory routing) — see `DECISIONS.md` open table.
- **Codex hit-rate** is the measured bet: if AGENTS.md-pointer consumption is weak, investigate Codex `features.hooks` in v1.1.

## Continuity note
Migrated from `~/Code/personal/studied-template` on 2026-07-01. The original Claude Code session that produced all this may still be open as a fallback backstop. If anything here is unclear, that session (or the studied-template project transcript/memory) is the deep backup — but this doc + `DECISIONS.md` should be enough.

**Session wrap-up:** run `/handoff` (project skill) to write the durable handoff — it updates *this doc* + `DECISIONS.md` at a clean phase boundary, or drops a mid-work cursor into gitignored `docs/HANDOFF.local.md`.
