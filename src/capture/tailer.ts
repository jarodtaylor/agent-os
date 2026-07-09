/**
 * The raw-lane tailer (U5) — the harness-AGNOSTIC "read a transcript from its cursor, persist a breadcrumb
 * trail, remember where we stopped" mechanism. It is deliberately blind to what any transcript LOOKS like:
 * all shape knowledge lives behind the injected `Extractor` (claude-code.ts for Claude Code; Codex/U8 will
 * drop in its own extractor against this same tailer — that reuse is the whole reason the seam exists).
 *
 * What lives HERE (generic): byte-accurate incremental file reads from a persisted offset, complete-line
 * framing, JSON parsing with skip-on-malformed resilience, `machineId` stamping, contract validation at the
 * write boundary, and cursor advancement. What lives in the extractor (harness-specific): every field a
 * breadcrumb carries except `machineId`.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { Breadcrumb } from "../contract/index";
import type { Repo } from "../store/repo";

/** Where in which file an event was read from — the extractor uses this for project fallback + a stable id
 *  seed when an event carries no uuid of its own. */
export interface ExtractContext {
  /** Absolute path of the transcript the event came from. */
  sourcePath: string;
  /** Byte offset of the event line's START within the file. */
  byteOffset: number;
}

/**
 * A breadcrumb minus the machine-global `machineId` — everything a harness extractor can know from its OWN
 * transcript (id, project, sessionId, source, kind, summary, ts, sensitivity). The tailer stamps `machineId`
 * (a per-machine identity, not a per-harness one) and validates the assembled record against `Breadcrumb`.
 */
export type ExtractedBreadcrumb = Omit<Breadcrumb, "machineId">;

/**
 * Maps one parsed JSONL event (+ context) to zero or more breadcrumbs. ALL harness-specific transcript
 * knowledge lives behind this one function type, so the tailer never learns a transcript's shape. Contract:
 * PURE and SYNCHRONOUS — no I/O, no cross-event state — which is exactly what lets one file be re-read
 * idempotently (the same event always yields the same crumbs, hence the same ids).
 */
export type Extractor = (event: unknown, ctx: ExtractContext) => ExtractedBreadcrumb[];

export interface TailerDeps {
  repo: Repo;
  /** The harness-specific transcript decoder (e.g. `extractClaudeCode`). */
  extractor: Extractor;
  /** This machine's federation id (`paths.ts#resolveMachineId`) — a persisted opaque UUID, stamped onto
   *  every crumb. NEVER `os.hostname()` (see the paths.ts rationale). */
  machineId: string;
}

const NEWLINE = 0x0a; // '\n'

/**
 * Read `sourcePath` from its persisted `capture_cursor` offset to EOF, persist every extracted breadcrumb,
 * then advance the cursor. Returns the count of validated crumbs SUBMITTED to the store this pass — the
 * per-id idempotent append may dedupe some, so this is not necessarily the number of net-new rows.
 *
 * Invariants (KTD4 + U2):
 *  - BYTE-ACCURATE. The cursor is a byte offset; lines are framed on the `\n` byte and every offset is
 *    tracked in bytes, so a multi-byte UTF-8 character can never desync the resume point (a char-based
 *    offset would).
 *  - COMPLETE LINES ONLY. A partial trailing line — a mid-write append or a crash-truncated final event —
 *    is left unprocessed for a later pass; the cursor advances to exactly the last complete line's end. A
 *    crashed session's transcript is still fully usable up to its last flushed line (capture never depends
 *    on a clean session end).
 *  - WRITE-THEN-ADVANCE. Crumbs are persisted BEFORE the cursor moves (at-least-once). A crash in between
 *    re-derives the identical crumbs next pass; the store's per-id idempotent append collapses the retry —
 *    no duplicate rows.
 *  - RESILIENT. A malformed JSON line is skipped without killing the tail, and the cursor still advances
 *    past it (re-reading a byte-for-byte-identical bad line would only fail again). An extractor throw or a
 *    contract-invalid crumb, by contrast, is a bug on a VALID line — it aborts the pass before the cursor
 *    advances (retried after the fix), so it is never silently skipped.
 *
 * SCOPE — the no-lost-crumbs guarantee holds for APPEND-ONLY inputs, which Claude Code transcripts are (per-
 * session files that only grow; `--resume` copies events verbatim to a NEW path). Truncation and a rewrite
 * that shifts the byte at `cursor-1` off its newline are detected and re-tailed. But a same-SHAPE, same-UUID
 * in-place rewrite (different content, identical event ids, a `\n` still at `cursor-1`) is OUT OF CONTRACT:
 * even when re-tailed, the store's per-id idempotent append keeps the first-written row (first-write-wins), so
 * the rewritten content is not reflected. That case cannot occur for Claude Code; full rewrite/rotation safety
 * (generation-aware crumb identity) is the Codex/U8 concern tracked in open-findings U5-R2.
 */
