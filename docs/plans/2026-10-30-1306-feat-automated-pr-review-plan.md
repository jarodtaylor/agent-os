---
title: Automated PR Review - Plan
type: feat
date: 2026-10-30
topic: automated-pr-review
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Automated PR Review - Plan

## Goal Capsule

- **Objective:** Every agent-os PR gets independent automated review from three model families without Jarod driving it, and every PR stays small enough for that review to mean something.
- **Means:** A Claude Code Action workflow on Jarod's Max subscription, Codex's own GitHub review on his Pro subscription, Copilot's existing ruleset with re-review on push, and a local PR-size check at `gh pr create` (KTD1, KTD6).
- **Product authority:** Jarod (CEO/Product), settled in the 2026-10-30 brainstorm session. The Product Contract governs product behavior; the Planning Contract governs mechanism.
- **Execution profile:** One small tracked PR: U1, this plan, and U4's `docs/DECISIONS.md` row. U3 and U4's other edits are under gitignored paths and ship without a PR. U2 needs Jarod's accounts.
- **Stop conditions:** Stop and re-plan if subscription auth for Claude fails in CI after one retry, or if Codex review needs an API key or is unavailable on Jarod's plan. Either would break R1 or R2.
- **Who finishes:** Claude (CTO) builds U1, U3, U4 and the Copilot part of U2. Jarod runs the two account steps in U2 and merges.
- **Open blockers:** None.

---

## Product Contract

Product Contract preservation: changed R5 and R7, both by Jarod in doc review. R5 now names fork PRs only, since push access is accepted to reach the token. R7 now excludes docs and generated files. Otherwise restructured, no scope change. Outstanding Questions answered by planning were resolved in place and moved to KTDs. AE4 reworded to match KTD3 (the job is skipped, same outcome). The custom-instructions scope boundary clarified to rule files. R-IDs and AE-IDs unchanged.

### Summary

Claude and Codex auto-review every agent-os PR on Jarod's subscriptions, joining Copilot. All three comment only; Jarod stays the merge gate. A soft PR size budget keeps each PR small enough to review.

### Problem Frame

Jarod is one person merging PRs he cannot read line by line. The pre-PR loop (ce-code-review plus the local Codex adversarial gate) is good. But it never sees fix pushes made after a PR opens. It also never sees PRs that bypass the unit-loop, such as PRs authored by Codex or Cursor or quick fixes. After the PR opens, only Copilot reviews, and it reviews once.

PR size has grown unit over unit. PR #45 was +393 lines, #47 +1,019, #44 +1,231, #52 +1,901 and #61 +4,917 across 33 files. PR #61 needed 8 gate rounds plus 3 Copilot fixes. At that size no reviewer, human or model, reliably reads the whole change. More reviewers do not fix that.

### Requirements

**PR-time reviewers**

- R1. Claude reviews every PR when it opens and on every push, and posts its findings as PR review comments. It authenticates with Jarod's Claude Max subscription, never an API key, and runs on Sonnet.
- R2. Codex automatically reviews every PR through its own GitHub integration on Jarod's ChatGPT Pro subscription, never an API key.
- R3. Copilot keeps reviewing every PR, with re-review on new pushes turned on.
- R4. Every PR-time reviewer comments only. None is a required status check, and Jarod remains the merge gate.
- R5. The Claude review never runs with secrets for a PR from a fork, and never runs under a trigger that gives fork PR code base-repo secrets.
- R6. Each reviewer does its default review. No custom review-rule files are authored for any reviewer.

**PR size budget**

- R7. A PR's budget is 800 changed lines of hand-written code, not counting tests, docs or generated files.
- R8. Planning slices units so each unit's PR fits the R7 budget.
- R9. Opening a PR over the R7 budget triggers a warning. The PR then opens only with a split or a one-line justification recorded in the PR body. The warning never hard-blocks.

### Key Decisions

