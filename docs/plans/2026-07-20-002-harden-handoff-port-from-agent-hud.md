# Side quest — harden the handoff (port agent-hud's evolved version into agent-os)

> **Status:** planned, not started (2026-07-20). Inserted **before** the U10 plan session at Jarod's call.
> **Durable checkpoint** written pre-`/compact` so this survives context compaction — everything needed to
> execute is here; do not re-derive from the (compacted) conversation.
> **North Star tie:** the handoff is what keeps intent continuous across contexts — attempt #2's whole
> anti-drift reason to exist. "Degrade gracefully, don't require the server" is the same principle as
> "connect, don't replace."

## Why (the problem this fixes)

agent-os's `/handoff` is **substrate-FIRST**: it wants to write "where we left off" to the brain's
`write_handoff` MCP tool (server + DB), with the markdown docs as projections. But **the server isn't
built yet** (manual-start until U15), so:
1. Every handoff falls into the "substrate unreachable → docs-only + ⚠️ staleness flag" path — the flag is
   confusing agent-plumbing noise (Jarod: *"I honestly have no clue what that even means"*).
2. Resume (`GET /work-state` via the U6 `hooks/session-start.ts`) **also** needs the server, so pre-U15 a
   fresh session gets nothing auto-injected — it relies on a human reading START-HERE.
3. agent-os has **zero crash-safety**: no on-disk breadcrumb if a session is killed mid-work (its only
   capture path is server-backed).

**agent-hud** (`~/Projects/jarodtaylor/agent-hud`) already solved this — its handoff is the **evolved,
project-agnostic, substrate-OPTIONAL** version of the same skill lineage. It makes a plain file the default
record, the substrate an enhancement, and adds file-based crash-safety + resume hooks that need no server.

