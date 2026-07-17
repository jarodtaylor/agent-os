# Dogfood block scoping — `agent-cost-tracker` (the multi-harness reference run)

> **Status: SCOPED 2026-07-16 (decisions #44/#46 + the five calls below, all Jarod-ratified).**
> Execution happens in a fresh session — this doc is the handoff. It is the spec for the
> **dogfood-project block** that precedes U10: scaffold a real project, run one SDLC pass across
> three harnesses manually via Herdr, and capture the friction. The hand-authored setup is the
> **reference spec the U10 provisioner must generate**; the friction list feeds the MVP-definition
> session (before/at U11). Grounding: `docs/STAGE-MANAGER-VISION.md` (esp. §Refinement — the dogfood
> needs a scaffolded project first) and decision #46.

## The governing principle — agent-first SDLC (Jarod, 2026-07-16)

Jarod has not used QA agents in 2+ years of agentic development; the workflow below is deliberately
shaped like a classic human SDLC **as a starting hypothesis, not a requirement**. The dogfood tests
whether an agent-first system keeps, collapses, reorders, or merges these phases. `FRICTION.md`
captures not only tooling friction but **"this phase/handoff exists only because humans needed it"**
observations. Nothing below is sacred except the deliverable: a lived friction list + a working
reference scaffold.

## The five decisions (ratified in the 2026-07-16 scoping session)

1. **Project: greenfield.** A real, small, genuinely-useful utility — friction stays attributable to
   the orchestration, not to legacy code.
2. **The project is an AI-stack cost tracker** — subscriptions across his harnesses (name,
   vendor, monthly cost, renewal date, notes). The pain is line 1 of the stage-manager vision
   ("Codex Pro — barely touched"). Bonus: it's a candidate to graduate into agent-os's
   **Economics** reserved home later — the dogfood produces a real feature candidate, not throwaway.
3. **Run-1 harness map** (phase 1 = fixed harnesses): Claude Code = Architect/Plan → Codex =
   Execute → Claude Code = Review → **Cursor CLI = E2E QA gate** → Claude Code = PR.
   Cursor chosen because one harness carries multiple models (verified pins below). Order
   review-before-QA for run 1; reversible per run, and testing the ordering is part of the point.
4. **Repo: `~/Code/personal/agent-cost-tracker`, public.** Blueprint-first structure (option B
   below). Everything **project-scoped, not user-scoped** — Jarod's explicit call.
5. **Run-1 scope + done:** repo bootstrap + subscription CRUD (one entity, one list view,
   add/edit/delete). Stack = Jarod's standing prefs: **Bun, React Router 7, Tailwind + Shadcn,
   SQLite/Drizzle, colorblind-safe from day one** (text labels + shape, never hue-alone).
   **Done = the flow completed** (plan → execute → review → QA `PASS`+`OPEN_PR` → PR → Jarod
   merges), NOT the app perfected. Manual interventions allowed — each one is a friction entry.
   **A messy run that captures ten "ugh" moments beats a clean run that captures none.**
   Feature ladder for runs 2+: renewal flags → monthly-spend chart → usage notes.

## QA ownership (ratified) — requirements vs verification split

- **WHAT must be true → the Architect, at plan time.** The Architect's plan MUST contain an
  **Acceptance Criteria section written as verifiable pass/fail bullets** — this is a plan-template
  requirement of the Architect role file. Cursor's contract demands it and returns `BLOCKED` when
  missing. Criteria written after code exists degenerate into "assert whatever got built."
- **HOW to verify → the QA lead, at gate time = the parent Cursor agent running the `qa-gate`
  skill.** It designs the test approach, fans out specialists, scopes regression to changed paths,
  aims the skeptic at the riskiest PASS claims, and emits the verdict. It must NEVER invent
  acceptance criteria not in the contract (scope-drift wearing a QA badge).
- **Known gap, deliberately deferred = shift-left QA.** No QA voice reviews the plan pre-execution
  ("criterion 3 isn't testable as written"). If run 1's friction shows criteria arriving vague or
  untestable, **run 2 trials the shift-left review as an explicit experiment.**

## Repo structure (decision: blueprint + hand-provisioned native copies)

The hand-copying from `blueprint/` into native locations **is the manual provisioner** — the
ceremony Jarod feels is exactly what U10 automates, and the blueprint→native mapping is U10's spec.

```
agent-cost-tracker/
  blueprint/                       # the SSOT — shared intent + per-harness variants (vision §SSOT)
    workflow.md                    # the SDLC map: phases, harness per phase, handoff contracts
    roles/
      architect.md                 # shared intent per role…
      executor.md
      reviewer.md
      qa-gate.md
      variants/                    # …and per-harness implementations where they differ
        claude-code/  codex/  cursor/
  CLAUDE.md                        # provisioned: Claude Code (Architect/Review/PR roles)
  .claude/agents/                  # provisioned: review subagents if needed
  AGENTS.md                        # provisioned: Codex (Executor role)
  .codex/                          # ⚠️ agent format UNVERIFIED — verify live before authoring (below)
  .cursor/agents/                  # provisioned: qa-smoke/qa-regression/qa-browser-e2e/qa-skeptic-verifier
  .cursor/skills/qa-gate/          # provisioned: the QA-lead orchestrator skill
  FRICTION.md                      # append-only; one line per moment, tagged [architect|execute|qa|review|handoff]
  docs/plans/                      # run plans (run-1 plan lives here, WITH acceptance criteria)
  src/ …                           # the actual app
```

## Cursor facts (verified via Jarod's Cursor session, 2026-07-16 — see `~/Projects/jarodtaylor/cursor-qa-team.md`)

1. **Format:** agents = markdown + YAML frontmatter in `.cursor/agents/`; skills in
   `.cursor/skills/`; **project-scoped overrides user-level on name conflict.**
2. **Model pins work** (frontmatter `model:`), verified on Jarod's plan: Opus 4.8 Thinking High,
   Sonnet 5 Thinking High, Fable 5 Thinking High, Composer 2.5 (+Fast), GPT 5.6 Sol/Terra Medium,
   Grok 4.5 High Fast. **Trap: silent fallback** when a pin is blocked/Max-Mode-off — dry-run pins
   before run 1 (`agent models`, then a cheap smoke prompt per specialist).
3. **Browser E2E** = Playwright / browser MCP inside the Cursor CLI session — availability in the
   dogfood repo is a scaffold-time verification item.
4. **Headless:** the `agent` CLI (`--workspace <repo> -p "…"`) — fits a Herdr pane directly.
   Contract + `QA_GATE_REPORT` parsing (`gate_verdict` / `pr_recommendation`) per the reference doc.

**Adopt the reference doc's QA-gate design** (4 specialists + skeptic + contract-or-`BLOCKED` +
machine-readable verdict) — rebuilt **project-scoped** in the blueprint; specialists never edit
app source / commit / push / open PRs.

