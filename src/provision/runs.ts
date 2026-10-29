/**
 * Provision run records + batch undo (U10 U5 — KTD2).
 *
 * A provision run's identity lives IN the undo journal, not a second record file: a batch is simply the
 * journal entries sharing one `batchId` (stamped by `apply`). So the run record and batch undo fall out of the
 * already crash-hardened, torn-tail-tolerant journal — this module is a thin READER over `listUndo` plus the
 * LIFO reversal verb. Nothing here holds in-memory state: a fresh process reconstructs every batch purely from
 * the journal (the KTD2 fresh-process guarantee).
 *
 * The ONE thing it also writes is the `undone` terminal state (`batch-status.ts`), for the same reason `apply`
 * writes `committed`/`rolled-back`: the append-only journal records what a batch WROTE, never how it ENDED, so a
 * successful undo would otherwise leave no trace and its batch would stay both the default target and a live
 * writer forever. That write is best-effort and cannot fail an undo that already succeeded.
 */
import { listUndo, undo, type UndoEntry } from "../configwrite/index";
import { batchCleanliness, isFullyReversed, readBatchStatuses, recordBatchStatus } from "./batch-status";
import { canonicalProjectRoot, errorText } from "./internal";

/** Canonicalize a project root before comparison. Apply canonicalizes at ingress so NEW entries store a canonical
 *  root, but comparisons canonicalize BOTH sides so a legacy un-normalized journal (or a caller passing a
 *  different spelling to lookup than to apply) still matches (gate round 4). This is lexical, not a realpath —
 *  symlink-root aliases are folded upstream at the CLI ingress (`cli.ts`, issue #51.1). */
const canonicalRoot = canonicalProjectRoot;

/** One provision run: the journal entries sharing a `batchId`, kept OLDEST-FIRST (journal order), so a caller
 *  reverses them newest-first for LIFO. */
export interface ProvisionBatch {
  batchId: string;
  projectRoot: string;
  entries: UndoEntry[];
}

/** Group already-read journal entries into batches, first-appearance order, oldest entry first within each
 *  batch. Unbatched installer writes (no `batchId`/`projectRoot`) are ignored. Kept separate from the journal
 *  read so a caller with one `listUndo` result in hand groups it without a second read+parse pass. */
function groupBatches(entries: readonly UndoEntry[]): ProvisionBatch[] {
  const order: string[] = [];
  const byId = new Map<string, ProvisionBatch>();
  // A batchId that appears under two different canonical roots is dropped ENTIRELY (best-effort defense-in-depth,
  // bot review PR #52). THREAT-MODEL SCOPE (decision #45): this is CORRUPTION-tolerance, NOT a security boundary.
  // A legitimate journal cannot reach here — every `apply()` stamps a fresh `randomUUID` batchId under one
  // ingress-canonicalized root and each `targetPath` is a `posix.join(projectRoot, PortableRelPath)` descendant by
  // construction, so no cross-root batchId, duplicate entry-id, or path mismatch exists without DIRECT WRITES to
  // the 0600/0700 undo journal. An attacker who can write semantically-valid malicious entries there already owns
  // the data dir (and thus the user's real configs) — "attacker-owns-HOME", explicitly out of scope. So this
  // guard, and the residual crafted-journal undo paths the gate names (duplicate-id redirection, projectRoot not
  // constraining targetPath, quarantined-newest fallback), are best-effort only; full journal-integrity hardening
  // is deferred to its own unit IF the threat model ever expands to a hostile data dir (issue tracked).
  const quarantined = new Set<string>();
  for (const entry of entries) {
    if (!entry.batchId || !entry.projectRoot) continue;
    const root = canonicalRoot(entry.projectRoot);
    let batch = byId.get(entry.batchId);
    if (!batch) {
      batch = { batchId: entry.batchId, projectRoot: root, entries: [] };
      byId.set(entry.batchId, batch);
      order.push(entry.batchId);
    } else if (batch.projectRoot !== root) {
      quarantined.add(entry.batchId);
      continue;
    }
    batch.entries.push(entry);
  }
  return order.filter((id) => !quarantined.has(id)).map((id) => byId.get(id)!);
}

