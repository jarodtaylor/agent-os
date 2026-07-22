/**
 * Provision run records + batch undo (U10 U5 — KTD2).
 *
 * A provision run's identity lives IN the undo journal, not a second record file: a batch is simply the
 * journal entries sharing one `batchId` (stamped by `apply`). So the run record and batch undo fall out of the
 * already crash-hardened, torn-tail-tolerant journal — this module is a thin READER over `listUndo` plus the
 * LIFO reversal verb. Nothing here holds in-memory state: a fresh process reconstructs every batch purely from
 * the journal (the KTD2 fresh-process guarantee).
 */
import { listUndo, undo, type UndoEntry } from "../configwrite/index";
import { canonicalProjectRoot, errorText } from "./internal";

/** Canonicalize a project root before comparison. Apply canonicalizes at ingress so NEW entries store a canonical
 *  root, but comparisons canonicalize BOTH sides so a legacy un-normalized journal (or a caller passing a
 *  different spelling to lookup than to apply) still matches (gate round 4). Symlink-root aliases remain deferred
 *  (issue #51) — this is lexical, not a realpath. */
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
  for (const entry of entries) {
    if (!entry.batchId || !entry.projectRoot) continue;
    let batch = byId.get(entry.batchId);
    if (!batch) {
      batch = { batchId: entry.batchId, projectRoot: entry.projectRoot, entries: [] };
      byId.set(entry.batchId, batch);
      order.push(entry.batchId);
    }
    batch.entries.push(entry);
  }
  return order.map((id) => byId.get(id)!);
}

/** Every provision batch in the journal, in first-appearance order, oldest entry first within each batch.
 *  Unbatched installer writes (no `batchId`/`projectRoot`) are ignored. */
export function readBatches(dataDir?: string): ProvisionBatch[] {
  return groupBatches(listUndo(dataDir));
}

/**
 * The newest batch for a project: the batch of the LAST-APPEARING journal entry for `projectRoot` (journal
 * order, NOT `max(ts)` — that avoids ms-tie/clock-skew misordering). `null` when the project has no batch.
 * One journal read: the entries found here are reused to build the batch (no second `listUndo` pass).
 *
 * HONESTY CAVEAT (deferred, no fix here): "newest" is the newest JOURNALED batch, not the newest SUCCESSFUL
 * one. A failed apply rolls back in-process but its reversed entries STAY in the append-only journal, so that
 * rolled-back batch is the last-appearing one and becomes the default undo target — its already-reversed
 * entries then report in `alreadyReversed` (an honest no-op — FOLD 2), never data loss or a false success. An
 * operator wanting to undo the last SUCCESSFUL apply must pass that batch id explicitly to `undoBatch`. The
 * durable fix (a batch terminal-state / run-status so default selection can skip a rolled-back batch) lands
 * with the U6 CLI undo verb; do NOT change the selection logic before then.
 */
export function newestBatchForProject(projectRoot: string, dataDir?: string): ProvisionBatch | null {
  const entries = listUndo(dataDir);
  let lastBatchId: string | null = null;
  const target = canonicalRoot(projectRoot);
  for (const entry of entries) {
    if (entry.projectRoot !== undefined && canonicalRoot(entry.projectRoot) === target && entry.batchId) lastBatchId = entry.batchId;
  }
  if (lastBatchId === null) return null;
  return groupBatches(entries).find((batch) => batch.batchId === lastBatchId) ?? null;
}

/** The result of an undo verb, four honest per-target buckets (one entry's outcome never aborts the rest —
 *  per-file isolation, mirroring `UninstallOutcome`):
 *   - `reversed` — the target was actually restored (a created file deleted, or a backup restored over it).
 *   - `alreadyReversed` — `undo` ran but the target was ALREADY in its reversed state (nothing to do). This is
 *     the honest no-op signal: after a failed+rolled-back apply, a bare `undo` of that batch finds every entry
 *     already reversed on disk and reports them HERE — never falsely in `reversed`. It is not a failure.
 *     DEFERRED caveat (gate round 3, issue #50/U6): `undo`'s created-file branch decides presence with
 *     `existsSync`, which reads `false` for BOTH a genuinely-absent target AND an EACCES/indeterminate lookup, so
 *     a created target still present behind an inaccessible parent dir is mapped to `noop` and lands HERE instead
 *     of `failed`. The fix (guarded `lstat`, ENOENT-only ⇒ noop) belongs in the shared U14 `undo` primitive that
 *     the installers also call, so it rides with U6's write-path hardening rather than being bolted on here.
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
 * DEFAULT-SELECTION CAVEAT (see `newestBatchForProject`): the default targets the newest JOURNALED batch, not
 * the newest SUCCESSFUL one. After a FAILED + rolled-back apply, that rolled-back batch is newest in the
 * append-only journal, so a bare `undoBatch(projectRoot, dataDir)` selects it and reports an honest no-op (its
 * entries land in `alreadyReversed`, not falsely in `reversed` — FOLD 2) rather than undoing the prior
 * successful run — pass that run's batch id explicitly to unwind it. Deferred; the durable fix (durable batch
 * terminal-state) lands with the U6 CLI verb.
 */
export function undoBatch(projectRoot: string, dataDir?: string, batchId?: string): UndoOutcome {
  const batch = batchId
    ? readBatches(dataDir).find((candidate) => candidate.batchId === batchId && canonicalRoot(candidate.projectRoot) === canonicalRoot(projectRoot)) ?? null
    : newestBatchForProject(projectRoot, dataDir);
  if (!batch) return { batchId: batchId ?? null, reversed: [], alreadyReversed: [], superseded: [], failed: [] };
  return { batchId: batch.batchId, ...undoEntries(batch.entries, dataDir) };
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
 *     DEFERRED (#50/U6): this over-refuses in the rare case where the later batch was ITSELF rolled back (its
 *     entries linger in the append-only journal); proving that (fail OPEN) needs a batch terminal-state and is
 *     out of scope here — worst case is an honest "superseded" report, never a clobber.
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
 *   - `writersByPath` — every batch index that wrote each `targetPath`, keyed by the `targetPath` ALONE.
 *     `targetPath` is `posix.join(projectRoot, dest)` (apply), so it is already absolute AND posix-normalized —
 *     `/p`, `/p/`, and `/p/x/..` all collapse to one key (gate round 3 FOLD 1a: the earlier `[projectRoot,
 *     targetPath]` key embedded the UNnormalized root spelling, so those aliases produced distinct keys and a
 *     later write could miss supersession → ABA clobber). The project scoping the old key added is redundant:
 *     `targetPath` is the absolute file identity, so two batches sharing it ARE writing one file and supersession
 *     is correct regardless of which project logically "owns" it. DEFERRED (#50/U6, symlink residual): a root
 *     reached via a SYMLINK is a different string `posix.normalize` cannot fold, so two spellings (`/link/f` vs
 *     `/real/f`) still key apart; the durable fix is canonicalizing (realpath) the project root at the U6/registry
 *     ingress, out of scope for this pure journal reader.
 *  Together these answer "is a LATER, different batch also a writer of this path?" without any byte compare. */
interface SupersessionIndex {
  orderByBatch: Map<string, number>;
  writersByPath: Map<string, number[]>;
}

function supersessionIndex(dataDir?: string): SupersessionIndex {
  const batches = groupBatches(listUndo(dataDir));
  const orderByBatch = new Map<string, number>();
  const writersByPath = new Map<string, number[]>();
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]!;
    orderByBatch.set(batch.batchId, index);
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
