# Open review findings — slice 1

Durable backlog of review findings on `feat/slice-1-substrate`. Captured so they survive session
boundaries — the "don't forget" problem this Agent OS exists to solve. Check this file at session start
until the open list is empty.

Status: `[ ]` open · `[x]` fixed · `[~]` deferred (with reason).

---

## Deferred — the config-write "robustness under partial failure" cluster

Both are real, both are rare + recoverable, and the RIGHT fix depends on the operator/developer UX,
which isn't clear yet. Decided (Jarod + CTO/CPO lens, 2026-07-04): defer until real usage clarifies the
need; don't build speculative complexity against an unknown usage model. KTD9 (one server process,
single writer) is the current mitigation.

- [~] **U14-F3 / G2 — [high] Concurrent merges can lose updates** (`engine.ts`). No per-target lock;
  two processes racing the same file ⇒ last rename wins (atomic, but a lost update — recoverable, the
  journal keeps both backups). **Promotion trigger:** a second out-of-process config writer appears, or
  real usage shows concurrent writes to the same surface.
- [~] **G3(a) — [medium] Undo record can be lost on a crash in the rename→journal window** (`engine.ts`).
  The target is published (rename) before `recordUndo` appends. A crash in that microsecond window leaves
  the config mutated with no journal id — but the backup file is on disk, so it's degraded, not lost.
  Full crash-safety (two-phase journal + fsync of file/parent) is the fix; deferred with the cluster
  above. **Promotion trigger:** same as U14-F3, or a decision to make config-write crash-durable.

---

## Deferred — U2 store residuals (2026-07-04, ce-code-review)

Surfaced by the U2 review (correctness + adversarial at session tier, plus data-migration,
maintainability, project-standards). All are correct under the current locked design; each carries a
promotion trigger so the right fix lands when its usage model is real, not speculatively.

- [x] **U2-R1 → FIXED (2026-07-05, U4) — external MCP writes validated at the boundary.** `write_handoff`
  is the only external write path (KTD9), and it validates the untrusted payload against the contract twice:
  the SDK checks `cursor`/`source` against `Cursor`/`Source` at tool-input, then `Handoff.parse` re-validates
  the fully-assembled record before `repo.writeHandoff`. TS types are never trusted for the untrusted input.
- [~] **U2-R2 — [low] Handoff upsert is latest-write-wins, not ts-guarded** (`repo.ts`). Correct under the
  single-writer, in-order v1. **Promotion trigger:** federation replay / multi-machine sync (v1.1) — then
  guard the upsert so an out-of-order *older* handoff can't clobber a newer one for the same session.
- [~] **U2-R3 — [low] Cross-process `migrate()` race** (`db.ts`). Moot under KTD9 (one server process);
  SQLite file locking + `busy_timeout` + drizzle's `__drizzle_migrations` bookkeeping serialize it
  regardless. **Promotion trigger:** the architecture ever has >1 process opening the same db → flock
  around `migrate()`, or route bootstrap through a single dedicated migrator.
- [~] **U2-R4 — [low] `capture_cursor.byteOffset` has no monotonic guard** (`repo.ts`). A backwards write
  would cause re-reads; masked today by breadcrumb id-idempotency. **Promotion trigger:** a capture-lane
  bug or a non-idempotent raw lane makes re-reads harmful → add a `max(old, new)` guard on write.
- [x] **U2-R5 → DECIDED: hitRate stays GLOBAL (2026-07-05, U4).** U4 wired the real per-tool consumption
  logging (every tool call + `/work-state` read appends to `access_log`). Decision: `hitRate` stays one
  global ratio. VS6's success metric is per-HARNESS hit rate, and `access_log.harness` already carries that
  discriminator (a per-harness breakdown is derivable when U8 needs it); per-PROJECT scoping has no slice-1
  consumer. **Re-open trigger:** the human view (U11) or a metrics surface actually needs a per-project
  breakdown → add a filtered variant then, rather than complicating the one ratio now.