## Scaffold checklist (the fresh session's to-do, in order)

1. Create `~/Code/personal/agent-cost-tracker` (public GitHub repo, `main` protected by convention —
   feature branches + PRs like agent-os).
2. **Verify harness surfaces LIVE before authoring role files** (the U9 learning —
   `docs/solutions/conventions/verify-harness-surfaces-against-live-instances.md`): Codex
   agents/persona format (the `.codex/agents` TOML claim in the vision doc is **UNVERIFIED**),
   Cursor CLI presence (`agent models`), Playwright/browser MCP in Cursor CLI.
3. Author `blueprint/` (workflow + 4 roles + variants). Mine `~/.cursor/agents/*` and
   `~/.cursor/skills/qa-gate/*` as REFERENCE for the Cursor variants — then
   **delete the user-level copies** (Jarod-sanctioned; they're global-scope pollution, the same
   leak class as the claude-os incident. Seed `FRICTION.md` entry #1 with this incident:
   *an agent writing config at the wrong scope is literally the provisioning problem agent-os
   exists to solve*).
4. Hand-provision blueprint → native locations (this ceremony = U10's spec; note every step).
5. Dry-run each pane standalone: Codex reads `AGENTS.md` role; Cursor `agent … -p` smoke with the
   contract template; model pins hold.
6. Claude-as-Architect writes the run-1 plan (bootstrap + subscription CRUD) **with pass/fail
   acceptance criteria**.
7. Run 1 via Herdr. Friction captured live. Done = merged PR + a non-empty `FRICTION.md`.

## What this block feeds (don't lose these)

- **U10 (provision engine):** the blueprint→native mapping + the hand-provisioning ceremony = its spec.
- **MVP-definition session (before/at U11):** `FRICTION.md` + the agent-first SDLC observations.
- **#24 parallelization (decision #46):** once the scaffold is done and Jarod starts test runs, a
  `/unit-loop` session ships #24 (single-source Codex credential) in parallel.
- **Run-2 experiment candidates:** shift-left QA review · QA-before-review ordering · swapping a
  phase's harness (phase 2 of the vision).

## Open items (not blockers)

- **Herdr specifics:** commitment vs stand-in for "some multiplexer" (vision doc open question) —
  answered by using it, not deciding now.
- **Codex persona format** — verify live (checklist #2).
- **Cursor QA cost:** ~4× tokens per gate run (by design, cheap pins on smoke/regression) — watch it,
  don't pre-optimize.
