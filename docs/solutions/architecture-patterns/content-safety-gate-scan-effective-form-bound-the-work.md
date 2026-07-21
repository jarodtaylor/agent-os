---
title: Hardening a scan-then-certify content-safety gate — scan the effective form, bound the work, be honest about scope
date: 2026-07-21
category: docs/solutions/architecture-patterns
module: provision/blueprint front-gate (generalizes to the redaction choke-point)
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - Building a gate that reads content and CERTIFIES a property over it ("no secret escapes", "no PII", "safe to publish") before a downstream step acts on it
  - The content is a serialized format that gets PARSED/DECODED downstream (JSON, TOML, YAML, base64, URL-encoding) — the bytes you scan are not the bytes that get used
  - Reusing a shared scanner/classifier/validator in a NEW caller that feeds it larger inputs than its original caller ever did
  - A gate's docstring or a plan says it "certifies X" or "never hangs" — and you have not written down exactly what X covers and what it defers
tags: [content-safety-gate, secret-scanning, redaction, normalization-vs-raw, encoding-escape, redos, cardinality, safeparse, bounded-work, no-hang, shared-primitive, scope-honesty, adversarial-review]
related_components: [provision, capture, redact, contract]
---

# Hardening a scan-then-certify content-safety gate — scan the effective form, bound the work, be honest about scope

## Context

U10's blueprint loader is a *front-gate*: it reads every file a project blueprint references, runs a secret classifier + a machine-path check over the content, and returns `loaded` — a certification that "no secret or machine-specific path escapes into what gets provisioned" (R4). It is one small pure function (`gateContents` in `src/provision/blueprint.ts`), and the review + adversarial layers found **three independent ways it silently under-certified** — all on the same gate, all generalizing to any scan-then-certify gate (the redaction choke-point in `src/redact/` is the same shape: read → classify → present). Documenting the cluster, not the one fix, is the point: these are the three failure axes of the pattern.

## Guidance

A gate that scans content and certifies a property is only as strong as three things. Check all three, every time.

### 1. Scan the EFFECTIVE form, not just the raw bytes — but keep the raw scan too

If the content is a format that gets parsed/decoded before use, the bytes you scan are not the bytes that get used. A secret hidden behind an encoding escape reads clean as raw bytes and *decodes* into the certified result.

```jsonc
// raw manifest bytes — the classifier sees "sk-ant-api03-…", the sk- regex breaks at the backslash → no match
{ "model": "sk-ant-api03-ABCDEFGHIJKLMNOP1234" }
// JSON.parse decodes it → loaded.manifest.model === "sk-ant-api03-…" (the live secret), certified clean
```

The fix is to scan **both** the raw bytes **and** the parsed-then-reserialized (normalized) form — and you need both, because each catches what the other misses:

- **Raw only** misses encoding escapes (`\uXXXX`, `/` for `/`).
- **Normalized only** misses parse-lossy drops: JSON duplicate-key last-wins means `{"model":"sk-…","model":"clean"}` reserializes to just `clean`, dropping a secret the raw bytes still carry.

```ts
// src/provision/blueprint.ts — gateContents
const manifestHit =
  scanContent(MANIFEST_FILENAME, manifestRaw) ?? scanContent(MANIFEST_FILENAME, JSON.stringify(manifest));
```

### 2. Bounded input SIZE is not bounded WORK

A byte cap on the input (here: a 16 MiB read cap, mirrored from `src/scan/internal.ts`) does not bound the work done over it. Two amplifiers surfaced:

