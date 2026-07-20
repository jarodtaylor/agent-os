---
title: Cross-harness credential integration — a second token location is a lifecycle-race generator
date: 2026-07-09
last_updated: 2026-07-20
category: docs/solutions/architecture-patterns
module: install/server security (multi-harness credential)
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - Integrating a new agent harness/runtime whose auth model differs from the one your reference integration assumed (e.g. a static-only header vs a dynamic per-call headers helper)
  - You are forced to EMBED a stable credential in a config file a foreign harness owns, creating a second copy of a secret that already lives somewhere your own code reads
  - An adversarial reviewer keeps finding a NEW edge in the same credential-lifecycle surface across successive passes (not re-finding the same one)
  - You are deciding whether to patch the Nth lifecycle race or revisit the credential model itself
tags: [credential, secret-lifecycle, single-source, source-of-truth, toctou, race, adversarial-review, cross-model, reconsider-trigger, install, mcp, codex]
related_components: [install, server, paths, mcp, configwrite]
---

# Cross-harness credential integration — a second token location is a lifecycle-race generator

## Context

The substrate authenticates every local caller with a per-boot token the security gate holds in memory. The **reference** harness integration (Claude Code, U6) delivered that token through a **dynamic per-call headers helper** (`hooks/mcp-headers.ts`): the token is read from its file *at call time* and never written into any installed config. "Installed config never embeds the secret" held for free.

Integrating the **second** harness (Codex, U8) broke that assumption. Codex's HTTP-MCP client sends only a **static** header — there is no per-connection helper hook — so it cannot ride a rotating per-boot token. The only shape its client supports is a **stable credential embedded in a config file it owns** (`~/.codex/config.toml`'s `mcp_servers.agent-os.http_headers`, mirroring how that file already stores every other server's bearer). That embedding is the whole story: the token now lives in **two places** — the `codex.token` file the gate reads (`src/server/security.ts` `makeStableTokenReader`) and the copy inside `config.toml` that Codex sends.

## Guidance

**A single secret stored in two locations is a lifecycle-race generator.** The two copies must be kept in agreement across the *entire* credential lifecycle — mint, embed, accept, revoke, failed-install cleanup, concurrent install, concurrent uninstall — and every one of those is a place they can desync. That surface is combinatorial, and it shows up as an adversarial reviewer finding a **new, distinct** edge on **every** pass rather than re-finding one bug:

1. server-vs-installer **mint race** (two minters) → made the installer the sole minter;
2. **next-boot-only revocation** → gate reads `codex.token` fresh per request (live revocation);
3. **failed install strands / wrongly revokes** the credential → rollback deletes only a token *this* install minted;
4. **empty-file provenance** → the pre-check reads token *semantics*, not `existsSync`;
5. a concurrent install/uninstall **TOCTOU** between the `tokenPreexisted` snapshot and the later mint/rollback decision (`src/install/codex.ts`).

Four patches bought soundness for the single-process path; the fifth edge was the tell.

**Three rules that follow:**

