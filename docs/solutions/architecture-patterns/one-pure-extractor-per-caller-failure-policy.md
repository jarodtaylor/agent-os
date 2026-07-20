---
title: One pure/total extractor, failure policy chosen per caller
date: 2026-07-20
category: docs/solutions/architecture-patterns
module: codex-credential (shared parse/extract across gate + installer)
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - The same file/config is read by two or more consumers that need DIFFERENT failure behavior (one must fail closed and keep serving, another must fail loud and abort)
  - You are tempted to bake a try/catch policy (throw vs return-null vs log-and-continue) into a shared parse/extract helper
  - Single-sourcing a value (a credential, a setting) into one location read by several code paths, and worried one path's error handling will be wrong for another
  - A shared reader "consolidation" is proposed that would force one failure mode onto callers that need the opposite
tags: [shared-reader, failure-policy, fail-closed, fail-loud, fail-soft, pure-function, total-function, single-source, credential, parsing, separation-of-concerns]
related_components: [codex-credential, server, install, scan, configwrite]
---

# One pure/total extractor, failure policy chosen per caller

## Context

Issue #24 single-sourced the Codex credential into `~/.codex/config.toml` (PR #41): one file, read by
consumers with **opposite** failure requirements.

- The **security gate** reads the credential on every request. It must **fail closed** — a config it
  can't read, or that's corrupt, grants *nothing* — and it must **never throw** into the auth path (a
  throw there is a 500, not a clean 403, and a hang would take down the daemon).
- The **installer** reads the *same file* to decide whether to reuse an embedded token or mint one. It
  must **fail loud** — refuse to install *over* a config it can't parse, rather than silently clobber it.

The naive move is to put a `try/catch` policy inside the shared reader. But there is no single policy
that's correct for both callers: whatever you bake in is wrong for one of them.

## Guidance

**Make the shared function pure and total — it never throws and never logs; it returns a value (or
`null`). Layer each caller's failure policy *on top*, outside the shared function.**

In `src/codex-credential.ts`:

- `extractCodexToken(config: unknown): string | null` (`src/codex-credential.ts:58`) is **pure and
  total** — for *every* malformed shape (non-object, missing table, wrong type, empty/whitespace value)
  it returns `null`. No throw, no I/O, no logging. It is trivially testable as a table of
  input → `null | token`.
- `readCodexToken(configPath): string | null` (`src/codex-credential.ts:79`) is the **fail-closed**
  reader — absent / unreadable / non-regular / oversized / corrupt-TOML all collapse to `null`. This is
  the one the gate (`src/server/security.ts:111`) *and* uninstall's revocation check both call, so
  "what the gate accepts" and "what uninstall proved is gone" are the same function — they cannot drift.

The **installer keeps its own fail-loud policy** in a separate reader: `readToml` throws
`"existing '<path>' is not valid TOML — fix or remove it before installing"`
(`src/install/codex.ts:98-103`), then calls the *same* pure `extractCodexToken` on the parsed object to
decide reuse-vs-mint. Same extraction logic; opposite I/O-failure policy; chosen by the caller.

This is the design move that made single-sourcing *clean* — neither consumer had to accept the other's
error handling.

## Why This Matters

- **A shared reader with a baked-in policy forces a wrong behavior on some caller.** Throwing is right
  for the installer and catastrophic for the gate; returning `null` is right for the gate and dangerous
  for the installer (it would install over a broken config). Neither belongs *inside* the shared code.
- **Purity is what makes the shared core trustworthy on a hot path.** The gate calls the reader on every
  request; a total extractor that provably never throws is the difference between a clean 403 and a 500
  (or, with an unbounded read on a FIFO, a hung daemon — which is why `readCodexToken` also carries the
  regular-file + size guard mirrored from `src/scan/internal.ts:134`).
- **One reader, one source of truth for "is there a credential here?"** Because the gate and the
  uninstall verifier call the identical `readCodexToken`, the class of "the two copies disagree" bugs
  that this whole unit existed to kill cannot reappear through divergent readers.

## When to Apply

Reach for this whenever the **same** parse/read is needed by callers with **different** failure
contracts. The tell is a code-review "consolidate these two readers" suggestion where the readers differ
*only* in their catch block — that difference is load-bearing, not duplication. Keep the pure
parse/extract shared; keep the policy (throw / return-null / log-and-degrade) at each call site.

## Examples

This repo already carried the *inverse-policy, separate-reader* half of this pattern before #24, which
is why the guidance generalizes rather than being credential-specific:

- **Fail-SOFT** scanner readers: `src/scan/internal.ts:134` `readParsed` returns `null` on absent /
  non-regular / oversized / malformed and *degrades one surface*, deliberately the inverse of the
  install-time readers (its own docstring says: "do not 'consolidate' these same-named readers").
- **Fail-LOUD** install readers: `src/install/codex.ts:98` `readToml` and `src/install/shared.ts`'s
  `readJson` throw on a corrupt config to gate a merge *into* it.

#24's contribution was to add the **shared pure extractor** underneath a fail-closed reader, so a *third*
policy (the gate's) could join without forcing any of the three onto the others:

```
                    extractCodexToken(parsed)  ← pure, total, never throws (the shared core)
                     /                    \
   readCodexToken (fail-closed)      installer readToml (fail-loud)
   → gate + uninstall verify         → refuse to install over a broken config
```

Related: [[cross-harness-credential-second-location-race-generator]] (the *why* single-sourcing was
needed); [[presence-semantics-not-byte-level-noop-checks]] (the config-write engine primitive the
installer's reuse-not-rotate no-op relies on).
