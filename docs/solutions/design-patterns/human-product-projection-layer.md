---
module: docs
tags: [product-docs, adhd-communication, anti-drift, projections, handoff]
problem_type: process-design
---

# The human/product projection layer — keep the owner aligned without a second source of truth

## Problem

Nine units into the build, every doc (START-HERE, DECISIONS, the plan) was agent-grade: unit IDs, KTD references, dense state lines. The project's human owner — the person setting direction — could no longer say what had been built, what "Brain" meant, or what the roadmap was ("WTF did we build?"). On a project whose predecessor died to drift, owner-invisibility IS drift: you can't anchor to an intent you can't see.

## Solution

Add a **product-level projection** of the same authoritative record, never a parallel source:

- **`docs/PRODUCT.md`** — TL;DR-first, plain language: the four tracks at a glance · "what works today" as demo-able outcomes · a release map with **committed / candidate / vision** labels and a one-line **proof-when-it-ships** per release · a glossary translating the backend words · a **decoder ring** mapping internal unit IDs to plain-name + outcome + status.
- **Maintenance is structural, not aspirational:** the `/handoff` skill updates it whenever the projected cursor or release map changes (ships, reorders, decision-only handoffs) — so it cannot rot.
- **Evidence gates:** status flips require evidence (merged PR / lived check); scope, sequencing, or strategy changes require a DECISIONS row to cite. A transient session can never rewrite the roadmap on its own authority.
- **The two-tier contract (decision #32):** the durable record stays deep and complete (ledger, plans, memories); the owner-facing surface stays concise and bulleted **with links down to the depth**. Neither layer substitutes for the other.

## Why it works

The one-record rule (machine cursor authoritative, docs are projections) already prevented agent-side drift; this extends the same shape to the human side instead of inventing a competing doc. Review it like code: a same-model gap pass caught 12 overclaims/inconsistencies, and a **cross-model pass caught what same-model reviewers kept missing** (commitment-labeling, proof scenarios, sequencing gates) — different priors see different holes.

## When to reach for it

Any long-running agent-driven project with a human owner who isn't reading the working docs. Trigger sign: the owner asks "what did X actually deliver?" about something the docs mark ✅. Build the projection THEN — and wire it into the existing wrap-up ritual the same day, or it becomes the next stale doc.
