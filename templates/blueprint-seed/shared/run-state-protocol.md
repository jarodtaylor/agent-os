# RUN_STATE protocol (all roles, all harnesses)

`RUN_STATE.md` at the repo root is the **cross-harness run file**: the one place the roles in this project
read and write while a run is in flight. It is how the architect hands work to the executor, how the executor
hands it to QA, and how QA hands findings to the reviewer — none of which share a session, a harness, or a
context window.

It is **not** a session handoff. Session-to-session continuity is a different thing with a different home.
`RUN_STATE.md` is about the *run*: what this project is doing right now and who is holding it.

## Rules

1. **Read it first.** Before doing anything else in a session, read `RUN_STATE.md`. It is the current truth
   about the run; the repo is only the current truth about the code.
2. **Append, never rewrite.** Add your entry under your own role heading. Do not edit, summarize, or delete
   another role's entry — that entry is their evidence, and you were not there when they wrote it.
3. **Hand off explicitly.** End your entry with `→ NEXT: <role>` and exactly what that role must do. A run
   with no named next role is a stalled run.
4. **State blockers loudly.** If you cannot proceed, write why under `## Blockers` and hand back to the
   architect. Do not silently do something adjacent instead.
5. **It is runtime state, not configuration.** `RUN_STATE.md` is never provisioned and never lives in
   `blueprint/`. Agent OS scaffolds it once and then leaves it alone forever — it is yours.

## Friction

If a role file, a tool, or the protocol itself got in your way, add a line to `FRICTION.md` (create it if it
is absent). That file is the input to the next round of blueprint tuning — friction that goes unrecorded gets
re-lived every run.
