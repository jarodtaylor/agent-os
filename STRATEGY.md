---
name: Agent OS
last_updated: 2026-07-01
---

# Agent OS Strategy

## Target problem

I run a dozen AI harnesses — Claude Code, Codex, Hermes, Antigravity, Cursor, Minimax, OpenClaw and more — each powerful on its own but walled off from the others. They share no memory, so I re-explain my ways-of-working and ADHD needs to every one and each starts cold; there's no shared surface, so work can't be tracked or evaluated across them; and juggling that many terminals overloads my ADHD, so I collapse back to just Claude Code and lose the team. The crux: my agents are a team that can't act like one, because nothing connects them.

## Our approach

**Connect, don't replace — with shared memory as the wedge.** Agent OS is the connective tissue over the harnesses I already use: a thin control plane plus a shared brain that every agent plugs into, so they act as one co-located team while each keeps its own best-in-class harness. The hard line that makes this a choice and not a wish: I never build or fork my own agent harness.

## Who it's for

**Primary — Jarod, the operator.** A solo builder with ADHD running a team of AI agents across a dozen harnesses. I'm hiring Agent OS to give those agents one shared brain and one shared work surface, so I can drive them as a co-located team — without repeating myself, juggling terminals, or collapsing back to just Claude Code.

**Secondary — the agents themselves, as autonomous operators.** Claude Code, Codex, Hermes and the rest are machine consumers of the substrate: they read and write the shared brain and task board without me relaying by hand. This is why the brain and board must be agent-legible — MCP-native and typed — not just a human dashboard. (Example: I dump raw input; the agents curate, relate, and resurface it at the right moment.)

## Key metrics

_Inputs to the Self-Improvement Loop (Track 4), not just a scoreboard. Three of the four are self-tracked / qualitative today; making them machine-legible is itself Brain/Loop work._

- **Repeat-yourself count → 0** — how often I re-explain ways-of-working / ADHD needs / project context to an agent that should already know. Self-tracked, later instrumented.
- **Shared-brain hit rate** — fraction of agent sessions (any harness) that actually read/write the brain vs. run cold. From the MCP gateway.
- **Team, not terminal** — share of real work driven as a coordinated team through Agent OS vs. collapsing to solo Claude Code. Behavioral / self-tracked.
- **Brain payoff moments** — rate at which the brain resurfaces something I'd forgotten that changes a project's direction. Self-tracked / qualitative.

## Tracks

### The Agent Brain

Shared memory across all agents: I dump raw input; agents curate, relate, dedup, and resurface it at the right moment (the LLM-wiki pattern). Agent-legible and MCP-native.

_Why it serves the approach:_ it *is* the wedge — the piece I most want, and what makes the team compound instead of start cold.

### Observe + Control

See and *act on* every agent, skill, tool, and context across harnesses — install, toggle, run, hand off. The adapters and gateway that surface the whole stack in one place.

_Why it serves the approach:_ makes the team visible and drivable — "connect" made real.

### Coordination

One task board across harnesses *and* instances (fixing the single-gateway Hermes-Kanban silo), plus the Hermes-flavored chief-of-staff that plans, dispatches, and drives work autonomously.

_Why it serves the approach:_ the shared work surface + orchestration that let the agents act as one team, not parallel soloists.

### The Self-Improvement Loop

Watch the KPIs and turn them into action: surface Skill opportunities from repeated asks, dedup, run cross-agent evals, and prescribe the highest-leverage next actions (Dream-style).

_Why it serves the approach:_ makes the connected team *compound* over time, not just co-locate.

## Not working on

- **Replacing or forking any agent harness.** Connect, don't compete — the harnesses are built by big, well-funded teams; Agent OS wraps them, never rebuilds them.
- **Remote / multi-machine control (for now).** Rung 2 is local-first on one machine; the two seams are built remote-*ready*, but driving agents on other machines / a VPS is Rung 3 — a later extension, not v1.