- **When an adversarial gate finds a *new* lifecycle edge every pass, the MODEL is the cost — not any single bug.** Re-finding the same bug means "not fixed yet." Finding a *different* edge each pass means the surface itself is too large. Stop treating passes as a checklist to burn down.
- **Set a reconsider trigger at first adoption, then COUNT the recurrence.** When you adopt a model you are not sure of, record the fallback in the decision itself: *"if this proves recurrently costly, revisit the model — here are the named alternatives."* Then the Nth pass is a *measured* signal against a recorded rationale, not a rediscovery. (Here: DECISIONS #28 set it; #29 fired it at pass 5.)
- **When the trigger fires, the resolution is usually SUBTRACTIVE, not patch N+1.** The fix for a two-location race is not a better sync — it is **one location**. Make the gate read the token straight from the config the harness already owns; delete the second file and its whole mint/provenance/revoke apparatus. The finding class dissolves because there is nothing left to keep in sync (**shipped: PR #41 / issue #24, single-source Codex credential** — see the Update below).

## Why This Matters

Each patch to a two-location credential lifecycle makes the code *look* more correct while the underlying surface stays exactly as large, so the next adversarial pass finds the next edge and the loop never converges. Naming the recurrence up front (the reconsider trigger) converts an open-ended patch spiral into a bounded decision: *N passes → revisit the model*. And the subtractive resolution is strictly better than the sum of the patches — it removes the reason the edges exist rather than closing them one at a time.

There is a second, orthogonal payoff. **The cross-model adversarial gate found what the same-family reviewers could not.** Six in-process reviewers (all the same model family as the author) passed this credential lifecycle; a *different* model family (Codex, driven by `~/.claude/scripts/codex-adversarial-review.sh`) surfaced the concurrency/lifecycle races on pass after pass. Same-family reviewers share blind spots — they reason like the author. A different family probes different failure modes. That is the concrete argument for keeping a cross-model gate as a *required* loop step, not an optional nicety.

## When to Apply

- Onboarding **any** new harness/runtime (Hermes, Cursor, Antigravity, OpenCode…) whose credential delivery differs from Claude Code's headers-helper model. **Before embedding a stable token, ask: "does this create a second source of truth for the secret?"** If yes, prefer **single-source from the start** — have the consumer read the credential from the *one* place the harness already stores it, so revocation is "remove the entry" and there is no second copy to reconcile.
- Any time an adversarial or security reviewer returns a *different* finding in the *same* subsystem on consecutive passes. That pattern — not the severity of any one finding — is the signal to step back to the model.
- Any secret, config value, or piece of derived state that you are about to persist in two places "for convenience." The convenience is front-loaded; the sync cost is paid forever.

## Examples

**The trap (two locations, kept in sync by machinery):**

```
installer ── mints ──▶ codex.token (file)           ◀── gate reads per request
     │                                                     (makeStableTokenReader)
     └── embeds same value ──▶ config.toml http_headers ── Codex sends
         ↑ now: mint race, revoke-both, failed-install-cleanup, provenance,
           concurrent-install TOCTOU … each a place the two copies desync
```

**The subtractive fix (one location, nothing to sync):**

```
installer ── writes token ──▶ config.toml http_headers ── Codex sends
                                     ▲
                                     └── gate parses config.toml per request (mtime-cached)
   revoke = remove/empty the entry.  No codex.token file. No provenance. No mint race.
   The entire finding class is gone because there is no second copy.
```

Clean targeted revocation wants the U14 key-removal primitive (issue #21); the interim path overwrites the header value with `""` via `mergeConfig` (the engine already supports a value write), which the gate reads as revoked.

**Two smaller learnings from the same unit** (noted here rather than as their own docs):

- **Factory-bound extractor preserves the pure tailer seam.** When a harness records session identity only on *line 1* of a rollout file (not per event), a per-file factory that binds an extractor to that line-1 metadata keeps the byte-offset tailer (`src/capture/tailer.ts`) generic — the harness-specific shape stays in one module (`src/capture/codex.ts`), the tailer stays reusable.
- **Fixtures must mirror the real undocumented-format distribution.** An idealized fixture that *always* supplied an `id` masked a real id-collision P1 (Codex `function_call` payloads frequently have no `id`, so call+output shared a `call_id` and first-write-wins dropped the digest). It was caught only by running against ~23 real captured rollouts. When you reverse-engineer an undocumented on-disk format, sample the real distribution — don't fixture the happy path you imagine.

## Related

- `docs/solutions/design-patterns/building-installers-on-the-config-write-engine.md` — the config-write **mechanics** (backup/atomic/undo, cross-file transactionality) this credential model sits on top of; this doc is the credential-**model** complement.
- DECISIONS #28 (the two-location model + the reconsider trigger), #29 (the trigger firing + the ruling: ship the immaterial edge deferred, resolve the root via single-source).
- Issue #24 (single-source Codex credential — the subtractive resolution, **SHIPPED + MERGED PR #41, 2026-07-20**), issue #21 (the U14 key-removal primitive it depends on for pristine revocation).

## Update — resolution shipped (2026-07-20, PR #41 / decision #49)

The subtractive fix this doc predicted **landed**. The gate now reads the credential straight from `~/.codex/config.toml` via `src/codex-credential.ts` (a pure/total `extractCodexToken` + a fail-closed `readCodexToken` shared by the gate *and* uninstall's revocation check); `codex.token` and the whole mint/provenance/revoke apparatus (`resolveCodexToken`, `revokeMintedToken`, `tokenPreexisted`) are **deleted**. The diagnosis above stands as written — a second credential location IS a lifecycle-race generator; the sections narrating "two places" are the *problem being taught*, not current state. Two lifecycle edges that only exist under concurrent invocation of the manual CLI were deferred as out-of-scope (issues #39, #40), consistent with this doc's "the residual is deferred as immaterial" note. The design move that made single-sourcing clean — one pure extractor, failure policy per caller — is captured in [[one-pure-extractor-per-caller-failure-policy]].
