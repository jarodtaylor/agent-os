/**
 * Undo journal + restore — the reverse half of every config mutation (R11, KTD6).
 *
 * Persistence is on-disk JSONL by design, not convenience: an installer records an entry on install,
 * and a *separate process* (the uninstaller, possibly days later) restores from it. Cross-process undo
 * is therefore a requirement. Entries are append-only; `undo` is idempotent via filesystem-state checks,
 * so a double-undo — or an undo after the target was already cleaned up by hand — never throws.
 */
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import * as z from "zod";
import { ConfigFormat, hashContent, journalPath, resolveDataDir } from "./internal";

/**
 * One reversible mutation. Validated on read (KTD3: validate anything externally sourced) because the
 * journal is a file that could be truncated mid-append, hand-edited, or partially written on a crash.
 */
export const UndoEntry = z.object({
  id: z.string().min(1),
  targetPath: z.string().min(1),
  // Path to the byte-exact copy of the pre-mutation file; `null` when the mutation CREATED the target
  // (there was nothing to back up, so undo means "delete the created file").
  backupPath: z.string().min(1).nullable(),
  created: z.boolean(),
  // The original file's permission bits, restored on undo; `null` when the target was created.
  mode: z.number().int().nonnegative().nullable(),
  format: ConfigFormat,
  // SHA-256 of the bytes this mutation wrote. undo refuses unless the target still matches this (or the
  // restored backup), so undoing an old entry can't silently clobber a LATER write to the same file.
  postHash: z.string().min(1),
  ts: z.number().int().nonnegative(),
});
export type UndoEntry = z.infer<typeof UndoEntry>;

/** Append an undo entry to the on-disk journal. Called by the engine only after a write fully succeeds. */
export function recordUndo(entry: UndoEntry, dataDir: string): void {
  const path = journalPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Isolate a torn tail: if a prior crash left a partial final line (no trailing newline), a plain append
  // would concatenate onto it and corrupt BOTH lines — losing THIS entry too. Lead with a newline so a new
  // entry always starts on a clean line; the torn line stays isolated and is skipped on read.
  const lead = existsSync(path) && !endsWithNewline(path) ? "\n" : "";
  appendFileSync(path, lead + JSON.stringify(entry) + "\n", { mode: 0o600 });
}

/** True iff the journal ends with a newline (or is empty) — i.e. the next append starts on a clean line. */
function endsWithNewline(path: string): boolean {
  const buf = readFileSync(path);
  return buf.length === 0 || buf[buf.length - 1] === 0x0a;
}

/**
 * Read every well-formed journal entry, oldest-first.
 *
 * Malformed lines are skipped defensively: a torn final line from a crashed append, or one corrupt
 * row, must not hide the good entries around it. A line that fails schema validation is dropped the
 * same way — the journal is treated as untrusted input, never a source of `as`-cast trust.
 */
export function listUndo(dataDir?: string): UndoEntry[] {
  const path = journalPath(resolveDataDir(dataDir));
  if (!existsSync(path)) return [];
  const out: UndoEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // torn / partial line — skip, keep reading
    }
    const parsed = UndoEntry.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Reverse the mutation named by `id`: restore the target to its exact pre-mutation bytes + mode, or
 * delete it if the mutation created it.
 *
 * SAFE against later writes: undo only proceeds if the target still holds exactly what this mutation
 * left (its `postHash`) — otherwise a newer write or manual edit has diverged the file, and undo throws
 * rather than clobber it. Idempotent: a target already restored to its backup (or an already-deleted
 * created file) is a no-op. Throws loudly on an unknown id, a missing backup, or a diverged target — an
 * undo that cannot faithfully restore must never silently pretend to have worked.
 */
export function undo(id: string, dataDir?: string): void {
  const resolved = resolveDataDir(dataDir);
  // Newest-wins if an id ever recurs (it shouldn't — ids are UUIDs); findLast scans back-to-front.
  const entry = listUndo(resolved).findLast((e) => e.id === id);
  if (!entry) throw new Error(`configwrite.undo: no journal entry for id '${id}'`);

  const currentHash = existsSync(entry.targetPath) ? hashContent(readFileSync(entry.targetPath)) : null;

  if (entry.created) {
    // The mutation CREATED the target → undo deletes it. Already gone ⇒ idempotent no-op. Only delete if
    // the file is still exactly what we created — never discard a later edit to it.
    if (currentHash === null) return;
    if (currentHash !== entry.postHash) {
      throw new Error(`configwrite.undo: '${entry.targetPath}' changed since it was created (id '${id}') — refusing to delete`);
    }
    rmSync(entry.targetPath, { force: true });
    return;
  }

  // The target pre-existed → restore its original bytes.
  if (!entry.backupPath || !existsSync(entry.backupPath)) {
    throw new Error(`configwrite.undo: backup missing for id '${id}' (${entry.backupPath ?? "null"})`);
  }
  if (currentHash === null) {
    throw new Error(`configwrite.undo: '${entry.targetPath}' no longer exists (id '${id}') — refusing to resurrect it`);
  }
  if (currentHash === hashContent(readFileSync(entry.backupPath))) {
    return; // already restored to the backup — idempotent no-op
  }
  if (currentHash !== entry.postHash) {
    throw new Error(`configwrite.undo: '${entry.targetPath}' changed since this mutation (id '${id}') — refusing to clobber a later write`);
  }
  restoreAtomically(entry.backupPath, entry.targetPath, entry.mode);
}

/**
 * Copy `backupPath` over `targetPath` atomically: write a sibling temp, set `mode`, then rename — bytes
 * and mode land together, so a mid-restore I/O failure can never truncate the live config being restored.
 */
function restoreAtomically(backupPath: string, targetPath: string, mode: number | null): void {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    copyFileSync(backupPath, tmpPath);
    if (mode !== null) chmodSync(tmpPath, mode);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}
