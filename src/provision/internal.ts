/**
 * Private helpers for the blueprint loader (U10 — KTD5/KTD10). The public surface is `blueprint.ts`; this
 * module owns the two things the front-gate must never get wrong: the BOUNDED file read (a secret gate that
 * reads multi-file blueprint content must not hang or OOM), and the content heuristics it runs.
 *
 * The bounded read mirrors `src/scan/internal.ts` and `src/codex-credential.ts` EXACTLY — a stat-before-read
 * regular-file guard + the same 16 MiB ceiling — so all three read boundaries stay identically disciplined.
 */
import { readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { classify } from "../capture/secret-classify";

/**
 * Canonical form of an absolute project root, for BOTH storing it in an undo entry and comparing two roots for
 * equality (gate round 4). `posix.normalize` collapses `.`/`..`/duplicate-slashes but KEEPS a trailing slash, so
 * it alone leaves `/p` and `/p/` distinct — we additionally drop a trailing slash (except the filesystem root
 * `/`). Result: `/p`, `/p/`, and `/p/x/..` all canonicalize to one string, so a batch applied under one spelling
 * is found by an undo under another. Lexical ONLY — a symlinked root is a different string this cannot fold, so
 * realpath canonicalization at the U6 registry ingress stays deferred (issue #51).
 */
export function canonicalProjectRoot(root: string): string {
  const normalized = posix.normalize(root);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** Same 16 MiB ceiling as `src/scan/internal.ts` / `src/codex-credential.ts` — generous for real blueprint
 *  files (KBs), bounding the OOM surface of a pathological oversized one. */
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
 * Bounded, total read of one blueprint file. The stat-before-read confirms a bounded REGULAR file, so a
 * FIFO/character-device at the path can't block the read indefinitely (no writer ever comes) and an oversized
 * file can't OOM us — either is refused WITHOUT reading. ENOENT is reported distinctly from every other read
 * failure so the loader can skip-vs-fail per its own policy. Never throws.
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