- **PR-time review complements the local gate rather than replacing it.** Codex's GitHub review flags only P0/P1 and does not iterate. Medium findings would be lost, such as the two the U6 gate raised late. Governs R2, R4. (session-settled: user-approved — chosen over replacing the local Codex gate with PR-time Codex: the cloud review drops medium findings and cannot iterate)
- **No agent-os-specific review-rule layer.** ce-code-review and the Codex gate already cover agent-os's correctness and quality needs. The project-goals lens Jarod described belongs to a different repo. Governs R6. (session-settled: user-directed — chosen over a tracked review-rules file enforced pre-PR and on PRs: unnecessary for this repo, the brand-specific lens was about jarodtaylor.com)
- **Lineup: Claude and Codex automatic, Copilot as-is, Cursor Bugbot off.** Governs R1, R2, R3. (session-settled: user-approved — chosen over Codex on-demand only and over dropping Claude-on-PR: covers post-PR pushes and loop-bypassing PRs, with the cost on existing subscriptions)
- **Claude's PR review runs on Sonnet.** Claude's PR runs draw on the same Max limits as Jarod's interactive sessions. Governs R1. (session-settled: user-approved — chosen over the default model: protects the shared Max quota)
- **The size budget warns rather than blocks.** A real reason to exceed it should cost one line, not a fight with tooling. Governs R7, R9. (session-settled: user-approved — chosen over a hard block: overrides stay cheap and visible)
- **Anyone who can push a branch here can reach the Claude token, and that is accepted.** A same-repo PR can edit the workflow it runs. Push access today is only Jarod and his agents, who already hold equal trust. Governs R5. (session-settled: user-directed — chosen over a per-run approval gate and over dropping Claude-on-PR: keeps review automatic at no new trust cost)
- **The size budget counts hand-written code only.** Docs and generated files are cheap to review and would push migrations over the budget. Governs R7. (session-settled: user-directed — chosen over counting everything except tests: a single migration snapshot is about 344 lines)
- **Size is a shared discipline, not only a check.** The fix for oversized PRs is slicing units at plan time. A warning at PR time is only the backstop. Governs R8.

### Acceptance Examples

- AE1. **Covers R7, R9.** **Given** a PR with 600 changed non-test lines and 900 test lines, **when** it is opened, **then** no size warning appears.
- AE2. **Covers R9.** **Given** a PR with 1,500 changed non-test lines, **when** `gh pr create` runs, **then** a warning names the count and the budget. The PR opens only after a split, or with a one-line justification in its body.
- AE3. **Covers R1, R3.** **Given** an open PR, **when** a fix commit is pushed, **then** Claude and Copilot each review the new push without anyone invoking them.
- AE4. **Covers R5.** **Given** a PR opened from a fork, **when** the Claude workflow is triggered, **then** the Claude job is skipped. The subscription token is never used and no review is posted.

### Success Criteria

- The first PR opened after this lands receives Claude, Codex and Copilot reviews with nobody invoking them.
- No API key for any model provider exists in the repo's secrets.
- PRs from the next unit (U7) on stay under the R7 budget, or carry a justification line.

### Scope Boundaries

- Cursor Bugbot. Pro-plan inclusion is unverified, and a fourth general reviewer adds noise.
- Custom review-rule files for any reviewer, such as `CODING_STANDARDS.md`, `AGENTS.md` review rules, `.github/copilot-instructions.md` or Compound Packs. Claude's workflow prompt (KTD1) is a generic review instruction, not a project rule file.
- Making any reviewer a required check or merge blocker.
- Changes to the pre-PR loop: ce-code-review, the local Codex gate and its marker hook.
- A CI test workflow. The repo has none today, and adding one is separate work.
- The Codex GitHub Action (`openai/codex-action`). It supports API keys only.
- Considered and not built: a verification step that fails the job when Claude posts no review. The reviewer is comment-only, so a missing Claude comment is visible on the PR, and Codex and Copilot still review. Revisit if a silent miss is ever observed.
- Considered and not built: deduplicating Claude's inline comments across pushes. The action keeps one summary comment in place but may repeat inline comments on re-review. Revisit if repeats become noise on real PRs.

