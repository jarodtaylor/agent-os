---
title: A read-only Claude PR reviewer needs agent mode on the job token, not tag mode plus deny lists
date: 2026-10-30
category: docs/solutions/tooling-decisions
module: .github/workflows/claude-pr-review.yml (automated PR review, DECISIONS #61, PR #63)
problem_type: tooling_decision
component: ci
severity: high
applies_when:
  - Configuring anthropics/claude-code-action as an automatic PR reviewer that must only comment, never edit, commit or push
  - The repo is public, so anyone can comment on a PR
  - You want a single summary comment that updates on each push
---

# A read-only Claude PR reviewer needs agent mode on the job token

## The trap

The obvious way to get one summary comment that updates in place is `track_progress: true` plus `use_sticky_comment: true`. In claude-code-action v1.0.265, that combination forces **tag mode**, and tag mode is not a reviewer. It is the `@claude`-mention implementer:

- It always adds `--permission-mode acceptEdits` and `git add/commit/rm` plus a push wrapper to the allowed tools. Its default system prompt says "Always push directly to the existing PR branch". Your custom prompt is only appended as custom instructions.
- It mints the **Claude GitHub App** token through an OIDC exchange. That token carries the App's install permissions (contents: write), so the job's `permissions: contents: read` does **not** bound it. Tag mode also writes that token into the checkout's git remote URL.
- It feeds the PR's existing comments into the prompt. On a public repo that includes comments from outsiders, which is a prompt-injection path to a write-capable token.
- `acceptEdits` auto-approves shell file moves (`cp`, `mv`, `touch`), so denying Edit/Write by name leaves a write path open.

Each fix you can patch in (`--disallowedTools`, `use_commit_signing`, comment-actor filters) closes one surface and leaves the others. Three review layers found three different holes in turn.

## The fix: agent mode plus the job token

- Provide a `prompt` and **no** `track_progress`. That selects agent mode, which adds only the tools you list in `--allowedTools` and does not set `acceptEdits`. A headless run denies anything else that needs approval.
- Pass `github_token: ${{ secrets.GITHUB_TOKEN }}`. No App token is minted, and the credential the run can reach is limited to read code and write PR comments. It expires with the job, and `id-token: write` is no longer needed.
- Don't allow `gh pr view`. Claude reads the PR with `gh pr diff <number>`, so outsider comments never enter the context.
- Get the single updating summary from the prompt: `gh pr comment <n> --edit-last --create-if-none`. This was verified live, with the second push editing the first summary.
- Keep a `--disallowedTools` deny list (Edit/Write/NotebookEdit, the file-ops commit tools, git write commands) as a second layer, and SHA-pin both actions. Use `persist-credentials: false` on checkout.

A side benefit is that the App's "workflow must match the default branch" validation applies only to the App-token path. With the job token, the PR that adds or edits the workflow reviews itself.

## Gotchas confirmed on the way

- `--allowedTools` **pre-approves** tools. It does not shrink the inventory, so built-in Read/Grep/Glob stay available. Describe the boundary honestly: Claude reads the repo but never PR comments.
- A `pull_request` checkout is a detached HEAD, so `gh pr diff` needs the PR number.
- `classify_inline_comments` defaults on and its post-step wants an Anthropic API key. Set it to `"false"` on subscription auth.
- The official `code-review` plugin stops if Claude already commented on the PR, which silently defeats re-review on push. Use a custom prompt.
- By default the action refuses bot-triggered runs. Name agent bots exactly in `allowed_bots`, never `'*'` on a public repo.

## Residual risk accepted

Anyone with push access can edit the workflow in a same-repo PR and reach the subscription token. Fork PRs are skipped. Under decision #45 push access is only the owner and his agents (DECISIONS #61).
