/**
 * Private helpers for the blueprint loader (U10 — KTD5/KTD10). The public surface is `blueprint.ts`; this
 * module owns the two things the front-gate must never get wrong: the BOUNDED file read (a secret gate that
 * reads multi-file blueprint content must not hang or OOM), and the content heuristics it runs.
 *
 * The bounded read mirrors `src/scan/internal.ts` and `src/codex-credential.ts` EXACTLY — a stat-before-read
 * regular-file guard + the same 16 MiB ceiling — so all three read boundaries stay identically disciplined.
 */
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, posix } from "node:path";
import { classify } from "../capture/secret-classify";

/**
 * Canonical form of an absolute project root, for BOTH storing it in an undo entry and comparing two roots for
 * equality (gate round 4). `posix.normalize` collapses `.`/`..`/duplicate-slashes but KEEPS a trailing slash, so
 * it alone leaves `/p` and `/p/` distinct — we additionally drop a trailing slash (except the filesystem root
 * `/`). Result: `/p`, `/p/`, and `/p/x/..` all canonicalize to one string, so a batch applied under one spelling
 * is found by an undo under another. Lexical ONLY — a symlinked root is a different string this cannot fold; the
 * realpath happens once at the CLI ingress (`cli.ts`, issue #51.1), so roots reaching here are already resolved.
 */
export function canonicalProjectRoot(root: string): string {
  const normalized = posix.normalize(root);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** Same 16 MiB ceiling as `src/scan/internal.ts` / `src/codex-credential.ts` — generous for real blueprint
 *  files (KBs), bounding the OOM surface of a pathological oversized one. Also bounds this layer's two
 *  append-only sidecars (`registry.ts`, `batch-status.ts`), which read through `readFileBounded` below: one
 *  ceiling for every read this layer performs, so no read boundary can drift from the others. */
const MAX_BLUEPRINT_BYTES = 16 * 1024 * 1024; // 16 MiB, matching src/scan/internal.ts

/**
 * The outcome of one bounded read. `absent` (ENOENT) and `blocked` (present but not a safely-readable
 * regular file within bounds — a directory/FIFO/device, oversized, or unreadable) are kept DISTINCT because
 * the loader treats them differently: an absent SOURCE is skipped (no bytes exist to classify), but a
 * `blocked` one fails the gate CLOSED — bytes we could not read are bytes we could not certify secret-free.
 */
export type ReadOutcome = { ok: true; content: string } | { ok: false; reason: "absent" | "blocked" };

/**
 * The one file-I/O seam the loader depends on — injected so tests never touch a real HOME (mirrors how
 * `codex-credential.ts` threads an injectable home). The default (`realBlueprintIo`) reads real files with
 * the bounded discipline below; tests pass a fake to drive fuzz content and read failures directly.
 */
export interface BlueprintIo {
  readFileBounded(path: string): ReadOutcome;
}

/**
 * Bounded, total read of one blueprint file — and, since it is the layer's ONE disciplined read, of the two
 * append-only sidecars too. The stat-before-read confirms a bounded REGULAR file, so a FIFO/character-device at
 * the path can't block the read indefinitely (no writer ever comes) and an oversized file can't OOM us — either
 * is refused WITHOUT reading. ENOENT is reported distinctly from every other read failure so the loader can
 * skip-vs-fail per its own policy; the sidecar readers collapse both to "no records". Never throws.
 */
export function readFileBounded(path: string): ReadOutcome {
  let raw: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BLUEPRINT_BYTES) return { ok: false, reason: "blocked" };
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, reason: isNotFound(e) ? "absent" : "blocked" };
  }
  return { ok: true, content: raw };
}

/** The real file-I/O the loader uses in production. */
export const realBlueprintIo: BlueprintIo = { readFileBounded };