/** Every provision batch in the journal, in first-appearance order, oldest entry first within each batch.
 *  Unbatched installer writes (no `batchId`/`projectRoot`) are ignored. */
export function readBatches(dataDir?: string): ProvisionBatch[] {
  return groupBatches(listUndo(dataDir));
}

/**
 * The newest COMMITTED batch for a project: scanning back from the end of the journal, the batch of the
 * last-appearing entry for `projectRoot` (journal order, NOT `max(ts)` — that avoids ms-tie/clock-skew
 * misordering) that is not affirmatively known to have been rolled back. `null` when the project has no such
 * batch. One journal read: the entries found here are reused to build the batch (no second `listUndo` pass).
 *
 * WHY A TERMINAL-STATE FILTER (issue #50): a failed apply rolls back in-process, but its (already-reversed)
 * entries STAY in the append-only journal — so the rolled-back batch was the last-appearing one and captured
 * the default undo target. The report stayed honest (its entries land in `alreadyReversed`, never falsely in
 * `reversed`), but the operator's last SUCCESSFUL apply went un-undone unless they knew its batch id. The
 * durable `batch-status` record now names how each batch ended, and default selection skips a batch recorded
 * fully reversed — `rolled-back` OR, since gate finding 3, `undone`. Skipping `undone` is what lets successive
 * bare `undo`s WALK BACK through history: once B is undone, the next default selection lands on A instead of
 * re-picking B and reporting a no-op forever.
 *
 * FAIL-SAFE: only an affirmative, well-formed, root-matching fully-reversed record excludes a batch — an UNKNOWN
 * state (a pre-U6 journal, a crash before the record landed, a partial rollback that left a file on disk, an undo
 * that only partly succeeded) stays eligible, reproducing exactly the pre-#50 selection. `undoBatch` with an
 * explicit id still reaches ANY batch, fully-reversed ones included — as a non-mutating no-op (gate round 4).
 */
export function newestBatchForProject(projectRoot: string, dataDir?: string): ProvisionBatch | null {
  // Recency is the batch of the LAST journal ENTRY for `target` — NOT the last batch in `groupBatches`
  // first-appearance order (CodeRabbit PR #54): those differ only when a batch's entries are interleaved with
  // another's (`A1, B1, A2` → last entry is A's, but first-appearance order ends at B), which needs concurrent
  // applies (KTD9/#28) or a crafted journal (out of #45) — but the two must not disagree, and the docstring
  // promises "last-appearing journal entry". Resolve each entry's batchId through the VALIDATED grouping so a
  // quarantined (cross-root) batchId is never a candidate; a batch is returned only when its OWN canonical root
  // matches. On any legitimate journal nothing is quarantined, so this is exactly the pre-quarantine behavior.
  const target = canonicalRoot(projectRoot);
  const entries = listUndo(dataDir);
  const validatedById = new Map(groupBatches(entries).map((batch) => [batch.batchId, batch]));
  const statuses = readBatchStatuses(dataDir);
  for (let index = entries.length - 1; index >= 0; index--) {
    const batch = entries[index]!.batchId === undefined ? undefined : validatedById.get(entries[index]!.batchId!);
    if (batch?.projectRoot === target && !isFullyReversed(batch.batchId, batch.projectRoot, statuses)) return batch;
  }
  return null;
}

/**
 * Every absolute `targetPath` a still-LIVE batch of this project journaled — the read side's "was this surface
 * ever provisioned (and not since unwound)?" answer, which lets the pure diff call a MISSING tracked surface drift
 * without doing journal I/O itself. Built over `groupBatches`, so a cross-root (quarantined) batch never counts,
 * and matched on the batch's canonical root. A batch is excluded only by an AFFIRMATIVE fully-reversed record
 * (`rolled-back`/`undone`); unknown, committed, and partial states all count as live. That is the fail-safe side
 * for THIS question: a wrongly-live batch over-reports drift on a missing file (the operator re-applies, which
 * recreates it), whereas a wrongly-spent one would hide a deleted surface behind "every tracked surface matches".
 */