export async function tailFile(deps: TailerDeps, sourcePath: string): Promise<number> {
  // machineId is stamped onto EVERY crumb (contract federation, min-length 1). Guard this global precondition
  // ONCE up front: an empty/misconfigured machineId would fail Breadcrumb.parse for the WHOLE batch, and the
  // per-crumb "validate + skip" loop below (right for a line-specific extractor bug) would then drop every
  // crumb while the cursor still advanced past them — a silent, total, unrecoverable loss. Throwing here
  // (caught + logged per-file by tailAll, so the cursor is never reached) makes the misconfig loud + lossless.
  if (!deps.machineId) {
    throw new Error("[agent-os] tailer: empty machineId — refusing to tail (would drop every breadcrumb)");
  }

  let start = (await deps.repo.readCaptureCursor(sourcePath)) ?? 0;

  let size: number;
  try {
    size = statSync(sourcePath).size;
  } catch {
    return 0; // file vanished or is unreadable this pass — nothing to do
  }
  if (start === size) return 0; // at EOF, no new bytes (covers the empty-file and no-new-bytes cases)
  if (start > size) {
    // File shrank below the cursor (truncate / rotate / rewrite): the stored offset now points past EOF, and
    // a bare `>=` would strand it there forever, silently losing every event written into the reclaimed low
    // range. Reset to re-tail from the new beginning; stable ids + idempotent append dedupe any unchanged
    // prefix. Persist the reset now so a no-complete-line pass can't re-loop on the stale high offset.
    start = 0;
    await deps.repo.writeCaptureCursor(sourcePath, 0);
  }
  if (start > 0) {
    // Append-only invariant: the cursor always sits just past the '\n' that ended the last complete line, so
    // `file[start-1]` must be that newline. If it isn't, the file was rewritten/rotated in place to the
    // same-or-greater length (a `start > size` shrink is handled above), so the stale offset now points into
    // unrelated bytes and a bare resume would skip the whole rewritten prefix. Re-tail from 0. Cheap,
    // schema-free guard; the residual — a same-SHAPE rewrite that still leaves a '\n' at start-1 — needs the
    // inode + prefix-hash fingerprint tracked in open-findings U5-R2.
    const boundary = readRange(sourcePath, start - 1, 1);
    if (boundary.length === 0 || boundary[0] !== NEWLINE) {
      start = 0;
      await deps.repo.writeCaptureCursor(sourcePath, 0);
    }
  }

  const buf = readRange(sourcePath, start, size - start);

  // First scan: frame complete lines, parse, extract. `lastCompleteEnd` tracks how far the cursor may
  // safely advance — updated on EVERY newline (a malformed line is still a COMPLETE line we must move past).
  const pending: ExtractedBreadcrumb[] = [];
  let lineStart = 0; // byte index of the current line's start, relative to `start`
  let lastCompleteEnd = 0; // relative byte offset just past the last complete line's newline
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== NEWLINE) continue;
    const absOffset = start + lineStart;
    const line = buf.toString("utf8", lineStart, i); // excludes the '\n'
    lineStart = i + 1;
    lastCompleteEnd = i + 1;

    const text = line.trim();
    if (!text) continue; // blank line
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      // Malformed JSON is the ONLY safely-skippable failure: the line's BYTES are corrupt, so re-reading the
      // identical bytes would only fail again. Skip it; the cursor still passes it (lastCompleteEnd advanced).
      continue;
    }
    // Extraction runs OUTSIDE the parse catch. An extractor throw is a BUG / shape-drift on a VALID line, not
    // a corrupt line — swallowing-and-advancing-past it would silently lose a real event. Letting it propagate
    // aborts this file's pass before the cursor advances, so the line is retried after the fix (tailAll logs
    // it per-file; other files keep tailing). Corrupt JSON above is the one failure we skip.
    for (const crumb of deps.extractor(event, { sourcePath, byteOffset: absOffset })) pending.push(crumb);
  }

  // VALIDATE + stamp machineId (the one field WE inject; the extractor never sees it). A crumb that fails the
  // contract is an extractor bug on a VALID line — like an extractor throw, it must NOT be silently
  // skipped-and-advanced-past (that loses the line for good). Propagate so the cursor is not advanced and the
  // line is retried after the fix; this preserves no-lost-crumbs. Corrupt JSON in the scan above is the ONLY
  // skippable failure. (machineId itself — a global precondition — is already guarded at the top of tailFile.)
  const valid: Breadcrumb[] = pending.map((crumb) => {
    try {
      return Breadcrumb.parse({ ...crumb, machineId: deps.machineId });
    } catch (err) {
      throw new Error(
        `[agent-os] tailer: extractor produced a contract-invalid breadcrumb from ${sourcePath} — aborting this file's pass, cursor unchanged for retry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // WRITE-then-advance, and the writes are deliberately NOT wrapped: a store failure here is TRANSIENT
  // (SQLITE_BUSY under real concurrency, disk-full) and must PROPAGATE — so the cursor below is never
  // reached, the offset stays put, and this exact region is retried next pass. The stable ids + idempotent
  // append make that retry a no-op for anything already written (at-least-once). Swallowing the failure would
  // advance the cursor past an unwritten crumb and lose it forever — defeating the very idempotency the
  // write-then-advance ordering exists to exploit.
  for (const crumb of valid) await deps.repo.writeBreadcrumb(crumb);

  const newCursor = start + lastCompleteEnd;
  if (newCursor > start) await deps.repo.writeCaptureCursor(sourcePath, newCursor);
  return valid.length;
}

/** Tail each file once, in order; returns the total crumbs written across all of them. One unreadable or
 *  vanished transcript is skipped (logged) rather than aborting the sweep — the module's resilience contract,
 *  and it keeps a single bad file from crashing the U6 daemon loop. A store-write fault inside `tailFile`
 *  still leaves that file's cursor un-advanced, so the caught region is retried on the next sweep. */
export async function tailAll(deps: TailerDeps, sourcePaths: string[]): Promise<number> {
  let total = 0;
  for (const sourcePath of sourcePaths) {
    try {
      total += await tailFile(deps, sourcePath);
    } catch (err) {
      console.error(`[agent-os] tailer: skipping ${sourcePath} this pass:`, err);
    }
  }
  return total;
}

/**
 * Discover transcript files under `root`: one level of subdirectories, each holding `*.jsonl` session files
 * (the `~/.claude/projects/<mangled-project>/<session>.jsonl` layout). A missing/unreadable root, or an
 * unreadable subdir, is skipped rather than thrown — discovery is best-effort so one bad dir can't blind the
 * whole sweep. Returns absolute paths.
 */
export function discoverTranscripts(root: string): string[] {
  let subdirs: string[];
  try {
    subdirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dir of subdirs) {
    const dirPath = join(root, dir);
    try {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        // withFileTypes so a DIRECTORY named `*.jsonl` is never handed to the tailer (openSync -> EISDIR,
        // which would abort every sweep at that file until it's removed).
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dirPath, entry.name));
      }
    } catch {
      // unreadable subdir — skip it, keep sweeping the rest
    }
  }
  return files;
}

/**
 * Read exactly `[offset, offset+length)` of a file into a Buffer, looping because a single `readSync` may
 * return short. If the file shrank between `stat` and the read (a truncate/rotate), we return the bytes
 * actually read rather than trusting the stale length.
 */
export function readRange(path: string, offset: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, offset + read);
      if (n === 0) break; // early EOF (file shrank) — stop and use what we have
      read += n;
    }
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
