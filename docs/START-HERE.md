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
- ✅ **Understand** the reference (teardown → `docs/reference/studied-template/`).
- ✅ **Design** — ranked feature slate (`docs/FEATURE-SLATE.md`) + memory vision (`docs/MEMORY-SYSTEM-VISION.md`).
- ✅ **Migrated** into this repo from the studied-template study folder (2026-07-01).
- ✅ **`ce-strategy`** — North Star formalized in **[`STRATEGY.md`](../STRATEGY.md)** (repo root, canonical) — 2026-07-01.
- ⏳ **Next: architecture + per-bucket `ce-brainstorm`/`ce-plan`** → `ce-work` (build). **Build order deferred on purpose.**

## Read next (in order)
1. `docs/DECISIONS.md` — what's locked, what's still open.
2. `docs/FEATURE-SLATE.md` — the slate + the two seams (§2) + MCP-gateway/A2A integration (§7).
3. `docs/MEMORY-SYSTEM-VISION.md` — the Agent Brain design + its open decisions.
4. `docs/reference/studied-template/the rebuild notes.md` — the distilled borrow/fix/cut lessons.

## Open threads
- ✅ **North Star** formalized → [`STRATEGY.md`](../STRATEGY.md) (2026-07-01). Next: architecture + per-bucket planning.
- **NotebookLM** not yet connected to Claude — the memory system deepens once it is (Jarod has extensive memory research captured there).
- **The 6 forks** (flagship/build-order, deployment, native-write runtimes, first remote adapter, memory routing, substrate-vs-vertical-slice) are **deferred** to strategy/planning — see `DECISIONS.md`.

## Continuity note
Migrated from `~/Code/personal/studied-template` on 2026-07-01. The original Claude Code session that produced all this may still be open as a fallback backstop. If anything here is unclear, that session (or the studied-template project transcript/memory) is the deep backup — but this doc + `DECISIONS.md` should be enough.
