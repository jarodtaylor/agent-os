# Agent OS — Product Map

> **For humans.** Plain language, outcomes first, short on purpose. The deep/agent-grade state lives in [`START-HERE.md`](START-HERE.md) + [`DECISIONS.md`](DECISIONS.md); this page is their product-level projection.
> **Freshness rule:** `/handoff` updates this page whenever something ships. If this page and reality ever disagree, that's a bug — flag it.

_Last updated: 2026-07-20 · Status: **v0.1 "Continuity" in progress — 11 of 15 units shipped**; latest: **U10 planned** — the provisioning engine's build plan is ready and review-hardened, all review findings folded (decision #52). Next: **build U10**. · Roadmap postures locked by the 2026-07-10 interview (decisions #32–#41)_

## TL;DR

- **Problem.** I run a dozen AI harnesses — Claude Code, Codex, Hermes, Cursor, Antigravity, and more. Each is powerful; none of them share anything. Every session starts cold, I re-explain myself constantly, and juggling terminals is heavy enough that I collapse back to just Claude Code — and lose the team.
- **Bet.** **Connect, don't replace.** Agent OS is local-first connective tissue: one shared memory + one control surface every harness plugs into, so my agents act like a co-located team. Hard line: we never build or fork our own harness.
- **Today.** The foundation works: **Claude Code and Codex write to one shared "where did we leave off?" memory.** A fresh Claude Code session picks up automatically — nothing pasted (ran live 2026-07-08). Codex is wired the same way; its live check lands with the always-on server (U15). No screens yet; everything so far is deliberately under the floorboards.
- **Next (rest of v0.1).** See the whole stack in one place (every skill/MCP server/plugin across harnesses), fix gaps in one click with undo, the **first actual screen**, and an always-on server.
- **The headline act — the Agent Brain (real memory: wiki + long-term recall + auto-ingestion) — is designed, not built.** v0.1 is its foundation; building the Brain proper is the next big phase.

## The four tracks (the whole vision, one glance)

| Track | In plain words | Status |
|---|---|---|
| **1 · The Agent Brain** | One shared memory all agents read/write: I dump raw input; agents curate, relate, and resurface it at the right moment | Foundation **✅ built** (v0.1) · memory layers **✦ designed, not built** |
| **2 · Observe + Control** | See every agent/skill/tool across harnesses — and *act*: install, toggle, run, hand off | **▶ in progress** (second half of v0.1) |
| **3 · Coordination** | One task board across harnesses + Hermes as always-on chief-of-staff dispatching work to the right agent | **✦ designed at track level** · not started |
| **4 · Self-Improvement Loop** | Watch the metrics, prescribe + run the highest-leverage next actions (Dream-style audit) | **· not started** (needs 1–3 running) |

**How we'll know it's working** (metrics from [`../STRATEGY.md`](../STRATEGY.md)): repeat-yourself count → 0 · share of agent sessions that actually hit the shared brain · real work driven as a team vs collapsing to one terminal · moments the brain resurfaces something that changes a project's direction.

## What works today (demo-able on this machine)

- ✅ **A fresh Claude Code session knows where you left off** — open it; the context is just there. *Ran live on the real machine 2026-07-08 (installed, verified end-to-end, then cleanly uninstalled until the always-on server lands at U15).*
- ✅ **`/handoff` writes ONE authoritative record** of "where we left off" per project; the human docs render that record instead of competing with it.
- ✅ **Codex is on the same shared memory** — same capture, same read tools, its own revocable credential. *Code + tests done; the live end-to-end check waits on the always-on server.*
- ✅ **Crash-safe breadcrumbs** — every session automatically leaves a trail of what it did; a spike proved a cold agent can resume real mid-flight work from the trail alone.
- ✅ **Marked secrets can't leak out** — every read path (agent tools, HTTP, the future UI) passes one redaction gate that masks anything marked secret. Security-reviewed; clean bill on outbound leak paths. (Scope honesty, per decision #25: the gate makes reads *non-leaky* — what's marked is what's masked.)
- ✅ **Config safety** — Agent OS edits harness configs (hooks, MCP entries) with backup → atomic write → undo journal. It has run against the real `~/.claude` and restored it byte-perfect.
- ✅ **See what every harness has installed** — a typed inventory of skills / MCP servers / plugins across Claude Code + Codex (the Observe half; further harnesses join as one-line registry rows as they enter rotation). *Shipped U9, PR #38.*
- ✅ **Locked to this machine** — the server answers only local callers holding a per-boot token; single-instance enforced at the OS level.

## Release map