export function liveProvisionedTargets(projectRoot: string, dataDir?: string): Set<string> {
  const target = canonicalRoot(projectRoot);
  const statuses = readBatchStatuses(dataDir);
  const live = new Set<string>();
  for (const batch of groupBatches(listUndo(dataDir))) {
    if (batch.projectRoot !== target || isFullyReversed(batch.batchId, batch.projectRoot, statuses)) continue;
    for (const entry of batch.entries) live.add(entry.targetPath);
  }
  return live;
}

/** The result of an undo verb, four honest per-target buckets (one entry's outcome never aborts the rest —
 *  per-file isolation, mirroring `UninstallOutcome`):
 *   - `reversed` — the target was actually restored (a created file deleted, or a backup restored over it).
 *   - `alreadyReversed` — `undo` ran but the target was ALREADY in its reversed state (nothing to do). This is
 *     the honest no-op signal: after a failed+rolled-back apply, a bare `undo` of that batch finds every entry
 *     already reversed on disk and reports them HERE — never falsely in `reversed`. It is not a failure.
 *     This bucket now means EXACTLY that (issue #51.3): `undo`'s presence check is a guarded stat where ONLY a
 *     genuine ENOENT counts as absent, so a target still present behind an inaccessible parent dir throws and
 *     lands in `failed` instead of being laundered into a clean "already reversed" it never was.
 *   - `superseded` — a LATER provision batch wrote the same `(projectRoot, targetPath)`, so reversing this
 *     (older) entry would clobber the newer batch's state; we refuse (fail CLOSED) rather than reverse. Keyed on
 *     JOURNAL ORDERING (a later, different batch), NOT a byte-hash — so an A→B→A content cycle can no longer
 *     defeat the check. `undo` is NOT called for these entries.
 *   - `failed` — the entry could not be reversed for any other reason (a diverged/hand-edited target, a missing
 *     backup, an unreadable file): `undo` threw and it was not superseded. Carries `undo`'s own error text. */
export interface UndoOutcome {
  batchId: string | null;
  reversed: string[];
  alreadyReversed: string[];
  superseded: Array<{ path: string; error: string }>;
  failed: Array<{ path: string; error: string }>;
}

/**
 * Reverse a project's batch, newest-first. `batchId` selects the batch (default: the project's newest); the
 * default is the operator's `undo`, and passing an OLDER batch's id is how a specific run is unwound — that is
 * the path that surfaces `superseded` entries when a newer batch already overwrote a shared target.
 *
 * DEFAULT vs EXPLICIT selection (issue #50): the default targets the newest batch that still holds live state —
 * a fully rolled-back or already-undone run is skipped, so a bare `undoBatch(projectRoot, dataDir)` unwinds the
 * last apply that actually left state behind rather than no-op'ing on a spent one. An EXPLICIT `batchId` still
 * reaches ANY batch, but a batch with an affirmative fully-reversed record (`rolled-back`/`undone`) is a
 * NON-MUTATING no-op: its entries are reported in `alreadyReversed` without `undo` ever running, and no status is
 * recorded. Re-running a spent batch's entries is not harmless — once a LATER undo has put disk back to this
 * batch's `postHash` (X→y by A, y→x0 by B; undo B, undo A, then undo B again), `undo` would happily re-apply its
 * backup over that later state, resurrecting a change while every batch still claims `undone` (gate round 4).
 * A batch whose terminal state is unknown, or whose rollback/undo was only PARTIAL, still executes and remains
 * default-selectable — that is what keeps a file stranded by a failed reversal reachable without its batch id.
 *
 * RECORDING `undone` (gate finding 3). A fully successful undo appends the durable `undone` terminal state, which
 * both consumers then treat exactly like `rolled-back`: the batch is skipped by default selection and dropped
 * from the live-writer index. Without it, undoing B (restoring A's bytes) left B the newest COMMITTED batch and
 * still a writer of the shared path, so the next bare `undo` re-selected B and an explicit undo of A — which
 * would now SUCCEED, since disk holds A's own `postHash` again — was refused as superseded. Reversible history
 * the operator could not walk back through.
 *
 * ONLY a fully successful undo qualifies, mirroring `apply`'s discipline for a partial rollback: `failed` means
 * an entry was not reversed, and `superseded` means it was never even attempted, so in both cases the batch still
 * holds live state and must stay UNKNOWN (default-selectable, still superseding). `alreadyReversed` DOES qualify —
 * the entry is in its reversed state, which is the fact the record asserts. The claim is scoped to JOURNALED
 * entries: an applied-but-unjournaled write has no entry, so it was never reversible by `undo` and was never in
 * the live-writer index either — nothing about it changes here (the same reasoning `supersessionIndex` documents).
 * Best-effort, like every other status write: a dropped record leaves the batch unknown, never fails the undo.
 */