- [x] **U2-R6 → FIXED (2026-07-05, U4) — resume tail is capped.** `readWorkState` / `selectBreadcrumbTrail`
  gained an optional `limit`; the shared external read path (`readWorkStateResponse`) passes
  `DEFAULT_TRAIL_CAP` (50). The cap is applied at the QUERY (most-recent-N via `(ts,id) DESC LIMIT`, reversed
  to ascending), so it bounds server memory as well as the payload, and keeping the newest-N preserves every
  tail-derived field (`lastActivity`, the raw-lane primary). In-process callers that omit `limit` keep the
  unbounded behaviour, so the U2 tests are unchanged. (`query_breadcrumbs` shares the same capped selector.)

---

## Deferred — U3 server residuals (2026-07-04, ce-code-review incl. a Codex cross-model pass)

Surfaced by the U3 review (security + adversarial at session tier, correctness/reliability/standards, plus
a Codex gpt-5.5 adversarial pass). The headline finds — 0.0.0.0 bind → loopback-only; world-readable data
dir → 0700 dir; unlogged /status catch — were FIXED in the branch. These two are deferred with triggers.

- [x] **U3-R1 → FIXED (2026-07-04, Codex adversarial-review) — Concurrent-boot token clobber** (`index.ts`).
  Restructured to bind-THEN-write: an explicit `Bun.serve` binds the port first (throws synchronously on
  EADDRINUSE), so a port-race loser crashes before `writeTokenFile` runs and can't overwrite the live
  instance's token with one no server accepts. `writeTokenFile` also now publishes atomically (temp-write +
  rename) so a concurrent reader never sees a partial token. (Codex rated it medium + "fix before merge";
  bind-before-publish is the correct design regardless.) Was deferred to U6; promoted + fixed instead.
- [x] **U3-R2 → FIXED (2026-07-04, bot review) — `AGENT_OS_PORT` is now validated** (`index.ts`). Was
  `Number(env) || 4319`, which silently defaulted only on `0`/NaN and passed negative / out-of-range values
  through to an opaque `Bun.serve` failure. Now any invalid value (unset, non-numeric, `<= 0`, `> 65535`)
  falls back to the default. (CodeRabbit + the R2 note converged.)