#### Deferred to Follow-Up Work

- A GitHub-side size check that comments on oversized PRs opened outside this checkout, such as PRs Codex or Cursor open. U3 covers only PRs opened from Claude sessions here.

### Dependencies / Assumptions

- `CLAUDE.md` and `.claude/` are gitignored, so PR-time reviewers see none of the project's agent instructions. That is acceptable under R6.
- The repo is public. GitHub withholds repo secrets from fork-triggered workflows, which R5 relies on.
- Claude's PR runs consume Jarod's Max usage limits, and Codex's consume his Pro limits.
- The workflow passes the job's `GITHUB_TOKEN`, so the Claude GitHub App's token exchange, and its check that the workflow matches the default branch, never runs. The PR that adds U1's workflow is therefore Claude's own first live test.
- By default, claude-code-action refuses runs triggered by GitHub Apps or bots. PRs opened or pushed by an agent's bot identity need that bot named in `allowed_bots`.

### Outstanding Questions

**Deferred to Implementation**

- Does Codex's automatic review re-run on new pushes? Its docs defer to a "Review trigger" setting visible only in the settings UI. Jarod sees it in U2; if push re-review is unavailable, `@codex review` stays the manual re-trigger.
- Is the ChatGPT Pro plan explicitly eligible for Codex code review? U2 proves it by enabling it.
- How does Copilot bill re-review on push for a personal account? Observe after U2.

### Sources / Research

