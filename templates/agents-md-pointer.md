# Agent OS — Continuity Brain (agent-os)

This machine runs Agent OS, a local brain that persists work-state across sessions and across
harnesses (Claude Code, Codex, ...). At the START of every session, call `read_work_state` BEFORE
exploring the repo or asking what to do next — it returns the curated handoff and recent activity
for this project, so you resume exactly where the last session left off.

## How
Call the `read_work_state` tool on the `agent-os` MCP server, passing this project's absolute path
as `project` (its current working directory):

    read_work_state({ project: "<absolute path to this repo>" })

## What it returns
The most recent curated handoff (if any) plus the recent raw-activity trail — already redacted, so
no secret ever appears in the response. If nothing has been recorded yet for this project, it
returns an empty resume payload; proceed normally.

## When to call it again
If you lose track of prior context mid-session (a long tool chain, a context compact), call it
again rather than re-deriving state by re-reading the whole repo.
