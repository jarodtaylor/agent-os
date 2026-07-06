---
name: handoff
description: Wrap up the current session and write a durable handoff so a fresh context resumes seamlessly. Makes state durable + honest (branch, commits, tests-if-any), detects clean-phase-boundary vs mid-work, and FEEDS the project's canonical record — START-HERE.md (resume point) + DECISIONS.md (ledger), with the mid-work cursor in gitignored docs/HANDOFF.local.md — then emits a tight recap + action-only ▶ NEXT anchored to the North Star. Invoke as /handoff (alias: /wrap-up) when context is getting tight, you're leaving, or rebooting.
disable-model-invocation: true
---

# /handoff — end-of-session wrap-up + durable handoff

Run this when context is getting tight and you want to clear it without losing the thread. It produces the **same handoff shape every time** so a fresh session (or agent) picks up with nothing lost and no fiction — whether we stopped at a clean phase boundary or paused mid-work. Do the steps in order; do not skip Step 1.

> **The whole point:** agent-os is attempt #2 — the first died to drift. This handoff exists to keep intent continuous across contexts. Every NEXT re-ties back to the North Star (`STRATEGY.md`).

## Step 1 — Make the state durable AND honest (never hand off a lie)

Establish ground truth first — report it, don't paper over it:

```bash
git branch --show-current
git status --short
git log --oneline -8 | cat
```

- **Branch** — **CODE** rides **feature branches → PR** per [[jarod-compound-engineering-pipeline]]; if there's uncommitted *code* on `main`, surface it (don't silently commit code there). **The handoff's OWN record updates are the exception → they commit directly to `main` (see Step 3).**
- **Uncommitted / unpushed** — surface explicitly. If it's a complete, committable unit and Jarod wants it saved, commit it (feature branch; clear "why" message). Otherwise note it in-flight; don't invent a commit.
- **Tests / build** — if the project has a test or build command, run it and report `Ran / OK / FAILED`. (agent-os is **docs-only during the planning phases — none yet**; add this once there's code.) Never write "green" over an unrun or failing suite.
- **CE phase** — note which compound-engineering phase the session was in (`ce-strategy` ✅ done → `ce-ideate`/`ce-brainstorm` → `ce-doc-review` → `ce-plan` → `ce-work` → `ce-code-review` → `codex:adversarial-review` → `ce-compound` → PR). It shapes Step 2. See [[jarod-compound-engineering-pipeline]].

## Step 2 — Detect the handoff shape

Pick one from Step 1's ground truth:

**A · Clean phase boundary** — a CE phase finished, work committed/merged (or a docs/planning phase produced its artifact). Short handoff: what got produced + the next phase to start fresh on.
> *Last session: `<phase>` complete → `<artifact>` (e.g. STRATEGY.md; PR #N / merge `sha` when code). ▶ NEXT: `<ce-brainstorm | ce-plan | ce-work>` on `<bucket / feature>`.*

**B · Mid-work** — mid-phase: uncommitted changes, unfinished units, or a pending review/fold step. Be precise about *exactly where we are*:
> *Resume on branch `B`: U1–U3 done + committed, **U4/U5 left**; suite `<N green / RED>`; review gate pending — `ce-code-review` + `codex:adversarial-review` not yet run/folded. Plan: `docs/plans/…`. Decided KTDs (don't re-litigate): … . Mechanics: …*

Capture for shape B: units done vs left; which review passes (advisor / `ce-code-review` / codex / bots) have run-and-folded vs are pending; the branch + commit cursor; decided KTDs.

## Step 3 — Update the durable record (START-HERE.md + DECISIONS.md)

**The canonical record is `docs/START-HERE.md` + `docs/DECISIONS.md`** (CLAUDE.md: *"START-HERE + DECISIONS are the state"*). The handoff **feeds them** — it never opens a parallel "next session" block, because that reintroduces the multi-source drift this project exists to prevent. `STRATEGY.md` is the North Star; **reference it, don't restate-and-diverge.**

- **Commit these record updates DIRECTLY to `main`** — no feature branch, no PR. They're the canonical ledger (bookkeeping), not reviewable code: a handoff PR burns a CodeRabbit/Copilot cycle on a doc-flip that never has comments and adds friction at the exact moment you're clearing context. (Docs *coupled to a feature* — a spike report, a decision written alongside its code — ride that feature's PR instead; this direct-commit is only for the handoff's own record-keeping.)
- **`START-HERE.md`** — update `## Where we are RIGHT NOW` (flip the finished phase to ✅, set the ⏳ **Next**) and `## Open threads`. Keep it **curated + compact** — compress finished detail into a line; don't let it grow unbounded.
- **`DECISIONS.md`** — log every decision made this session (row: date · decision · **why** · **intent served**). If a decision **closed a deferred fork**, move that fork out of the "Open — deferred" table and cite the decision number.
- **Mid-work cursor (shape B only)** — the ephemeral "resume on branch X, U4/U5 left, KTDs…" detail goes in **gitignored `docs/HANDOFF.local.md`** (survives a context clear; keeps the curated START-HERE from churning). START-HERE gets ONE line: *"⏸ Paused mid-`<phase>` — see `docs/HANDOFF.local.md`."* Clear that file at the next clean boundary.
- **Compounding** — if the session solved something non-trivial or produced a durable cross-session lesson, suggest **`/ce-compound`** (→ `docs/solutions/`) and/or a **memory** write (`~/.claude/projects/…/memory/`) before clearing. Don't silently skip it.
- Keep the ▶ NEXT **action-only** (Jarod is ADHD — [[jarod-working-style-antidrift]]): exact next command/skill, the branch to use (or "branch off fresh `main`"), plan/brainstorm paths, decided KTDs ("don't re-litigate"), and any mechanics.

## Step 4 — Emit the handoff

Print a tight recap to the user:

- **One-paragraph recap** — what changed / what got produced.
- **State line** — branch · pushed? · tests (`N green / RED / none yet`) · PR/issue state · CE phase.
- **▶ NEXT** — the action-only block written into START-HERE.md (or HANDOFF.local.md for shape B), so they can read it back.
- **Loose threads** worth a glance next session.

End with an explicit **"clear to clear context"** (shape A) or **"resume-here cursor"** (shape B). Anchor the NEXT to the North Star — every handoff re-grounds intent. Don't offer `/schedule` unless the work left a dated future obligation.

## Conventions to honor (agent-os-specific — lift this block when promoting to `~/.claude`)

- **Canonical state = `START-HERE.md` + `DECISIONS.md`.** Feed them; never a parallel record. `STRATEGY.md` = North Star; don't restate-and-diverge. [[agent-os-project]]
- **Anchor to the North Star.** Attempt #2; the first died to drift. Every handoff re-ties NEXT to intent. [[jarod-working-style-antidrift]]
- **Log every decision** to DECISIONS.md (decision · why · intent served).
- **Small chunks / action-only NEXT** — strip to executable steps.
- **CE pipeline** governs the flow — [[jarod-compound-engineering-pipeline]]. Work → feature branch → PR (auto-reviewed by CodeRabbit/Copilot). Don't skip the review layers.
- **Mid-work cursor** → gitignored `docs/HANDOFF.local.md`; clear it at phase boundaries.
- The handoff is **action-only and honest** — its whole job is that a fresh context resumes with nothing lost and no fiction.