- Claude Code Action: https://github.com/anthropics/claude-code-action (`action.yml`, `docs/setup.md`, `docs/security.md`, `docs/faq.md`, `examples/pr-review-comprehensive.yml`) and https://code.claude.com/docs/en/github-actions
- Official code-review plugin's skip-if-already-commented check: https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/commands/code-review.md
- Codex GitHub integration: https://learn.chatgpt.com/docs/third-party/github ; Codex Action is API-key-only: https://learn.chatgpt.com/docs/github-action ; subscription auth in CI is advised against for public repos: https://learn.chatgpt.com/docs/auth/ci-cd-auth
- Copilot automatic review via branch ruleset: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review ; instructions files: https://github.blog/ai-and-ml/github-copilot/unlocking-the-full-power-of-copilot-code-review-master-your-instructions-files/
- Cursor Bugbot pricing: https://cursor.com/docs/bugbot and https://cursor.com/pricing

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Claude reviews through a custom `prompt`, not the official `code-review` plugin.** The plugin stops when Claude has already commented on the PR, which would silently defeat re-review on push (R1, AE3).
- KTD2. **Run in agent mode (a `prompt`, no `track_progress`) and authenticate to GitHub with the job's own `GITHUB_TOKEN`; the summary is one comment Claude updates with `gh pr comment --edit-last --create-if-none`.** Tag mode was rejected after review. It auto-approves edits, adds commit/push tools, mints the Claude App's contents-write token into git config, and feeds every PR comment into the prompt, including comments from outsiders on this public repo. Agent mode adds only the tools we list. The job token is limited to reading code and writing PR comments, and expires with the job. Claude sees only the diff. Governs R1, R4.
- KTD3. **Trigger on `pull_request` only (`opened`, `synchronize`, `ready_for_review`, `reopened`), gate the job on the head repo equalling this repo, and cancel an in-progress run for the same PR on a new push.** The job-level condition skips fork PRs cleanly instead of erroring on the missing token. Never `pull_request_target`. Governs R1, R5.
- KTD4. **Set `classify_inline_comments: 'false'`.** Its post-step calls the Anthropic API with `ANTHROPIC_API_KEY`, which R1 forbids. Without a key it already degrades to posting all comments; disabling it makes that explicit and skips the step.
- KTD5. **Pin `anthropics/claude-code-action` to the full commit SHA of release `v1.0.265`, with the tag in a trailing comment.** The workflow holds Jarod's subscription token on a public repo, so a moving `@v1` tag is a supply-chain exposure. Official examples use `@v1`; SHA pinning is our choice. Upgrades are manual. `actions/checkout` is SHA-pinned the same way, with `persist-credentials: false`.
- KTD9. **The Claude reviewer is read-only by construction, with explicit denials as a second layer.** Agent mode (KTD2) allows only the inline-comment tool, `gh pr diff` and `gh pr comment`. A non-interactive run denies anything else, including shell file moves. `--disallowedTools` also names Edit/MultiEdit/Write/NotebookEdit, the file-ops commit tools and the git write commands. The job token cannot push code (`contents: read`). The prompt states the read-only role. Governs R4. (session-settled: user-directed — chosen over trusting the job's contents-read permission: review agents comment, only the CTO session and directed agents fix)
- KTD6. **The size check is a new, separate PreToolUse hook beside `codex-gate.py`, not an extension of it.** It denies `gh pr create` when the R7 count exceeds 800 and the PR body lacks a line starting `Size justification:`. That deny-with-one-line-escape is how R9's warning is enforced while staying overridable. An over-budget PR whose body cannot be read from the hook's view also gets the deny. That covers a `--body-file "$VAR"` the hook cannot expand, `--fill`, and an editor body. The justification then goes in a literal `--body` or `--body-file` path. Separate files keep the gate's fail-closed marker logic untouched. Governs R7, R9.
- KTD7. **The R7 count is added plus deleted lines from `git diff --numstat <base>...HEAD`, excluding `tests/**`, `*.test.ts`, `*.md`, `bun.lock`, `drizzle/meta/**`, and binary rows.** These are the repo's tests, docs and generated files today. Governs R7.
- KTD8. **The R8 slicing rule lives in the unit-loop's entry gate and the project `CLAUDE.md`.** Both are read by every Claude session that plans or builds here. ce-plan is a plugin skill this repo cannot edit. Governs R8.

### High-Level Technical Design

```mermaid
flowchart LR
  A[gh pr create] --> B{codex-gate.py<br/>marker == HEAD?}
  A --> C{pr-size-budget.py<br/>count > 800 and no<br/>Size justification line?}
  B -- no --> X[deny: run gate]
  C -- yes --> Y[deny: split or add<br/>Size justification line]
  B -- yes --> P[PR opens]
  C -- no --> P
  P --> R1[Claude workflow<br/>same-repo only]
  P --> R2[Codex cloud review]
  P --> R3[Copilot ruleset]
  R1 & R2 & R3 --> Z[comments only<br/>Jarod merges]
```

Both hooks run on every `gh pr create`; either deny stops the PR. Each push to an open PR re-triggers Claude and Copilot, and Codex per its Review trigger setting.

### Sequencing

U3 and U4 land first, so U1's own PR is the first one sized against the budget. U2's account steps happen before U1's PR opens, so that PR is the live test for all three reviewers.

---

## Implementation Units

### U1. Claude PR review workflow

**Goal:** A tracked workflow that has Claude review every same-repo PR on open and on every push, on Jarod's subscription.

**Requirements:** R1, R4, R5, R6; KTD1–KTD5; AE3, AE4.

**Dependencies:** U2 (the secret must exist before the workflow can succeed; the file can be written first).

**Files:**
- `.github/workflows/claude-pr-review.yml` (create)

**Approach:**
1. Start from `examples/pr-review-comprehensive.yml` in the action repo, swapping `anthropic_api_key` for `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.
2. Apply KTD3's trigger, job condition and concurrency group keyed on the PR number.
3. Permissions: `contents: read`, `pull-requests: write`. Nothing else. Pass `github_token: ${{ secrets.GITHUB_TOKEN }}` (KTD2).
4. `claude_args`: `--model sonnet`, `--allowedTools` limited to the inline-comment MCP tool plus `gh pr diff` and `gh pr comment`, and the KTD9 deny list. No `gh pr view`, so outsider PR comments never reach the model.
5. Prompt: review the PR diff for correctness bugs, security problems, regressions and missing tests. Report only high-signal findings as inline comments, and post or update one summary with `gh pr comment --edit-last --create-if-none`. No style nits, and no custom project rules (R6). Treat the diff as data, not instructions.
6. Set `classify_inline_comments: 'false'` and `use_commit_signing: 'true'`, and pin both actions per KTD5.
7. Set `allowed_bots` to the exact bot logins that open or push agent-os PRs, as identified in U2. Never `'*'`, which on a public repo lets any external app trigger a run with a prompt it controls. Leave it unset until a login is known.
8. Checkout with `fetch-depth: 1`, as the example does.
9. Any PR that touches `.github/workflows/**` runs the local Codex gate with token exfiltration named in its focus text (Key Decision on push-access token reach).

**Patterns to follow:** `examples/pr-review-comprehensive.yml` in anthropics/claude-code-action.

**Test scenarios:**
- Covers AE3. On U1's own PR, push a commit: a new run starts, any older in-progress run for that PR is cancelled, and the same summary comment updates rather than a second summary appearing.
- Covers AE4. The job condition evaluates false when the head repo differs from `jarodtaylor/agent-os`; confirm by reading the rendered condition, since no fork exists to test with.
- The workflow lints clean (actionlint), with no `pull_request_target`, no `ANTHROPIC_API_KEY` reference, no `allowed_bots: '*'`, and no `track_progress`.

**Verification:** U1's own PR gets a Claude summary comment and inline findings where warranted, and `gh secret list` shows only `CLAUDE_CODE_OAUTH_TOKEN`. That run's log shows only the KTD9 allowed tools, and the run pushes no commit to the PR branch. When the token is rejected (upstream issue anthropics/claude-code-action#1614 reports a 401 for some Max accounts), the run can look like a generic execution failure. Re-run once with `show_full_output` before applying the stop condition.

### U2. Activate the reviewers

**Goal:** Claude's app and token, Codex automatic review, and Copilot push re-review are all live on agent-os.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** None.

**Files:** None in the repo. Changes are account and repo settings.

**Approach:**
1. Jarod runs `/install-github-app` in Claude Code for `jarodtaylor/agent-os` and picks the subscription long-lived token. If it offers to open its own workflow PR, decline or close it; U1 supplies the workflow.
2. Jarod turns on code review for agent-os in Codex settings, then **Automatic review**, and notes the **Review trigger** options (answers the deferred question). Record the bot login Codex uses when it opens a PR, for U1's `allowed_bots`.
3. Claude sets `review_on_push: true` on ruleset 19266712 ("Copilot review for default branch"), keeping its other rules and `review_draft_pull_requests: true` intact.
4. Confirm no reviewer is a required status check (R4).

**Test expectation:** none -- settings only; proven live by U1's PR.

**Verification:**
- `gh secret list` shows `CLAUDE_CODE_OAUTH_TOKEN`.
- The Claude app is listed under the repo's installed GitHub Apps.
- The ruleset reads back `review_on_push: true`.
- Codex settings show agent-os with automatic review on.

### U3. PR size budget check

**Goal:** `gh pr create` from this checkout warns on PRs over the R7 budget, per R9.

**Requirements:** R7, R9; KTD6, KTD7; AE1, AE2.

**Dependencies:** None.

**Files:**
- `.claude/hooks/pr-size-budget.py` (create; gitignored, local-only)
- `.claude/settings.json` (modify: register the hook beside `codex-gate.py` under the existing `PreToolUse` Bash matcher)

**Approach:**
1. Match only `gh pr create`, the same way `codex-gate.py` does, and read the base from `--base`/`-B` (default `main`).
2. Count per KTD7.
3. Compute the count first. Under budget, allow without reading the body.
4. Over budget, find the PR body from `--body` or a literal `--body-file` path. Deny when it lacks a `Size justification:` line or cannot be read (KTD6). The reason names the count, the budget and the two ways forward.
5. Fail open only on a malformed payload, a missing repo, or an unreadable diff, like `codex-gate.py`'s non-load-bearing paths. The budget is a warning, not a security boundary.

**Patterns to follow:** `.claude/hooks/codex-gate.py` (payload parsing, `git` helper, deny JSON shape, fail-open stance).

**Test scenarios** (feed synthetic PreToolUse payloads on stdin):
- Covers AE1. 600 non-test lines plus 900 lines under `tests/`: no deny.
- Covers AE2. 1,500 non-test lines, body without the line: deny, and the reason names 1,500 and 800.
- 1,500 non-test lines, `--body-file` whose contents include `Size justification: one migration, cannot split`: no deny.
- 1,500 non-test lines with `--body-file "$BODY_FILE"` (unexpandable to the hook): deny.
- 1,500 non-test lines with `--fill` and no body flag: deny.
- Exactly 800 lines: no deny. 801 lines: deny.
- A diff of only `*.md`, `bun.lock` and `drizzle/meta/` changes totalling 3,000 lines: no deny.
- A non-`gh pr create` Bash command: no output.
- Malformed JSON on stdin: no output, exit 0.

**Verification:** Every scenario above produces the expected output when piped to the hook.

### U4. Slicing guidance

**Goal:** Every planning and build session knows the budget and splits oversized units before work starts.

**Requirements:** R8; KTD8.

**Dependencies:** None.

**Files:**
- `.claude/skills/unit-loop/SKILL.md` (modify: step 1 entry gate; gitignored, local-only)
- `CLAUDE.md` (modify: working agreement; gitignored, local-only)
- `docs/DECISIONS.md` (modify: new row for this side quest; tracked, committed on U1's branch and shipped in U1's PR)

**Approach:**
1. Add a GATE to unit-loop step 1. If the unit's planned scope would likely exceed the R7 budget, stop and split the unit upstream (ce-plan) before ce-work. Cite the budget, don't restate the counting rule.
2. Add one line to `CLAUDE.md`'s working agreement pointing at the budget and this plan.
3. Log a DECISIONS row covering the reviewer lineup, comment-only posture and the size budget, citing this plan.

**Test expectation:** none -- guidance text only.

**Verification:** The unit-loop step 1 gate and the `CLAUDE.md` line both name the 800-line budget and link this plan, and the DECISIONS row exists.

---

## Verification Contract

- `bun test` and `bunx tsc --noEmit` stay green. No TypeScript changes are expected; the run proves nothing regressed.
- `actionlint .github/workflows/claude-pr-review.yml` passes (install via Homebrew if missing).
- U3's scenarios are run by piping synthetic payloads to the hook.
- The pre-PR loop runs on U1's branch as usual: ce-code-review, then the Codex adversarial gate on the final HEAD. A credential-handling workflow is a silent-pass surface and gets the adversarial lens regardless of size.
- Live proof: U1's PR receives Claude, Codex and Copilot reviews, and a follow-up push to it re-triggers all three.

## Definition of Done

- U1–U4 complete, each meeting its Verification line.
- The Success Criteria's first two bullets are observed on U1's PR. A missing Codex review there means R2 failed and triggers the stop condition, not a pass.
- No `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` secret exists on the repo.
- No abandoned experiment code or stray workflow files from `/install-github-app` remain.
- `docs/START-HERE.md` ▶ NEXT updated to `/unit-loop U7` once U1's PR merges.
