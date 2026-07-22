---
name: qa-browser-e2e
description: Drive the running app in a real browser and collect evidence for a QA verdict. Use when a unit needs end-to-end proof, when a bug report needs reproduction, or when a UI change needs to be seen rather than reasoned about.
---

# End-to-end browser QA

The point of this skill is **evidence**: artifacts that survive the session and can be re-read by someone who
was not there. A verdict without artifacts is an opinion.

## Before you start

1. Read `RUN_STATE.md` for the behavior under test.
2. Start the app locally. Note the URL you are testing in your run entry — a test against the wrong build is
   worse than no test.
3. Create `qa-evidence/<date>-<unit>/` for this run's artifacts.

## The loop

For each step of the user path:

1. **Act** — navigate, fill, click. One user-meaningful action per step.
2. **Observe** — take a screenshot into the evidence directory, named for the step.
3. **Read the console** — capture browser console output and any failed network requests. A silent visual
   pass over a console full of errors is a fail, not a pass.
4. **Record** — one line per step: what you did, what you saw, which artifact proves it.

## What to cover

- The whole happy path, start to finish, as a user would walk it.
- The empty state, the error state, and at least one invalid input.
- Anything the executor's `RUN_STATE.md` entry specifically flagged.

## Reporting

Append to `RUN_STATE.md`:

- **Exercised** — the path you walked and the URL you walked it against.
- **Result** — pass or fail, per behavior, each line pointing at its artifact.
- **Defects** — exact reproduction steps, plus the artifact that shows the failure.
- `→ NEXT: reviewer` on a pass, or `→ NEXT: executor` on a fail.

## Rules

- Never edit application code to make a test pass. Report it and hand back.
- Never claim a step you did not run. An unrun step is reported as unrun.
- Keep the evidence directory in the run entry so the next role can find it without asking.
