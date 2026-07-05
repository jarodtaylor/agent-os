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
 * then advance the cursor. Returns the number of crumbs written this pass.
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
 *    past it (re-reading a byte-for-byte-identical bad line would only fail again).
 */
export async function tailFile(deps: TailerDeps, sourcePath: string): Promise<number> {
  const start = (await deps.repo.readCaptureCursor(sourcePath)) ?? 0;

  let size: number;
  try {
    size = statSync(sourcePath).size;
  } catch {
    return 0; // file vanished or is unreadable this pass — nothing to do
  }
  if (start >= size) return 0; // offset already at EOF (covers the empty-file and no-new-bytes cases)

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
    try {
      const event = JSON.parse(text);
      for (const crumb of deps.extractor(event, { sourcePath, byteOffset: absOffset })) pending.push(crumb);
    } catch {
      // Malformed JSON: skip this one line and keep tailing. The cursor still passes it (lastCompleteEnd
      // already advanced above), so we never wedge the tail on a single bad line.
    }
  }

  // VALIDATE first — a crumb that fails the contract is a bug in the extractor, NOT a transient fault. Skip
  // it and keep the batch: re-deriving it next pass would only reproduce the same bad crumb, so there is
  // nothing to wait for. This is the only failure the tailer is entitled to swallow.
  const valid: Breadcrumb[] = [];
  for (const crumb of pending) {
    try {
      valid.push(Breadcrumb.parse({ ...crumb, machineId: deps.machineId }));
    } catch (err) {
      console.error(`[agent-os] tailer: dropping malformed breadcrumb from ${sourcePath}:`, err);
    }
  }

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

/** Tail each file once, in order; returns the total crumbs written across all of them. */
export async function tailAll(deps: TailerDeps, sourcePaths: string[]): Promise<number> {
  let total = 0;
  for (const sourcePath of sourcePaths) total += await tailFile(deps, sourcePath);
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
      for (const name of readdirSync(dirPath)) {
        if (name.endsWith(".jsonl")) files.push(join(dirPath, name));
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
function readRange(path: string, offset: number, length: number): Buffer {
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
