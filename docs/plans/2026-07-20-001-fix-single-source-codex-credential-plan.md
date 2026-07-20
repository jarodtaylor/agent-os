# U24 — Single-source the Codex credential

> **Status:** in flight (2026-07-20) · **Issue:** [#24](https://github.com/jarodtaylor/agent-os/issues/24)
> **Depends on:** #21 (U14 targeted key/array removal) — MERGED (PR #34, decision #42)
> **Refs:** DECISIONS #28 (model + reconsider trigger), #29 (the ruling), U8.

Written 2026-07-20 because `/unit-loop U24` found no plan-file section: the work was scoped in the
issue, not in the slice-1 plan (which tops out at U15). This file is that missing section — the
issue's content, sharpened with the design cruxes surfaced during orientation.

## Goal

Make `~/.codex/config.toml` the **single source of truth** for the stable Codex credential. The gate
reads the token from the same place Codex sends it from, so the two copies can no longer diverge.

## Why (root cause, not symptom)

U8's Codex adversarial gate no-shipped **5 times across 5 passes**, each on a distinct
credential-*lifecycle* edge: mint race, next-boot-only revocation, failed-install strand/revoke,
empty-file provenance, and an install/uninstall TOCTOU. Every one is the same defect generator — the
token lives in **two places** (`codex.token`, which the gate reads; and the copy embedded in
`config.toml`'s `http_headers`, which Codex actually sends) and all five findings are about keeping
them in sync across install / uninstall / failure / concurrency.

Decision #29 shipped U8 anyway and set this as the reconsider trigger. This unit removes **the reason
the class exists**, rather than patching the sixth edge. Mostly subtractive.

## Scope

**Gate** (`src/server/security.ts#makeStableTokenReader`) — read + parse `~/.codex/config.toml` per
request (keep the mtime-cache), extracting `mcp_servers.agent-os.http_headers.<TOKEN_HEADER>`. The
option moves from a data-dir path to a home-relative config path; keep it injectable for tests.

**Installer** (`src/install/codex.ts`) — mint a UUID inline; **reuse the value already embedded in
config.toml** when present. Delete `resolveCodexToken`, `readCodexToken`, `codexTokenPath`,
`revokeMintedToken`, `tokenPreexisted`, and every rollback token-cleanup branch.

**Revocation** — remove the `mcp_servers.agent-os` entry via #21's targeted removal (already the
uninstaller's `removeKeysIfPresent` call). No separate file to delete.

**Wiring** — `src/server/index.ts:48` passes the codex config path instead of `codexTokenPath(dataDir)`.

## Cruxes (hold these through build + review + gate)

1. **Idempotency depends on read-back.** Today re-install no-ops because `resolveCodexToken` returns
   the persisted value. Minting `randomUUID()` unconditionally would rotate the credential on every
   re-install, rewrite config.toml, and churn a live Codex session's token mid-flight. The installer
   MUST read the existing embedded header value and reuse it, minting only when genuinely absent.
   This is the same nested-key extraction the gate needs — **write it once, share it**.
2. **Revocation inverts — this is the center of the change.** Today `rm codex.token` is the loud
   must-succeed revocation and the config-entry strip is best-effort cleanup *backstopped by the token
   file*. After this there is no second-file backstop: the config entry **is** the credential, so a
   failed config strip must become the loud/throw path that the `rm`-verification check is today.
3. **Coverage must migrate, not evaporate.** When the token-file tests are deleted, the behaviours they
   covered — uninstall revokes; a failed strip fails loud; a failed install strands no live credential;
   re-install does not rotate — must **reappear in config.toml form**. (lessons.md: verify coverage
   against what was assigned.)
4. **Fail closed in the auth path.** A TOML parse throw, a missing table, a non-string value, or an
   empty value ⇒ `null` (no stable token accepted). Never a 500, never a fall-through.
5. **Stay subtractive.** No case-insensitive header-key lookup (we write and read one lowercase
   constant). No Claude Code changes — verified 2026-07-20 that the CC installer embeds no token
   (`headersHelper` reads per-call), so there is no twin *credential* to single-source; the
   entry-leftover the issue mentions as a bonus was already fixed by #21.

## Threat model (write it into the codex-gate focus — decision #45)

> The credential is now sourced from a file **Codex owns and rewrites**. What can inject a token,
> expose it, or drop it?

- **Exposure is UNCHANGED.** The token already lived in `config.toml` (U8 decision A — Codex's
  HTTP-MCP client can only send a static header). This unit removes the redundant second copy; it does
  not widen the surface. The install write keeps `targetMode: 0o600`.
- **Injection** requires write access to `~/.codex/config.toml` — an attacker who has that already has
  the user's Codex configuration and can register their own MCP servers. Not a new capability.
- **Drop** (Codex rewrites the file without our entry) ⇒ the gate sees no token ⇒ access revoked.
  Fail-closed, and the correct outcome.

## Acceptance

- Gate accepts the token embedded in `config.toml`; rejects when the entry is absent, empty,
  non-string, or the file is corrupt/unreadable — each fail-closed 403, no 500.
- Rotation/revocation observed **live** (next request, no restart), preserving today's mtime-cache
  behaviour.
- Re-install is a true no-op: the embedded token is reused, config.toml bytes unchanged.
- Uninstall removes `mcp_servers.agent-os`; a strip failure **throws** rather than reporting success.
- A failed install leaves no live credential behind.
- `codex.token` and its whole mint/provenance/revoke machinery are gone from `src/` and `tests/`.
- Full suite green (baseline 444) + `tsc` clean.

## Non-goals

Claude Code installer changes · the mode-lifecycle work (#33) · targetMode no-op (#26) · any new
credential *format* (the token stays an opaque UUID).
