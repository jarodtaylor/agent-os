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

- [~] **U2-R1 — [note → U3/U4] Repo write methods don't re-validate inputs; only `readWorkState` parses.**
  In-process TS types guard the write boundary today. **Promotion trigger (concrete, next units):** when
  U3 (server) / U4 (MCP tools) write handoffs/breadcrumbs from external HTTP/MCP JSON, validate via the
  contract zod schema at the write boundary *before* `repo.write*` — never trust TS types for untrusted input.
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
- [~] **U2-R5 — [low] `hitRate()` has no project scope** (`repo.ts`). The same sessionId across two
  projects counts once — a self-documented approximation. **Promotion trigger:** U4 wires the real
  per-tool consumption metric → decide project scoping then.
- [~] **U2-R6 — [low] `readWorkState`'s raw breadcrumb trail is unbounded** (`repo.ts`, both
  `selectBreadcrumbTrail` call sites; CodeRabbit). No `.limit()`, so a project with no curated handoff
  (AE1) or a long gap between handoffs (AE2) materializes an ever-growing `rawTrailTail` into memory and
  into the eventual MCP response. Correct + harmless in-slice: nothing writes breadcrumbs at volume until
  U5, and the `(project, ts)` index keeps the scan sub-linear. **Promotion trigger:** U4 (MCP tool
  response) / U6 (consumption) — cap the resume tail to a most-recent-N (or add a `limit` param to
  `readWorkState`) sized by real resume needs and the payload ceiling, rather than guessing N now.

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
