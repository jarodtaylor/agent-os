/**
 * Durable batch TERMINAL STATE for provision runs (U10 U6 — issue #50).
 *
 * The undo journal is append-only, so it records what a batch WROTE but never how the batch ENDED. A failed
 * apply reverses its writes in-process, yet those (now already-reversed) entries stay in the journal — which
 * made the rolled-back batch the newest JOURNALED batch and therefore the default `undo` target, while the
 * operator's last SUCCESSFUL apply went un-undone unless they knew its batch id. This file closes that gap with
 * the one fact the journal cannot carry: how each batch finished.
 *
 * WHY A PROVISION-LAYER SIDECAR, not a column in the journal: batch terminal state is a provision concept —
 * `configwrite` knows nothing of runs, and its `UndoEntry` schema is shared with the U14 installers, which must
 * keep validating unchanged. A separate append-only JSONL beside the journal keeps that contract untouched and
 * keeps the crash story identical to the journal's (append-only, one self-contained line per record, torn tails
 * isolated by leading with a newline, malformed lines skipped on read).
 *
 * THE FAIL-SAFE INVARIANT, non-negotiable: an UNKNOWN status — no record at all (a pre-U6 journal, a hard crash
 * between the last write and this append, a deleted/corrupt status file) — leaves the batch ELIGIBLE for default
 * selection, i.e. degrades to exactly the pre-#50 behavior. Only an affirmative, well-formed, root-matching
 * fully-reversed record (`rolled-back` or `undone`) removes a batch from default selection. A missing status file
 * can therefore never make `undo` find nothing, and `recordBatchStatus` is best-effort (it can never fail an
 * apply — or an undo — that already succeeded; an operation's outcome must not hinge on a metadata line landing).
 */
import { join } from "node:path";
import * as z from "zod";
import { resolveDataDir } from "../paths";
import { appendJsonlRecord, canonicalProjectRoot, readFileBounded } from "./internal";

/**
 * How a batch finished:
 *   - `committed` — the write pass ran to completion (its writes are live and undoable).
 *   - `rolled-back` — a mid-write fault aborted the run and EVERY journaled write was successfully reversed.
 *   - `undone` — a later `undo` of the batch reversed EVERY journaled entry (or found it already reversed),
 *     leaving nothing live. Without it a committed batch stayed "the newest committed batch" forever: after
 *     batches A and B write one path, undoing B restored A's bytes, yet B remained the default undo target AND a
 *     live writer, so the next bare `undo` re-selected B (a no-op) and an explicit undo of A was refused as
 *     superseded — reversible history the operator could not walk back through (gate finding 3).
 * `rolled-back` and `undone` are the same fact from two directions — this batch holds no live state — and every
 * consumer treats them identically (`isFullyReversed`); they stay distinct only so the record says WHICH path
 * emptied the batch. A PARTIAL reversal (a rollback `undo()` that itself failed, or an undo with any `failed` or
 * `superseded` entry) is deliberately NOT recorded: leaving it unknown keeps that batch the default undo target,
 * which is the only way the stranded file stays reachable by a plain `undo`. See `apply`'s abort path and
 * `undoBatch`.
 */
export const BatchTerminalState = z.enum(["committed", "rolled-back", "undone"]);
export type BatchTerminalState = z.infer<typeof BatchTerminalState>;

/** One finished batch. Validated on read (KTD3) exactly like the undo journal — it is a file that can be torn
 *  mid-append, hand-edited, or partially written on a crash, so it is untrusted input, never an `as` cast. */
export const BatchStatusRecord = z.object({
  batchId: z.string().min(1),
  /** The batch's canonicalized project root, so a record can be matched to the batch it claims to describe. */
  projectRoot: z.string().min(1),
  status: BatchTerminalState,
  ts: z.number().int().nonnegative(),
});
export type BatchStatusRecord = z.infer<typeof BatchStatusRecord>;

/** The append-only JSONL of batch terminal states, a sibling of `configwrite`'s undo journal in the data dir.
 *  Takes an ALREADY-resolved dataDir, mirroring `journalPath` — callers resolve, so the two files can never
 *  end up in different directories. */
export function batchStatusPath(dataDir: string): string {
  return join(dataDir, "provision-batch-status.jsonl");
}