> _Naming map: this page's **v0.1** = "slice 1" / "v1" in the engineering docs; their "**v1.1**" = the **Memory** phase below._

### v0.1 — "Continuity" *(now · 11 of 15 units shipped · **committed** — unit-backed)*

**Problem it solves:** resuming work = archaeology (which CLI touched this last? what was in flight?), and re-explaining context to every agent. That overhead made multi-agent work not worth it.

**The demo when it ships:** *either wired harness (Claude Code or Codex), any project — open it and it knows where you left off, even after a crash. Plus one screen: every project's state + the full skills/MCP inventory across harnesses, with one-click propagation. (The rest of the roster joins after the U12 spike maps their surfaces.)*

**Recently shipped:** **U9** inventory scanners (PR #38 — the Observe half) · **#21** config-engine targeted removal (PR #34) · **#24** single-source Codex credential (PR #41 — retired the duplicate token file). *(#21/#24 are follow-up issues, not among the 15 plan units.)* Also **dogfood run 1** (below) — a validation exercise, not a v0.1 unit.

**Still to build:**
- **U10 (next up, plan ready) — project provisioning:** a project carries one versioned "blueprint" (which roles run in which harness, on which model, with which files), and agent-os pushes it into Claude Code, Codex, and Cursor natively — reversibly, with a dry-run preview and a drift report. Rescoped from the earlier "parity actions" framing by lived dogfood evidence (decision #52).
- **U11 — the first screen:** projects + where-they-left-off + the inventory grid + provision buttons.
- **U12 — roster spike:** find the read/write surfaces for Hermes / Cursor / Antigravity / OpenCode (decides their lanes).
- **U15 — always-on:** server survives reboots/crashes (launchd); hooks re-install for keeps; the pending live Codex check runs then.

### The next two phases — **order decided** (decision #38): Memory, then Coordination *(each phase's scope stays open until its own scoping session)*

**Memory — building the actual Brain.**
*Problem: agents now remember where we left off — but not what we know, decided, and learned.*
The 4-layer design ([`MEMORY-SYSTEM-VISION.md`](MEMORY-SYSTEM-VISION.md)):
- **L1 — identity & routing:** who each agent is + where to look things up (the CLAUDE.md/AGENTS.md tier).
- **L2 — the wiki:** curated knowledge — atomic markdown notes, typed links (graphify is the tooling).
- **L3 — the deep archive:** vector search over transcripts/emails/docs (Pinecone-class).
- **L4 — the ingestion loop:** the "Wrap-Up" that turns raw activity into curated knowledge and keeps the brain clean.

CTO view: **L4, the write path, is the real product.** Status: vision sketch + open forks (biggest: how retrieval routing works); the NotebookLM notebooks are connected and ready to mine when this phase starts.
**Proof when it ships:** ask any harness something whose answer lives in work I did months ago — it answers from the brain, citing the source.
**Trust posture decided** (decision #35): agent-written by default + provenance + rollback + the precedence rule; human review = a flagged-entries *lens*, never a gate; and the brain is **agent-first** — agents own the organization, Jarod consumes answers. Still open for the design phase: correction/deletion mechanics, per-project boundaries, retrieval routing.

**Coordination — driving the team.**
*Problem: I can see the team but can't drive it as one.*
A shared task board across harnesses *and* instances, plus Hermes as the always-on chief-of-staff: it plans, dispatches to the right harness (e.g. Claude as architect, Codex as execution, another for docs/QA), and tracks it all on the board. Braindump items to fold in when this gets scoped: the Hermes chief-of-staff pattern and evaluating **Herdr**. (The braindump's *observability* items — per-harness auth/online status + one-click re-login, token usage, context-hog skill detection — belong to **Observe + Control** scoping instead.) Status: track-level only — scoping happens at its own `ce-brainstorm`.
**Proof when it ships:** one real multi-harness workflow — research or content counts, not just coding — planned, dispatched, and tracked end-to-end.
**Gate:** the Observe + Control slice ships first; dispatch isn't trustworthy until Agent OS can see what's installed/online and act reversibly.
**Early proof (2026-07-20, decision #48):** a manual "dogfood" run drove one real multi-harness coding workflow end-to-end on a live project (`agent-cost-tracker`) — Claude plan → Codex execute → Claude review → Cursor QA gate → PR → merge. n=1 and mechanical (didn't test output quality or multi-run continuity), but it proved the loop runs and produced the friction log that grounds the U10 provisioner's spec.

### Later — **vision** (directional, not yet scoped)

- **Compounding** — the self-improvement loop (Track 4): usage-driven prescriptions, skill dedup, cross-agent evals.
- **Rung 3 — remote** — drive agents on other machines / a VPS. The seams are already built remote-ready; deliberately not now.

### Parked / not doing

- **Replacing or forking harnesses — never.** That's the hard line.
- **OpenClaw** — dropped from the roster (2026-07-02).
- **Productizing** — this is a personal OS; the public repo is a build-in-public journal, not a supported product.
- A handful of engineering edge-cases deliberately deferred with promotion triggers — tracked as [GitHub issues](https://github.com/jarodtaylor/agent-os/issues) labeled `deferred`.

## Glossary (backend words, translated)

| Term | Meaning |
|---|---|
| **Harness** | Any agent CLI/app (Claude Code, Codex, Hermes…). We connect them, never rebuild them. |
| **Substrate** | The v0.1 plumbing: local server + database + typed schema + agent-callable tools. The floor everything else stands on. |
| **The Brain** | The 4-layer memory system (designed, not built). Today's substrate is its brainstem — working memory + reflexes; the knowledge layers come next. |
| **MCP** | "USB-C for agents" — the standard plug harnesses use to call tools. Build the brain as an MCP server once → every harness can use it. |
| **Handoff / cursor** | The single "where we left off" record per project — today `START-HERE.md` ▶ NEXT; becomes a machine record (the substrate) at U15 (decision #51). |
| **Breadcrumbs (raw lane)** | The automatic trail of what each session actually did. Survives crashes; future Brain-L3 fuel. |
| **Redaction gate** | The one choke-point every read passes through; masks secrets before anyone — agent or human — sees them. |
| **Parity** | "Skill X exists in harness A but not B" → detect it, fix it in one click, undo-able. |
| **Seam** | A deliberate interface built so later phases extend the system instead of rewriting it (the typed contract; the runtime adapter). |
| **Felt checkpoint** | A milestone you *experience* (a session resumes itself), not just tests passing. |

## U-number decoder ring

| Unit | Plain name | What it gives you | Status |
|---|---|---|---|
| U13 | Resume spike | Proved a cold agent can resume real work from the raw trail — the bet the substrate rests on | ✅ |
| U1 | Typed contract | The shared language every component speaks (one schema) | ✅ |
| U14 | Config-write engine | Never brick a config: backup → atomic write → undo (#21 extends it next) | ✅ |
| U2 | Store | The local database (SQLite) holding all shared state | ✅ |
| U3 | Server | One local process, locked to this machine (loopback + token) | ✅ |
| U4 | Brain MCP + redaction | Agents read work-state as a tool; secrets masked on every path | ✅ |
| U5 | Claude Code capture | CC sessions leave breadcrumbs automatically | ✅ |
| U6 | CC consumption | A fresh CC session auto-loads "where was I" + marks clean endings | ✅ *lived 7/8* |
| U7 | `/handoff` rewire | One authoritative continuity record; docs render it | ✅ |
| U8 | Codex integration | Second harness on the shared brain (capture + read + installer) | ✅ *live check pending* |
| U9 | Inventory scanners | See every skill/MCP server/plugin across harnesses — CC + Codex now; others join as one-line registry rows as they enter rotation | ✅ *PR #38* |
| U10 | Provisioning engine | Blueprint → native harness setup (roles/models/files), with undo | ⏳ plan ready |
| U11 | Thin human view | The first screen | ⏳ |
| U12 | Roster lane spike | What's possible for Hermes / Cursor / Antigravity / OpenCode | ⏳ |
| U15 | Always-on (launchd) | Server survives reboots; hooks installed for keeps; live Codex check | ⏳ |

## Dig deeper

- [`START-HERE.md`](START-HERE.md) — live project state (agent-grade; the "you are here").
- [`DECISIONS.md`](DECISIONS.md) — every decision, its why, and the open forks.
- [`plans/2026-07-01-001-feat-slice-1-substrate-parity-plan.md`](plans/2026-07-01-001-feat-slice-1-substrate-parity-plan.md) — the full v0.1 plan.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the whole-system technical map.
- [`MEMORY-SYSTEM-VISION.md`](MEMORY-SYSTEM-VISION.md) — the Brain design.
- [`../STRATEGY.md`](../STRATEGY.md) — the North Star.
- **Visual map** — the [product & architecture artifact](https://claude.ai/code/artifact/cfc30269-a3b2-4943-9e13-bfbe618b5ba8) (Jarod's private working snapshot, refreshed at phase boundaries — **nonessential**: everything it shows is in this page + [`ARCHITECTURE.md`](ARCHITECTURE.md)).