- [~] **U3-R3 — [→ U15] Single-instance lock: pid-file → real `flock` OS lock** (`src/server/single-instance.ts`;
  Codex 3rd adversarial pass; **GH issue #5**). The dataDir pid-file lock catches the COMMON double-run and
  reclaims a crashed holder's stale lock, and the boot now acquires it BEFORE `openDb` touches the store
  (that ordering bug was FIXED). Two edges remain, inherent to a pid-file: a stale-reclaim TOCTOU under
  simultaneous crash-recovery, and a pid-recycle false-positive that could refuse a legitimate restart. Both
  are rare on a personal launchd-supervised daemon and recoverable (`rm agent-os.lock`). **CTO call — pragmatic
  now, tracked fast-follow, NOT silent debt:** launchd (U15) is the production single-instance guarantee,
  nothing reads the token until U6, and a real `flock` lock means introducing Bun FFI (a focused change whose
  natural home is U15, where launchd + the lock are one design). **Promotion trigger:** land the flock lock in
  U15, NO LATER than before U6 ships a real token consumer. Tracked: GH issue #5.

---

## Deferred — U4 residuals (2026-07-05, ce-code-review: 5 personas + a 3-persona simplify pass)

The U4 review found NO redaction leak (security traced all 5 vectors; secret-level data is airtight) and
cleared the redaction co-walk, freshness+cap, the deterministic tiebreak, and idle eviction. The real
findings were FOLDED into the branch: the session-map leak (→ idle-TTL + size-cap eviction), the `logAccess`
coupling (→ best-effort at all 3 sites), the `query_breadcrumbs` same-`ts` page split (→ boundary-group
completion), the `/work-state` bare-text-500 contract (→ `/status`-style JSON 500), and the `LEAF_TYPES`/
`ZodDef` duplication (→ shared `contract/zod-introspect.ts`). One finding is deferred with a trigger.

- [~] **U4-R1 — [med, DORMANT] `hitRate` compares two disjoint sessionId namespaces** (`repo.ts`, adversarial).
  `hitRate` = `consumed / (consumed ∪ breadcrumbSessions)`, where `consumed` = distinct `access_log.sessionId`
  (written from the MCP transport UUID `extra.sessionId`) and `breadcrumbSessions` = distinct
  `breadcrumbs.sessionId` (in production, U5's tailer harness session id) — DIFFERENT namespaces that never
  intersect, so the numerator can't overlap the denominator population and the ratio measures nothing
  coherent. **Dormant:** `/status` calls `hitRate()` only as a store-reachability probe and DISCARDS the
  value; nothing surfaces it, so real impact today is zero. This qualifies the U2-R5 "stays global" decision:
  the ratio isn't just unscoped, it's incoherent until the identity namespaces are reconciled. **Promotion
  trigger:** before ANY consumer reads `hitRate` (the U11 view / a metrics surface) AND once U5 fixes the
  breadcrumb `sessionId` namespace — reconcile ONE canonical session identity across the MCP session and the
  tailer (or scope the ratio to a single writer), then it becomes measurable.

**Accepted tradeoff (conscious, not a deferred defect — noted for the PR):** idle eviction can fragment a
quiet-but-active session into a new `sessionId` on reconnect (continuity is preserved — `readWorkState`
resolves by `ts`, sessionId-agnostic — only KTD8's one-row-per-session cleanliness is relaxed). (The Codex
adversarial pass then found the session cap had a check-before-insert TOCTOU and the earlier same-`ts` page
completion could exceed the cap; both were folded — the cap now enforces at insertion, and the pager is
keyset `(ts, id)`: lossless AND hard-bounded.)

---

## Fixed 2026-07-04 — Codex adversarial review (3 passes) + ce-code-review, folded into this branch

**Contract (`src/contract/schema.ts`) — 2nd/3rd adversarial passes:**

- [x] **F1 — [high] Secret breadcrumbs under-redacted.** Added `maxSensitivity()` so the redaction pass
  combines a field's static schema mark with the record's capture-time `sensitivity`.
- [x] **F2 / G1 — [high] `WorkState` could represent an invalid empty resume-state.** Modeled as a
  **discriminated union on `lane`** (curated ⇒ handoff, raw ⇒ non-empty trail). Structural, so it holds
  at zod parse AND is represented in the exported JSON Schema (`oneOf` + `minItems`) — the MCP tool
  boundary (KTD2) enforces it too. (The earlier `.check()` fix only held at parse; G1 caught that gap.)
  `enumerateSensitive` deduped for the union walk.
- [x] **F3 — [medium] Records silently stripped unknown fields.** All records → `z.strictObject`.

**U14 engine (`src/configwrite/*`) — working-tree adversarial pass:**

- [x] **U14-F1 — [high] Undo blindly rolled back.** Each entry records a `postHash`; `undo` refuses
  unless the target still matches its post-image (or the already-restored backup). Idempotent preserved.
- [x] **U14-F2 — [high] Symlinked configs replaced.** `lstatSync` fail-closed guard.
- [x] **G3(b) — [medium] Torn journal line could swallow the next entry.** `recordUndo` leads with a
  newline when the journal has a partial tail, isolating it.

**U14 / ce-code-review:** S1 (parse-error secret leak), R1 (recordUndo outside try), R2 (non-atomic undo
restore), C1 (patch-type validation) — fixed; C2 informational.

Verification for all: `bun test` 65/65, `tsc --noEmit` clean.

---

## PR-body notes (name these as conscious decisions, not accidents)

- **`z.strictObject` on every record** is a deliberate forward-compat call: reject-unknown-fields aligns
  the runtime parse with the JSON Schema's `additionalProperties:false`. Greenfield with no persisted
  data today — but a *new writer field* would make an *old strict reader* reject. Revisit with a
  versioned metadata bag if/when cross-version compatibility matters.
- **Two robustness findings deferred** (see above) — call them out so a reviewer sees they were a
  conscious defer, not an oversight.
