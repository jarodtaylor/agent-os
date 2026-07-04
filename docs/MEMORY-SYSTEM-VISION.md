# Agent OS — Memory System Vision (draft)

> **Status:** early sketch, captured 2026-07-01. **Source:** Jarod's NotebookLM synthesis
> (Karpathy's LLM-Wiki, the "Infinite Brain," Google's Open Knowledge Format, Pinecone vector recall).
> Not yet fully talked through. **NotebookLM connected 2026-07-01** (`notebooklm` CLI + skill,
> auth verified) — deepen this doc by pulling from notebooks "AI Second Brain" (`ba4b1af4…`),
> "AgentOS" (`0db2b38d…`), and "Claude, Hermes, and NotebookLM" (`7d55c036…`) when the
> memory-architecture phase (v1.1) starts.
>
> This is the **"unified memory" anchor** of the Agent OS and, in my (CTO) view, the strongest
> candidate for its **headline feature** — the equivalent of what the Dream engine is to a studied template.
> The goal: a single **"Agent Brain" shared by all of Jarod's agents** (Claude, Codex, Hermes, OpenClaw).

## The vision: a 4-layer Agent Brain

| Layer | Role | Substrate | Notes |
|---|---|---|---|
| **L1 — Identity & Schema** (short-term) | Who the agent is, how it behaves, **routing rules** | Root config: `CLAUDE.md` / `AGENTS.md` / `gemini.md` | Pre-filled into every conversation. Tells the agent *"strategic Q → wiki; history/quotes → vector DB."* |
| **L2 — Active Brain** (mid-term / write-time) | Procedural + semantic memory; reasoning & active project work | **OKF-compliant Markdown wiki** | 6–8 flat project folders, each with its own operating manual + `index.md` (progressive disclosure). Atomic notes (50–300 lines), **typed links** (why files connect), YAML frontmatter (`type`/`tags`/`description`). |
| **L3 — Deep Archive** (long-term / runtime) | Episodic memory — immutable/oversized records | **Vector DB (Pinecone)** | Emails, transcripts, PDFs, YouTube. Semantic search at runtime; **namespaces** ("emails", "youtube") to scope queries. Retrieve paragraphs, not books. |
| **L4 — Ingestion & Maintenance** (the OODA loop) | Feed the brain and keep it clean | Pipelines + agent skills | Automated intake (Granola, email, Slack, NotebookLM-as-researcher). **"Wrap-Up" skill**: extract decisions → L2 wiki, dump raw log → L3 vector. **Lint** pass (broken links / orphans / contradictions). **Wagers** (record a prediction when strategy changes, verify later). |

## Architect's reactions (CTO notes)

1. **The write path is the product — not the read path.** The brain's quality is bounded entirely by
   L4. The **"Wrap-Up" skill is the single highest-leverage component**: it's what turns raw activity
   into curated truth. a studied template *observes* memory (pretty read-only visualization) but has **no write path** — this is
   exactly where our version wins.
2. **Re-cut the layer axis from *time-horizon* to *mutability + latency + cost*.** The sharp L2/L3 test:
   *is this curated truth I will edit* (→ L2) or *an immutable record I will retrieve* (→ L3)? Resolves
   ~90% of "where does this go?" ambiguity.
3. **Routing is the hard, under-specified part.** Hand-written "wiki for strategy, vector for quotes"
   rules in L1 are brittle. The real fork: **agent-driven retrieval** (flexible, unreliable, token-heavy)
   vs. a **deterministic retrieval orchestrator** (reliable, rigid) vs. **hybrid**. *This is THE
   architectural decision for the memory system.*
4. **graphify *is* the L2 tooling.** OKF + atomic notes + typed links + frontmatter is exactly graphify's
   input. Running it over the wiki gives navigation (god nodes, communities, path queries) **and**
   structural linting (orphans, cycles, weak links) for free — half of the L4 "lint" pass is a graphify run.
5. **Expose the brain as an MCP server.** Clean answer to "brain for *all* my agents" (they all speak MCP)
   **and** it's the remote-ready seam — a network-transparent memory interface means a future VPS agent
   hits the same endpoint as local ones. Memory + MCP + the runtime abstraction converge on one interface.
6. **Protect the Wagers.** Prediction-on-change + later verification makes the brain *self-correcting* —
   rare and differentiating. Needs a **metric substrate** (what's measured, how) to be real; that's the hard part.
7. **Watch layer drift.** L2 (curated) and L3 (raw) *will* contradict over time. Linting catches broken
   links, not semantic contradictions between layers. Need a **precedence rule**: curated wiki = "what's
   true now"; vector = "what was said/happened." (Same drift failure as the template's untyped contract,
   at larger scale.)
8. **NotebookLM = a *source*, not a runtime dependency.** Ingest its synthesized findings into *our*
   layers (L2 + L3). Don't let the brain depend on a closed system we can't fully script. Own the data.
9. **Wrap-Up ≠ handoff (Jarod, 2026-07-01).** The *handoff* is a continuity cursor ("pick up here,
   next session"); the *Wrap-Up* is knowledge extraction (decisions → L2 wiki) **plus** the full raw
   conversation log → L3 vector. Slice 1's substrate ships the handoff lane + an automatic raw
   breadcrumb trail — the same two-lane hybrid shape at seed scale, so the full Wrap-Up *deepens* the
   substrate later instead of replacing it.
10. **L3 doubles as OS substrate (Jarod, 2026-07-01).** The raw vector archive isn't only memory —
    full session logs in Pinecone (or another vector DB) become fuel for later Agent OS
    observability, planning, and eval features. Capture once, exploit many ways.

## Open decisions to resolve (when we go deep)

- [ ] **Routing model** — agent-driven vs. deterministic orchestrator vs. hybrid (note #3).
- [ ] **Write-path / Wrap-Up contract** — exactly what the wrap-up extracts, and the **L2↔L3 precedence rule** (note #7).
- [ ] **Wagers metric substrate** — what a "prediction" is measured against (note #6).
- [ ] **Interface** — confirm MCP-server-as-memory as the shared, remote-ready contract (note #5).

## Connections to the rest of the Agent OS

- Feeds the **"unified memory / knowledge" anchor** and overlaps the **context-engineering** frontier
  stream (retrieval, budgeting, memory injection) — I'll fold this vision into the feature slate when it lands.
- The **MCP interface** ties memory to the **plugins/MCP**, **A2A**, and **remote-runtime** seams.