export function undoBatch(projectRoot: string, dataDir?: string, batchId?: string): UndoOutcome {
  // `!== undefined`, not truthiness: an explicitly supplied empty id must match nothing, never fall back to the
  // default selection and reverse whatever batch happens to be newest (gate round 6).
  const batch = batchId !== undefined
    ? readBatches(dataDir).find((candidate) => candidate.batchId === batchId && canonicalRoot(candidate.projectRoot) === canonicalRoot(projectRoot)) ?? null
    : newestBatchForProject(projectRoot, dataDir);
  if (!batch) return { batchId: batchId ?? null, reversed: [], alreadyReversed: [], superseded: [], failed: [] };
  // A spent batch never touches disk again (see "DEFAULT vs EXPLICIT" above). Newest-first, as `undoEntries` reports.
  if (isFullyReversed(batch.batchId, batch.projectRoot, readBatchStatuses(dataDir))) {
    const alreadyReversed = batch.entries.map((entry) => entry.targetPath).reverse();
    return { batchId: batch.batchId, reversed: [], alreadyReversed, superseded: [], failed: [] };
  }
  const buckets = undoEntries(batch.entries, dataDir);
  // Retire the batch as `undone` only when NOTHING it produced is still live. Three ways something can be:
  //   - `failed`     — the entry was not reversed; its file is still on disk.
  //   - `superseded` — the entry was never even attempted (and, once the superseding batch is itself undone,
  //                    this batch becomes the live writer of that path again).
  //   - `stranded`   — an applied-but-UNJOURNALED write from the original apply. `undo` cannot see it: it has
  //                    no journal entry, so it is in none of the buckets above and reversing every visible
  //                    entry says nothing about it. Recording `undone` here would retire a batch whose
  //                    survivor is live, hide it from every future bare `undo`, and erase the last durable
  //                    trace of it (gate round 2, finding 3). Only `apply` knew, so `apply` stamped it.
  // Anything unretired stays UNKNOWN: default-selectable and still superseding — the fail-safe side.
  //   - anything but an AFFIRMATIVE `clean` record. Retiring asserts the batch holds nothing live, and an
  //     absent record cannot support that claim — `apply`'s abort path deliberately writes no status when a
  //     survivor exists, and every status write is best-effort and can simply fail to land, so "no record"
  //     is ordinary rather than adversarial (gate round 3). Unknown therefore refuses retirement, which is
  //     the opposite default from `isFullyReversed`'s "unknown stays eligible" — the two questions have
  //     opposite safe sides, and a single boolean answered this one with the wrong default.
  const cleanliness = batchCleanliness(batch.batchId, batch.projectRoot, readBatchStatuses(dataDir));
  if (buckets.failed.length === 0 && buckets.superseded.length === 0 && cleanliness === "clean") {
    recordBatchStatus(dataDir, batch.batchId, batch.projectRoot, "undone");
  }
  return { batchId: batch.batchId, ...buckets };
}

