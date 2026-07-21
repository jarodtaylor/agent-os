---
title: A byte-identity write contract must be byte-exact on the no-op READ side, not just the serialize side
date: 2026-07-21
category: docs/solutions/architecture-patterns
module: configwrite (U14 config-write engine)
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - Extending a write engine that merges/canonicalizes structured formats (JSON/TOML/YAML) with an opaque "byte-identical copy" format (whole-file text, verbatim passthrough)
  - The engine's idempotence/no-op short-circuit reuses a shared comparison that decodes the on-disk file as text (readFileSync(path, "utf8")) before comparing
  - You audited the SERIALIZE (write) side for byte-fidelity but not the NO-OP (read) side that decides whether to write at all
  - A new format promises "byte-identical" while riding a shared read path built for formats that never made that promise
tags: [config-write, idempotence, no-op, byte-identity, verbatim, utf8-lossy, opaque-format, adversarial-review, write-boundary-validation]
related_components: [configwrite, provision, install]
---

# A byte-identity write contract must be byte-exact on the no-op READ side, not just the serialize side

## Context

U10 U2 added an opaque whole-file `text` format to the U14 config-write engine (`src/configwrite/engine.ts`) so the same backup / atomic-write / undo discipline that mutates structured configs (JSON/TOML/YAML) could also publish whole files — markdown role files, extension-less configs — **byte-identically** to their blueprint source (R7, KTD1). "Byte-identical" is the load-bearing promise: U10's `copy` transform means an exact byte copy, and idempotence (re-apply is a true no-op) depends on it.

The serialize side was built correctly for that promise. `serializeConfig` gained an early return that hands `text` content back **verbatim**, *before* the trailing-newline canonicalization the structured formats apply — so a source ending in zero or multiple newlines round-trips byte-for-byte. That change was reviewed, tested, and (rightly) treated as the load-bearing one.

The trap was one level away, on the **read** side. The engine's no-op short-circuit — the check that decides whether to write at all — is shared across every format and compared decoded strings:

```ts
const currentText = existed ? readFileSync(targetPath, "utf8") : undefined;
// ...
if (existed && nextText === currentText) { /* no-op: skip write/backup/journal */ }
```

`readFileSync(path, "utf8")` is a **lossy** decode: invalid byte sequences collapse to the U+FFFD replacement character. So a target whose raw on-disk bytes differ from the new content but *decode-equal* (e.g. an on-disk `0x80` byte decodes to U+FFFD, and the content is a literal U+FFFD) registers as a no-op — the engine skips the write and leaves the wrong bytes on disk, **silently violating the exact byte-identity contract the verbatim serialize was added to guarantee.**

The in-process code review flagged this only as a narrow residual ("pre-existing shared behavior, unreachable for well-formed UTF-8 targets"). The **cross-model adversarial gate (Codex) escalated it to a must-fix**: the new format makes a byte-identity claim the shared read path cannot honor, so the claim is false in the general case regardless of how rare the trigger is.

## Guidance

**When you add an opaque / byte-exact format to an engine whose shared comparison path decodes text, the idempotence check inherits that lossy decode and quietly breaks the new contract. A byte-identity guarantee must be byte-exact on BOTH sides of the write: the serialize (write) side AND the no-op (read) side. Auditing only the write side is the trap** — the write side is where the promise is *visible*, so it gets the scrutiny; the no-op comparison is where the promise is silently *decided*, so it gets missed.

The fix is to compare the format's native unit. For a byte-exact format, compare bytes, not decoded strings — and keep the structured formats on their existing (canonicalized) string compare so there is zero regression risk to the safety-critical shared path:

```ts
// text compares rendered BYTES to raw file bytes; json/toml/yaml keep the string compare, unchanged.
const isNoop = existed &&
  (format === "text"
    ? Buffer.from(nextText).equals(readFileSync(targetPath))
    : nextText === currentText);
```

(`src/configwrite/engine.ts:325`.)

## Why This Matters

A silent false no-op is the worst failure mode for a write engine: it reports success, writes nothing, and leaves divergent bytes — the caller believes the file was provisioned correctly. For U10 provisioning this would mean a role file that looks applied but carries stale content, with no error and no drift signal (a re-`apply` keeps no-op'ing). The verbatim serialize would have taken the blame for "byte-identical copy doesn't work" while the actual defect lived in a comparison nobody changed.

This is the **inverse** failure mode of the sibling learning [[presence-semantics-not-byte-level-noop-checks]], on the *same* no-op-comparison surface. That one is about a byte-compare being too **strict** for structured formats — reserializing a foreign-formatted file through a canonical formatter produces different bytes for a semantically-unchanged tree, so the engine falsely writes (false-positive churn). This one is about a decoded-string compare being too **loose** for an opaque format — a lossy decode makes genuinely-different bytes compare equal, so the engine falsely skips (false-negative silent skip). Same surface, opposite direction: **the no-op comparison must match the format's own notion of "same" — semantic for parse-reserialize formats, byte-exact for opaque ones.**

## When to Apply

- Adding any verbatim / passthrough / byte-exact format to an engine that also does parse-and-reserialize on other formats.
- Any time a new format makes a fidelity promise ("byte-identical", "lossless", "preserves X") that an *existing shared code path* — especially a read or comparison path — was not built to keep. Audit the whole read→compare→write loop against the new promise, not just the write.
- Reviewing an idempotence/no-op short-circuit: ask "what does the comparison decode or normalize, and does that lose information the contract promises to preserve?"

## Related: validate at the write boundary when the read schema is stricter

The same unit surfaced a second, smaller instance of "the write side quietly betrays a contract the read side enforces." U2 added optional `batchId`/`projectRoot` fields to the `UndoEntry` journal record, stamped into the entry by the shared `publish()`. The **read** schema requires non-empty strings (`z.string().min(1)`), but the **write** path did no validation — so a caller passing an empty or partial batch value would append a journal row that `listUndo` then silently drops on read, leaving a mutation that returned success and an undo id but is un-undoable (the row that would reverse it is invisible).

The fix mirrors the main lesson: **enforce the read schema's invariant at the write boundary, fail-closed, before any side effect** (`src/configwrite/engine.ts:262-273`) — both-or-neither and non-empty, refused before the file is touched. A write path must never be able to emit a record its own read schema will reject; if it can, "success" and "recoverable" have silently diverged. This is a write-side application of the per-caller failure-policy discipline in [[one-pure-extractor-per-caller-failure-policy]] — the shared core stays total, and the precondition is enforced loudly at the boundary rather than discovered as corruption on read.

## Prevention

- When a shared comparison/serialization path serves multiple formats, make the format's fidelity contract explicit per format, and check each format's no-op against *its own* unit (bytes vs semantic value) — not against whatever the shared path historically decoded.
- Treat "we audited the write side" as half a review for any fidelity claim. The decision to *not* write is as much part of the contract as the write itself.
- Lean on the cross-model adversarial gate for exactly this class: an in-process reviewer that shares the author's mental model tends to accept "narrow, unreachable for real inputs"; an independent model judges the *contract*, not the *likelihood*, and is what caught both instances here.
