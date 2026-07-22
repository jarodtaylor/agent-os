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
import { isRolledBack, readBatchStatuses } from "./batch-status";
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
 * durable `batch-status` record now names how each batch ended, and default selection skips one recorded
 * `rolled-back`. FAIL-SAFE: only an affirmative, well-formed, root-matching rolled-back record excludes a
 * batch — an UNKNOWN state (a pre-U6 journal, a crash before the record landed, a partial rollback that left
 * a file on disk) stays eligible, reproducing exactly the pre-#50 selection. `undoBatch` with an explicit id
 * still reaches ANY batch, rolled-back ones included.
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
    if (batch?.projectRoot === target && !isRolledBack(batch.batchId, batch.projectRoot, statuses)) return batch;
  }
  return null;
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
 * DEFAULT vs EXPLICIT selection (issue #50): the default targets the newest COMMITTED batch — a fully
 * rolled-back run is skipped, so a bare `undoBatch(projectRoot, dataDir)` unwinds the last apply that actually
 * left state behind rather than no-op'ing on a failed one. An EXPLICIT `batchId` still reaches ANY batch,
 * including a rolled-back one, whose entries then report in `alreadyReversed` (an honest no-op — FOLD 2). A
 * batch whose terminal state is unknown, or whose rollback was only PARTIAL, remains default-selectable —
 * that is what keeps a file stranded by a failed reversal reachable without knowing its batch id.
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
 *     A later batch that is affirmatively recorded FULLY rolled back is no longer counted as a writer (#50):
 *     every one of its journaled writes was reversed, so it holds no live state that reversing an older entry
 *     could clobber — see `supersessionIndex` for why that stays safe.
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
 *     is correct regardless of which project logically "owns" it. DEFERRED (issue #51.1, symlink residual): a root
 *     reached via a SYMLINK is a different string `posix.normalize` cannot fold, so two spellings (`/link/f` vs
 *     `/real/f`) still key apart; the durable fix is canonicalizing (realpath) the project root at the U6/registry
 *     ingress, out of scope for this pure journal reader.
 *  Together these answer "is a LATER, different batch also a LIVE writer of this path?" without any byte compare.
 *
 *  ROLLED-BACK BATCHES ARE NOT WRITERS (#50). A batch recorded FULLY rolled back had every journaled write
 *  reversed, so it holds no live state on any path — counting it as a writer over-refused an older batch's
 *  legitimate undo with a misleading "superseded", leaving that run unwindable by nobody. It is dropped from
 *  `writersByPath` but KEPT in `orderByBatch`: its own entries must still resolve an index, so a LATER live
 *  batch can supersede THEM (undoing a rolled-back batch under newer live state stays a fail-closed refusal
 *  rather than a hash-mismatch `failed`). Failing open here is safe in depth — an applied-but-unjournaled write
 *  never had a journal entry, so it was never a writer to begin with, and `undo` itself still refuses any
 *  target whose bytes no longer match the entry's `postHash`. The fail-safe direction is preserved: an UNKNOWN
 *  or PARTIAL rollback is not "rolled-back", so those batches keep superseding (fail closed). */
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
    if (isRolledBack(batch.batchId, batch.projectRoot, statuses)) continue; // reversed ⇒ holds no live state
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