/**
 * Record how a batch finished — BEST-EFFORT: every failure is logged and swallowed. This runs at the very end of
 * `apply` (`committed`/`rolled-back`) or of `undoBatch` (`undone`), after the outcome is already determined, and
 * an operation that genuinely succeeded must never be reported as failed because a metadata line could not be
 * appended (the same discipline the access log uses). A dropped record simply leaves the batch's state unknown,
 * which the fail-safe treats as eligible. `dataDir` is optional to match the readers — `undoBatch`'s own
 * `dataDir` is optional, and both sides must resolve the default identically or they would read and write
 * different files.
 */
export function recordBatchStatus(dataDir: string | undefined, batchId: string, projectRoot: string, status: BatchTerminalState): void {
  const record: BatchStatusRecord = { batchId, projectRoot: canonicalProjectRoot(projectRoot), status, ts: Date.now() };
  const path = batchStatusPath(resolveDataDir(dataDir));
  try {
    appendJsonlRecord(path, record);
  } catch (err) {
    console.error(`[agent-os] provision: recording terminal state '${status}' for batch '${batchId}' failed (undo selection degrades to journal order):`, err);
  }
}

/**
 * Every well-formed terminal state, newest record winning per `batchId` (a batch is written once, but a
 * duplicate must resolve deterministically rather than by read order). Malformed/torn/schema-invalid lines are
 * skipped — one corrupt row must not hide the good records around it, and an unparseable file must not throw
 * a read that `undo` depends on. A missing file yields an empty map: unknown everywhere ⇒ eligible everywhere.
 *
 * The read goes through the layer's BOUNDED reader (`readFileBounded`) so a FIFO at this path cannot block
 * `undo` forever and an oversized one cannot be loaded whole. Every refusal collapses to the SAME empty map,
 * which keeps the fail-safe pointing the one direction it must: a status file we could not read leaves every
 * batch unknown and therefore ELIGIBLE, never hidden from a plain `undo`.
 */
export function readBatchStatuses(dataDir?: string): Map<string, BatchStatusRecord> {
  const path = batchStatusPath(resolveDataDir(dataDir));
  const out = new Map<string, BatchStatusRecord>();
  const read = readFileBounded(path);
  // absent, oversized, non-regular, or unreadable — unknown for every batch, which is the fail-safe (eligible)
  if (!read.ok) return out;
  for (const line of read.content.split("\n")) {
    if (line.trim() === "") continue;
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      continue; // torn / partial line — skip, keep reading
    }
    const parsed = BatchStatusRecord.safeParse(parsedLine);
    if (!parsed.success) continue;
    // Newest `ts` wins, with a later LINE breaking a tie — the same resolution `readKnownProjects` uses. A
    // plain overwrite would make the LAST line win, i.e. read order, which is exactly what this reader must
    // not depend on for a file the module's own contract treats as hand-editable and torn-tail-prone.
    const current = out.get(parsed.data.batchId);
    if (!current || parsed.data.ts >= current.ts) out.set(parsed.data.batchId, parsed.data);
  }
  return out;
}

/**
 * Is this batch AFFIRMATIVELY known to hold NO live state — every journaled write of it reversed, whether by
 * `apply`'s own abort (`rolled-back`) or by a later `undo` (`undone`)? Both consumers ask exactly this question,
 * so they share one predicate rather than each enumerating the states.
 *
 * Requires a well-formed record that both names this `batchId` and agrees on its canonical `projectRoot` — a
 * record whose root disagrees describes a different batch (corruption, or the cross-root case `groupBatches`
 * already quarantines) and is ignored, which lands on the eligible side of the fail-safe. Everything else — no
 * record, `committed`, a root mismatch — is `false`, so only an affirmative fully-reversed verdict ever removes a
 * batch from default undo selection or from the live-writer index.
 */
export function isFullyReversed(batchId: string, projectRoot: string, statuses: ReadonlyMap<string, BatchStatusRecord>): boolean {
  const record = statuses.get(batchId);
  if (record === undefined || record.projectRoot !== canonicalProjectRoot(projectRoot)) return false;
  return record.status === "rolled-back" || record.status === "undone";
}