- **Validator issue-amplification.** `zod`'s `safeParse` materializes a validation issue *per invalid member*. A 16 MiB array of millions of nulls → millions of issue objects → OOM/stall, despite the byte cap. Fix: a **content-free cardinality preflight** that caps the array dimensions *before* the validator runs (`withinCardinalityBudget` in `src/provision/blueprint.ts` → returns `invalid: "too-large"`). The same caps bound the per-source read loop, so a manifest that declares a million sources is rejected before a million `stat`s happen.
- **Classifier super-linearity (ReDoS-class) — and why the "obvious" fix is a trap.** A regex with unbounded greedy runs around a keyword — `[A-Za-z0-9_]*KEYWORD[A-Za-z0-9_]*…[:=]` — is O(n²) on keyword-dense input. It was fine for years because its *original* caller (capture-time) fed it small tool-output chunks; it became a multi-second hang the moment a new caller ran it over whole files (500 KB of the keyword did not finish in 30 s). The tempting fix — bound the quantifiers (`* → {0,64}`) — is **wrong**, and adversarial review proved it empirically: any *finite* bound trades the hang for a **false-negative** (a secret whose identifier is longer than the bound now evades detection — and in a *shared* classifier, so capture-time redaction regresses too), and it is **whack-a-mole** (a second pattern, the JWT `eyJ…` alternative, is independently quadratic). The only fix that preserves BOTH no-hang and fail-closed detection is a **single-pass linear scanner** — a coherent redesign of the shared primitive, so it belongs in its own unit, not a review-fold. Deferred (issue #42); the gate does not modify the classifier. **The lesson: a quantifier bound is not a ReDoS fix for a *detector* — it converts a liveness bug into a correctness bug.**

### 3. Say what "certified" actually covers — defer the rest by construction, not by silence

A gate that punts part of its own invariant to a future caller ("U3 will re-scan the parsed config sources") is fragile *if the punt is implicit*. Make the deferral explicit, documented at the boundary, and enforced by a test in the unit that owns it. The `gateContents` docstring now states exactly what a `loaded` result certifies (manifest in both forms; whole-file sources as raw bytes) and what it defers (config-format *sources'* effective form → U3's render, which re-runs the gate on parsed forms per KTD7). Deferred by construction, with U3 owning it as a tested requirement — not a silent gap a future reader has to rediscover.

## Why This Matters

The gate's whole value is the certification. Each axis is a way the certification is a quiet lie:

- **Wrong form** → a real secret ships into a provisioned config while the gate said `loaded`. This is a security-boundary breach, not a nicety — it was empirically reproduced (`JSON.stringify(loaded.manifest).includes(SECRET) === true`).
- **Unbounded work** → the gate (and every verb built on it) hangs or OOMs on a bounded-size input, breaking the very no-hang property the read cap was supposed to provide.
- **Silent scope** → the next unit inherits an invariant it doesn't know it owns, and the gap surfaces at the worst time.

There is a fourth, protective lesson: **a written threat model is what keeps the fix proportionate.** The adversarial gate (Codex) reasons from unconditional invariants and will keep escalating — "cap cumulative bytes, thread a byte budget into every read, cap every absolute path form." Decision #45 (this is a *local single-user tool operating on the user's own files*; in-scope = no-secret-escape + no-hang; out = adversary-injected code, attacker-owns-HOME) is what distinguishes the genuine folds (a cheap cardinality cap; a quantifier bound) from over-engineering a fortress against the tool's own author. See [an-unwritten-threat-model-is-why-the-adversarial-gate-loops](../conventions/an-unwritten-threat-model-is-why-the-adversarial-gate-loops.md). Without the written scope, this fold would have tripled in size and still "failed" the gate.

## When to Apply

- Before shipping any read→classify→certify gate (secret scan, PII scan, publish-safety, redaction choke-point).
- Whenever a gate's input is a serialized/encoded format — ask "what does this become after parse/decode, and am I scanning that?"
- Whenever you reuse a shared scanner/classifier/parser in a new caller — re-check its complexity profile against the new caller's input scale, because the shared primitive was tuned for the *old* caller's inputs.
- Whenever you write "certifies X" or "never hangs" in a docstring or plan — write the exact scope next to it, and defer the remainder to a named, tested owner.

## Examples

Bug → fix, per axis:

```text
Axis 1 (form):   raw-scan("model":"sk-ant-api03-…")  → no match → loaded  (BUG: decodes to a live secret)
                 + scan(JSON.stringify(parsed))            → match   → secret-hit  (FIX)

Axis 2 (work):   safeParse(16 MiB of [null,null,…])        → millions of issues → OOM   (BUG)
                 cardinality preflight before safeParse     → invalid:"too-large"        (FIX)
                 classifier O(n^2) on keyword/eyJ-dense text→ hang on a large source     (BUG)
                 quantifier bound {0,64}                    → false-negative + whack-a-mole (WRONG FIX)
                 single-pass linear scanner                 → the only real fix (DEFERRED, own unit)

Axis 3 (scope):  docstring: "scans blueprint contents"      → reader assumes ALL forms   (BUG)
                 docstring: "manifest raw+normalized, sources as bytes; config-source
                 effective form scanned at U3 render (KTD7), a tested requirement"       (FIX)
```

Regression tests for the *fixed* axes live in `tests/provision-blueprint.test.ts` (Axis 1 escaped-secret → `secret-hit`; Axis 2 cardinality → `too-large`). The classifier ReDoS (Axis 2, second half) is **deferred, not fixed here** — a finite quantifier bound would regress detection, and the linear rewrite is its own unit.

## Related

- [presence-semantics-not-byte-level-noop-checks](./presence-semantics-not-byte-level-noop-checks.md) — the read-side cousin (compare parsed values, not bytes); Axis 1 is the same "the bytes are not the meaning" insight applied to a security scan.
- [one-pure-extractor-per-caller-failure-policy](./one-pure-extractor-per-caller-failure-policy.md) — the loader is pure/total and each caller layers policy; here a *shared* primitive (the classifier) had a complexity profile a new caller broke.
- [an-unwritten-threat-model-is-why-the-adversarial-gate-loops](../conventions/an-unwritten-threat-model-is-why-the-adversarial-gate-loops.md) — the written scope (decision #45) that kept these folds proportionate.