/**
 * One live-destination read, BYTE-aware — the read side of the diff (KTD8 needs raw bytes for the opaque-text
 * identity check, which a lossy utf8 round-trip would defeat). Distinct from `readFileBounded` above, which
 * returns decoded text for the secret gate; this one returns both forms.
 *
 * It lives HERE, shared, rather than privately in each caller: `apply` and the CLI's `plan`/`status` must read a
 * live destination IDENTICALLY, or the two verbs disagree about a symlinked or oversized target — exactly the
 * surprise R10 exists to prevent. It was briefly duplicated (once in `apply.ts`'s composition root, once in
 * `cli.ts`) under a "private to one composition root" rationale that expired the moment the second call site
 * existed; a comment promising two copies would stay in sync documents a hazard instead of removing it.
 *
 * Mirrors the engine's lstat discipline: a symlink or non-regular node reads as `blocked`, never silently
 * absent, so provisioning never writes through an indirection it did not describe; an oversized file is refused
 * before it is read into memory; only ENOENT is `absent`.
 *
 * The return shape is written structurally rather than importing `diff.ts`'s `DestinationRead`: `diff.ts`
 * already imports `ReadOutcome` from here, so naming its type would invert this module's place in the DAG for
 * nothing. Structural typing satisfies `DestinationReader` at every call site, and `Buffer` IS a `Uint8Array`.
 */
export function readDestinationBounded(
  absPath: string,
):
  | { ok: true; content: string; bytes: Uint8Array }
  | { ok: false; reason: "absent" | "blocked"; blockedBy?: "symlink" | "oversized" | "non-regular" | "unreadable" } {
  try {
    const stat = lstatSync(absPath);
    // Each refusal names WHICH one it is: the remedies are completely different (remove the link, shrink the
    // file, fix the mode), and a bare "unreadable" sends the operator hunting. A symlinked destination is the
    // one that actually happens — `AGENTS.md` symlinked to `CLAUDE.md` is a common multi-harness convention,
    // and the seed provisions BOTH of those paths.
    if (stat.isSymbolicLink()) return { ok: false, reason: "blocked", blockedBy: "symlink" };
    if (!stat.isFile()) return { ok: false, reason: "blocked", blockedBy: "non-regular" };
    if (stat.size > MAX_BLUEPRINT_BYTES) return { ok: false, reason: "blocked", blockedBy: "oversized" };
    const bytes = readFileSync(absPath);
    return { ok: true, content: bytes.toString("utf8"), bytes };
  } catch (err) {
    return isNotFound(err) ? { ok: false, reason: "absent" } : { ok: false, reason: "blocked", blockedBy: "unreadable" };
  }
}

/** ENOENT (the path truly does not exist) vs any other stat/read failure (permissions, etc.). Reads the
 *  Node error's `code` through a typeof guard so inspecting the thrown value can't itself throw. Shared by the
 *  loader here and the apply orchestrator (`apply.ts`) so "what counts as ENOENT" has one definition in-module. */
export function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";
}

/** Message text of a caught unknown error. Kept in `provision/internal.ts` — not imported from
 *  `install/shared.ts` — so provision never depends on install (the wrong dependency direction); `apply.ts`
 *  and `runs.ts` both import this one copy so their error formatting can't drift. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether `text` carries a machine-specific absolute home path — a portability violation (R4). Targets
 * user-home roots (`/Users/<u>`, `/home/<u>`, `/root/<u>`), NOT portable system paths (`/usr`, `/etc`),
 * because R4 bans MACHINE-specific paths, not all absolute ones. The leading `(?:^|[^\w.\-/])` requires the
 * `/Users` to START an absolute path — a `/Users` that is only a segment of a relative path (`roles/Users/…`)
 * or the host of a `//Users` URL is preceded by a word char or a slash and does NOT match. Windows drive
 * paths are a future extension (Jarod's stack + the run-1 fixture are POSIX). `.test` never throws and the
 * pattern has no nested quantifiers (no catastrophic backtracking), so this keeps the loader total.
 */
