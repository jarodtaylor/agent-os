/**
 * Provision run records + batch undo (U10 U5 — KTD2).
 *
 * A provision run's identity lives IN the undo journal, not a second record file: a batch is simply the
 * journal entries sharing one `batchId` (stamped by `apply`). So the run record and batch undo fall out of the
 * already crash-hardened, torn-tail-tolerant journal — this module is a thin READER over `listUndo` plus the
 * LIFO reversal verb. Nothing here holds in-memory state: a fresh process reconstructs every batch purely from
 * the journal (the KTD2 fresh-process guarantee).
 */
import { readFileSync } from "node:fs";
import { hashContent, listUndo, undo, type UndoEntry } from "../configwrite/index";
import { errorText } from "./internal";

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
 * entries then report `superseded`/`reversed:[]` (an honest no-op), never data loss or a false success. An
 * operator wanting to undo the last SUCCESSFUL apply must pass that batch id explicitly to `undoBatch`. The
 * durable fix (a batch terminal-state / run-status so default selection can skip a rolled-back batch) lands
 * with the U6 CLI undo verb; do NOT change the selection logic before then.
 */
export function newestBatchForProject(projectRoot: string, dataDir?: string): ProvisionBatch | null {
  const entries = listUndo(dataDir);
  let lastBatchId: string | null = null;
  for (const entry of entries) {
    if (entry.projectRoot === projectRoot && entry.batchId) lastBatchId = entry.batchId;
  }
  if (lastBatchId === null) return null;
  return groupBatches(entries).find((batch) => batch.batchId === lastBatchId) ?? null;
}

/** The result of an undo verb: `reversed` names each restored target; `superseded` names each entry whose live
 *  bytes no longer match its `postHash`, so `undo` refused rather than clobber what is there now — a LATER apply
 *  to a shared target OR an out-of-band hand-edit produce the identical byte-hash signal and are not
 *  distinguishable here; `failed` names each entry that could not be reversed for any other reason. One entry's
 *  refusal never aborts the rest — per-file isolation, mirroring `UninstallOutcome`. */
export interface UndoOutcome {
  batchId: string | null;
  reversed: string[];
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
 * append-only journal, so a bare `undoBatch(projectRoot, dataDir)` selects it and reports an honest no-op
 * (`superseded`/`reversed:[]`) rather than undoing the prior successful run — pass that run's batch id
 * explicitly to unwind it. Deferred; the durable fix (durable batch terminal-state) lands with the U6 CLI verb.
 */
export function undoBatch(projectRoot: string, dataDir?: string, batchId?: string): UndoOutcome {
  const batch = batchId
    ? readBatches(dataDir).find((candidate) => candidate.batchId === batchId && candidate.projectRoot === projectRoot) ?? null
    : newestBatchForProject(projectRoot, dataDir);
  if (!batch) return { batchId: batchId ?? null, reversed: [], superseded: [], failed: [] };
  return { batchId: batch.batchId, ...undoEntries(batch.entries, dataDir) };
}

/**
 * LIFO reversal of a batch's entries (given oldest-first, reverses newest-first) with per-file classification —
 * the shared reversal core `undoBatch` delegates to. `undo` is postHash-checked: it refuses an entry whose
 * target diverged, and this classifies that refusal — a live target whose bytes no longer hash to the entry's
 * `postHash` diverged from its post-write state (a later apply to a shared target OR an out-of-band hand-edit;
 * the byte-hash cannot tell them apart); anything else is a genuine failure. The hash matches `undo`'s own
 * check exactly (sha-256 over the raw file bytes), so the classification is precise, not a message-string match.
 */
function undoEntries(entries: readonly UndoEntry[], dataDir?: string): Omit<UndoOutcome, "batchId"> {
  const reversed: string[] = [];
  const superseded: Array<{ path: string; error: string }> = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    try {
      undo(entry.id, dataDir);
      reversed.push(entry.targetPath);
    } catch (err) {
      if (isSuperseded(entry)) {
        superseded.push({ path: entry.targetPath, error: "target diverged from its post-write state (superseded by a later apply or hand-edited)" });
      } else {
        failed.push({ path: entry.targetPath, error: errorText(err) });
      }
    }
  }
  return { reversed, superseded, failed };
}

/** True when `undo` refused because the target diverged: it still exists but its bytes no longer hash to this
 *  entry's `postHash` (a later apply to a shared target OR an out-of-band hand-edit — indistinguishable at the
 *  byte level). A missing target (a real "refusing to resurrect") or any other read failure
 *  (permissions, etc.) is NOT a supersede — it returns `false`, so the entry lands in `failed` carrying `undo`'s
 *  own error, and one unreadable target never escapes the per-file-isolation loop in `undoEntries`. Reuses
 *  `hashContent`, the SAME digest the engine writes into `postHash` and `undo` checks against, so the
 *  comparison is byte-for-byte exact rather than a message-string match. */
function isSuperseded(entry: UndoEntry): boolean {
  let bytes: Buffer;
  try {
    bytes = readFileSync(entry.targetPath);
  } catch {
    return false; // ENOENT (resurrect-refusal) or any other read failure → classify as `failed`, not superseded
  }
  return hashContent(bytes) !== entry.postHash;
}