/**
 * LIFO reversal of a batch's entries (given oldest-first, reverses newest-first) with per-file classification —
 * the shared reversal core `undoBatch` delegates to. Two things classify each entry:
 *
 *  1. SUPERSESSION is decided by JOURNAL ORDERING, not a byte-hash (brief FOLD 3). An entry is superseded iff a
 *     LATER, DIFFERENT batch also wrote its `(projectRoot, targetPath)` — "later" = a greater first-appearance
 *     index among `groupBatches`, which the append-only journal makes byte-INDEPENDENT. This closes the A→B→A
 *     clobber: the old byte-hash check saw the OLDEST batch's hash reappear after the cycle and happily
 *     deleted/restored over the NEWEST batch's identical-looking state. We now REFUSE (fail closed) a superseded
 *     entry — `undo` is never called for it — so an explicit old-batch undo can never clobber a newer batch.
 *     ⚠️ CROSS-BATCH ONLY: two rows into one destination WITHIN ONE batch share the same batch index, so neither
 *     supersedes the other — the same-batch LIFO chain (X→v1→v2) must still reverse newest-first intact.
 *     A later batch affirmatively recorded FULLY REVERSED — `rolled-back` (#50) or `undone` (gate finding 3) — is
 *     no longer counted as a writer: every one of its journaled writes was reversed, so it holds no live state
 *     that reversing an older entry could clobber — see `supersessionIndex` for why that stays safe.
 *
 *  2. For a NON-superseded entry, `undo` runs and its disposition routes the entry: `"reversed"` (a real change)
 *     → `reversed`; `"noop"` (already in the reversed state — a double-undo, or undoing an already-rolled-back
 *     batch) → `alreadyReversed`; a THROW (diverged/hand-edited/missing target, missing backup) → `failed`.
 */
function undoEntries(entries: readonly UndoEntry[], dataDir?: string): Omit<UndoOutcome, "batchId"> {
  const reversed: string[] = [];
  const alreadyReversed: string[] = [];
  const superseded: Array<{ path: string; error: string }> = [];
  const failed: Array<{ path: string; error: string }> = [];

  const supersession = supersessionIndex(dataDir);

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    // Fail CLOSED before touching disk: a superseded entry is never handed to `undo`, so ABA can't clobber.
    if (isSuperseded(entry, supersession)) {
      superseded.push({ path: entry.targetPath, error: "target superseded by a later provision batch that wrote the same path — refusing to reverse it (a later batch's state would be clobbered)" });
      continue;
    }
    try {
      const disposition = undo(entry.id, dataDir);
      (disposition === "reversed" ? reversed : alreadyReversed).push(entry.targetPath);
    } catch (err) {
      failed.push({ path: entry.targetPath, error: errorText(err) });
    }
  }
  return { reversed, alreadyReversed, superseded, failed };
}