const MACHINE_ABS_PATH = /(?:^|[^\w.\-/])\/(?:Users|home|root)\/[^\/\s"']+/;

export function hasMachineAbsolutePath(text: string): boolean {
  return MACHINE_ABS_PATH.test(text);
}

/** True when `classify` flags any secret pattern in `text`. The floor is irrelevant — we only test for the
 *  `"secret"` escalation — so any non-secret floor works. Reuses the capture-time classifier UNCHANGED
 *  (KTD5 — one classifier, one place to harden).
 *
 *  NO-HANG CAVEAT (issue #42; decision #45): the shared classifier has super-linear (ReDoS-class) regex
 *  patterns on pathological keyword/`eyJ`-dense input. That was fine for its original small capture chunks,
 *  but this gate runs it over whole source files up to the 16 MiB read cap, so a pathological LARGE own-file
 *  source can stall the gate. Pre-existing and unmodified here — the correct fix is a single-pass linear
 *  scanner (its own unit; a finite quantifier bound only trades the hang for a false-negative), deferred as a
 *  scoped own-files defer. Real blueprint sources are small prose/config, so this is not a live risk. */
export function containsSecret(text: string): boolean {
  return classify(text, "path") === "secret";
}

/**
 * Append one self-contained JSONL record, isolating a torn tail — the shared writer for this layer's two
 * append-only sidecars (`batch-status.ts`, `registry.ts`).
 *
 * If a prior crash left a partial final line (no trailing newline), a plain append would concatenate onto it
 * and corrupt BOTH lines — losing the new record too. Leading with a newline keeps the torn line isolated so
 * the reader skips exactly one row. Owner-only throughout: 0600 file inside a 0700 directory, since these
 * records name the operator's real project paths.
 *
 * `configwrite`'s undo journal implements the identical discipline and deliberately keeps its own copy:
 * `provision` depends on `configwrite`, never the reverse, so sharing one definition would invert the module
 * DAG. Two copies across that barrier, one within this layer.
 */
export function appendJsonlRecord(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tail = probeTail(path);
  // A FIFO/device/directory at a sidecar path is refused BEFORE the append: `appendFileSync` opens a FIFO for
  // write and blocks until a reader appears, which is the write-side twin of the read hang the probe avoids.
  // Throwing here matches `configwrite`'s `statTarget`, which refuses a non-regular write target the same way;
  // both callers already handle a throw correctly (`registerProject` reports `write-failed`, `recordBatchStatus`
  // logs and swallows), so the refusal lands on each one's existing fail direction.
  if (tail === "not-regular") throw new Error(`refusing to append: ${path} is not a regular file`);
  appendFileSync(path, (tail === "torn" ? "\n" : "") + JSON.stringify(record) + "\n", { mode: 0o600 });
}

/**
 * Does the file end mid-line, so the next append must lead with a newline to isolate the torn tail?
 *
 * A ONE-BYTE positional read, not a whole-file read: these sidecars grow one line per `init`/apply forever, and
 * the previous implementation read the entire file on EVERY append just to look at its last byte — a cost that
 * scaled with history and had no bound at all. One `open` + `fstat` + one-byte `read` is constant work.
 *
 * O_NONBLOCK is load-bearing: a plain open of a FIFO blocks until a writer appears, so the probe would reproduce
 * the very hang it exists to remove. With it, opening a pipe returns immediately and `fstat` on the SAME
 * descriptor answers "is this a regular file" with no stat/open TOCTOU window.
 *
 * Failure direction: any I/O failure that is not a positive non-regular verdict reports `torn`, i.e. lead with a
 * newline. A spurious blank line is skipped by every reader; a MISSING one concatenates two records and destroys
 * both. ENOENT is `absent` — a file we are about to create has no torn tail to isolate.
 */
function probeTail(path: string): "absent" | "clean" | "torn" | "not-regular" {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "not-regular";
    if (stat.size === 0) return "clean"; // an empty file already starts on a clean line
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, stat.size - 1);
    return last[0] === 0x0a ? "clean" : "torn";
  } catch (err) {
    return isNotFound(err) ? "absent" : "torn";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