**End goal (Jarod's framing):** agent-os becomes the **canonical** handoff, then promotes to **`~/.claude`**
(user level) so every project inherits it instead of re-creating it per-project. agent-hud's version is
already the more-agnostic base (it has an "override via CLAUDE.md" conventions block + both substrate/file
branches), so this is *adopt + reconcile*, not *invent*.

## Source → target file map

**Source (agent-hud, `~/Projects/jarodtaylor/agent-hud`):**
- `.claude/skills/handoff/SKILL.md` — the agnostic, substrate-optional skill (the model for the reframe).
- `.claude/hooks/session-breadcrumb.sh` — **Stop** hook: after every turn writes `.claude/session-breadcrumb.md`
  (branch/HEAD/uncommitted/transcript), atomic temp-then-move, no LLM/network/commit, always exit 0.
- `.claude/hooks/session-resume-check.sh` — **SessionStart** hook: surfaces the breadcrumb as a resume aid,
  neutral wording, no server call, always exit 0.
- `.claude/hooks/branch-cleanup.sh` — SessionStart-startup nicety (cleans merged branches). Optional.
- `.claude/settings.json` — the exact hook wiring (captured below).
- `HANDOFF.md` — rendered example of the file-as-record shape.

**Target (agent-os, `~/Code/personal/agent-os`):**
- `.claude/skills/handoff/SKILL.md` — current substrate-first version to reframe (Phase 2).
- `.claude/hooks/` — currently only `codex-gate.py` + `typecheck.py`; ADD the two shell hooks (Phase 1).
- `.claude/settings.json` — has PreToolUse(codex-gate) + PostToolUse(typecheck), **no Stop/SessionStart**;
  ADD them (Phase 1). NOTE `.claude/` is gitignored in agent-os (local-only), same as agent-hud — these
  changes are local, no PR.
- `hooks/session-start.ts` — the U6 server-dialing SessionStart hook. It installs into **user** `~/.claude`
  (not project settings), so a project-level file-based resume-check does **not** collide with it. They
  coexist: file-based resume works always; the server hook adds auto-injection once installed + running.
- DECISIONS.md — the #8/U7/KTD8 amendment (Phase 2).

## Phase 1 — additive hooks (SAFE, do first; touches nothing existing)

Pure crash-safety + file-based resume. Amends no decision. Do this first even if Phase 2 waits.

1. Copy `session-breadcrumb.sh` + `session-resume-check.sh` (and optionally `branch-cleanup.sh`) from
   agent-hud `.claude/hooks/` into agent-os `.claude/hooks/`. Read each first (they're agent-hud-generic —
   they key off `CLAUDE_PROJECT_DIR`/git, nothing hud-specific — but confirm no stray hud references).
2. Wire agent-os `.claude/settings.json` — MERGE these into the existing `hooks` object (keep
   PreToolUse/PostToolUse):
   ```json
   "Stop": [
     { "hooks": [ { "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/session-breadcrumb.sh\"", "timeout": 10 } ] }
   ],
   "SessionStart": [
     { "matcher": "startup", "hooks": [ { "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/session-resume-check.sh\"", "timeout": 10 } ] },
     { "matcher": "resume",  "hooks": [ { "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/session-resume-check.sh\"", "timeout": 10 } ] }
   ]
   ```
   (branch-cleanup.sh optional as a second SessionStart-startup entry — evaluate separately; not core.)
3. Add `.claude/session-breadcrumb.md` to agent-os `.gitignore` if `.claude/` isn't already fully ignored
   (it is per project convention, but verify the breadcrumb file specifically isn't force-added).
4. **Verify:** trigger a Stop (end a turn) → breadcrumb file appears with correct branch/HEAD/status; open a
   fresh session → resume-check surfaces it. Confirm no interference with codex-gate/typecheck hooks.

## Phase 2 — reframe the /handoff skill (needs Jarod's design go: amends decision #8)

Adopt agent-hud's substrate-optional structure into agent-os's `/handoff`. Retire the "substrate not
written ⚠️" language. **Open design calls for Jarod (the reason Phase 2 gates on him):**

- **DC1 — the file record's home.** agent-os already has `START-HERE.md` (resume doc) + `DECISIONS.md` +
  `PRODUCT.md`. Options: (a) add a slim root `HANDOFF.md` as the terse machine-ish record the resume-check
  surfaces, START-HERE stays the rich human orientation; or (b) treat `START-HERE.md` ▶ NEXT itself as the
  file-record (no new file), point the resume-check at it. Lean: (a) — a terse HANDOFF.md is what a
  resume-hook wants to surface; START-HERE is too long. But (b) avoids a 4th doc. Jarod's call.
- **DC2 — model-invocable?** agent-hud's handoff IS model-invocable (with an idempotence "don't churn
  identical commits" rule) so `/unit-loop`'s final step can call it. agent-os's is
  `disable-model-invocation` (Jarod-triggered only). Decide whether to flip it (+ adopt the idempotence
  guard) so the loop can auto-handoff, or keep it manual.
- **DC3 — the #8/U7/KTD8 amendment.** "One continuity record" is PRESERVED (agent-hud: "never two records
  that can disagree") — only the record's *home* generalizes: a file by default, the substrate when the
  project has a running one. When U15's server ships, `write_handoff` becomes primary and the file a
  projection (agent-hud's version already has this branch). Log a DECISIONS row amending #8 to this
  file-first/substrate-optional framing.

Deliverable: agent-os `.claude/skills/handoff/SKILL.md` reworked from agent-hud's, keeping agent-os's
canonical-docs projection (START-HERE/DECISIONS/PRODUCT) as the "if the project has canonical docs" branch.

## Phase 3 — promote to `~/.claude` (the actual long-term goal, later)

Once the hardened agent-os version is proven, lift the skill + hooks to `~/.claude` so every project
inherits a working handoff; per-project `CLAUDE.md` overrides the agnostic defaults (agent-hud's conventions
block is written exactly for this). agent-os becomes the reference implementation. Not now — after Phase 1/2
settle and Jarod's used them.

## After this side quest → back to the roadmap

The next real work is the **U10 plan session** (`ce-plan`, grounded in the dogfood run's
`~/Code/personal/agent-cost-tracker/PROVISIONING.md` + retro §6 + `FRICTION.md`) — the Act/provisioning
half of "see AND control." U24 was the last cleanup before that; this handoff side quest is a detour Jarod
inserted before it. START-HERE ▶ NEXT points here until this is done, then back to U10.

## Verification / acceptance

- **Phase 1:** breadcrumb written on Stop; resume-check surfaces it on a fresh session; existing hooks
  unaffected; no server required for either.
- **Phase 2:** a `/handoff` run with the server down produces a clean record with NO "substrate not written"
  apology; DC1/DC2/DC3 resolved + logged; the substrate branch still present for U15.
- **Phase 3 (later):** a brand-new project with no handoff setup gets working resume from the `~/.claude`
  defaults alone.