/** The journal-ordering supersession index, built once per `undoEntries` call from the FULL journal:
 *   - `orderByBatch` — each batch's first-appearance index (`groupBatches` order, the SAME journal-position
 *     ordering `newestBatchForProject` trusts — never `ts`, which ms-ties/clock-skew would misorder).
 *   - `writersByPath` — every LIVE batch index that wrote each `targetPath`, keyed by the `targetPath` ALONE.
 *     `targetPath` is `posix.join(projectRoot, dest)` (apply), so it is already absolute AND posix-normalized —
 *     `/p`, `/p/`, and `/p/x/..` all collapse to one key (gate round 3 FOLD 1a: the earlier `[projectRoot,
 *     targetPath]` key embedded the UNnormalized root spelling, so those aliases produced distinct keys and a
 *     later write could miss supersession → ABA clobber). The project scoping the old key added is redundant:
 *     `targetPath` is the absolute file identity, so two batches sharing it ARE writing one file and supersession
 *     is correct regardless of which project logically "owns" it. Symlink roots (issue #51.1): a root reached via
 *     a SYMLINK is a different string `posix.normalize` cannot fold (`/link/f` vs `/real/f`), so this pure reader
 *     relies on the CLI ingress (`cli.ts`) having realpath'd the root before apply journals it.
 *  Together these answer "is a LATER, different batch also a LIVE writer of this path?" without any byte compare.
 *
 *  FULLY-REVERSED BATCHES ARE NOT WRITERS (#50, extended by gate finding 3). A batch recorded `rolled-back` (its
 *  apply aborted) or `undone` (a later undo emptied it) had every journaled write reversed, so it holds no live
 *  state on any path — counting it as a writer over-refused an older batch's legitimate undo with a misleading
 *  "superseded", leaving that run unwindable by nobody. That is exactly the A/B same-path case: once B is undone,
 *  A's own entry must become reversible again, since disk holds A's `postHash` once more. Such a batch is dropped
 *  from `writersByPath` but KEPT in `orderByBatch`: its own entries must still resolve an index, so a LATER live
 *  batch can supersede THEM (undoing a spent batch under newer live state stays a fail-closed refusal rather than
 *  a hash-mismatch `failed`). Failing open here is safe in depth — an applied-but-unjournaled write never had a
 *  journal entry, so it was never a writer to begin with, and `undo` itself still refuses any target whose bytes
 *  no longer match the entry's `postHash`. The fail-safe direction is preserved: an UNKNOWN state, a PARTIAL
 *  rollback, and a PARTIAL undo are none of them fully reversed, so those batches keep superseding (fail closed). */
interface SupersessionIndex {
  orderByBatch: Map<string, number>;
  writersByPath: Map<string, number[]>;
}

function supersessionIndex(dataDir?: string): SupersessionIndex {
  const batches = groupBatches(listUndo(dataDir));
  const statuses = readBatchStatuses(dataDir);
  const orderByBatch = new Map<string, number>();
  const writersByPath = new Map<string, number[]>();
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]!;
    orderByBatch.set(batch.batchId, index); // EVERY batch keeps its order index, live or not (see the docstring)
    if (isFullyReversed(batch.batchId, batch.projectRoot, statuses)) continue; // reversed ⇒ holds no live state
    for (const entry of batch.entries) {
      const indices = writersByPath.get(entry.targetPath) ?? [];
      indices.push(index);
      writersByPath.set(entry.targetPath, indices);
    }
  }
  return { orderByBatch, writersByPath };
}

/** True iff a LATER, DIFFERENT batch wrote this entry's `targetPath` — the byte-independent supersession signal
 *  (brief FOLD 3). `myIndex` is the entry's OWN batch's order index (looked up by its `batchId`, NOT inferred
 *  from the path — a batch can be a later writer of a path an earlier batch also touched). A STRICTLY greater
 *  writer index is a later, cross-batch writer; strictly greater is load-bearing — same-batch entries share
 *  `myIndex`, so a second row into one destination within a batch is NOT a supersession and the same-batch LIFO
 *  chain reverses intact. Keyed on the absolute, posix-normalized `targetPath` alone so equivalent root spellings
 *  collapse (FOLD 1a; symlink-root aliases deferred — see `supersessionIndex`). An entry with no resolvable batch
 *  index (should not happen — `groupBatches` only yields batched entries) is treated as not superseded. */
function isSuperseded(entry: UndoEntry, index: SupersessionIndex): boolean {
  const myIndex = entry.batchId === undefined ? undefined : index.orderByBatch.get(entry.batchId);
  if (myIndex === undefined) return false;
  const writers = index.writersByPath.get(entry.targetPath) ?? [];
  return writers.some((writerIndex) => writerIndex > myIndex);
}
