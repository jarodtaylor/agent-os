/**
 * Apply/undo orchestration (U10 U5 — R5/R7/R8 write side, KTD2/KTD8).
 *
 * Apply is the ONE Act path: it composes the pure U3 render + diff, the U4 target registry, and the U14
 * config-write engine into an ABORT-ALL batch write. A half-provisioned project would defeat "clone +
 * provision reproducibly", so the pass is all-or-nothing: preflight-then-write, never interleaved.
 *
 * Order (brief pt 1):
 *   renderBlueprint → diffRendered (over the SAME RenderedFile[], so rows co-index with files by construction)
 *   → checkTargetCompatibility for every non-noop / non-scaffold-skip target → THEN the write pass.
 * An unresolvable/incompatible/unreadable/malformed target aborts BEFORE any file is written (nothing to roll
 * back). Compatibility does NOT check writability, so a mid-write fault (an unwritable dir) still reaches the
 * write pass and exercises rollback — preflight and rollback are BOTH load-bearing.
 *
 * Two error regimes inside the write pass (brief pt 4):
 *   - a genuine throw mid-write → the mutation NEVER landed → roll back this batch's earlier writes LIFO →
 *     abort, report the file in `failed`.
 *   - an AppliedButUnjournaledError → the write LANDED with no undoId → warn, annotate the applied write as
 *     un-undoable (`applied[].unjournaled`), and CONTINUE. The rollback list is built INCREMENTALLY (each undoId
 *     pushed as its write returns), so a later error's rollback can never reverse an applied-but-unjournaled
 *     write and the report stays honest.
 *
 * LIFO reversal is universal (brief pt 3): a blueprint CAN write the same destination twice (two config-merge
 * rows into one shared `.cursor/mcp.json`), forming a postHash chain X→v1→v2. `undo` is hash-checked, so v2
 * must reverse before v1 — LIFO is required when same-target collisions are possible and harmless otherwise.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AppliedButUnjournaledError,
  mergeConfig,
  undo,
  writeTextFile,
  type MergeOptions,
  type MergeResult,
} from "../configwrite/index";
import type { Manifest, Runtime } from "../contract/index";
import { diffRendered, type DestinationRead, type DestinationReader, type DiffError, type PlanAction } from "./diff";
import { containsSecret, errorText, isNotFound, readFileBounded } from "./internal";
import { isPlainRecord, parseConfigValue, renderBlueprint, type RenderError, type RenderedFile, type RenderIo } from "./render";
import {
  checkTargetCompatibility,
  resolveTarget,
  type ProvisionHarness,
  type ResolvedTarget,
  type TargetInspection,
  type TargetPathState,
} from "./targets";

/** Same 16 MiB ceiling as the shared read-boundary discipline in `src/provision/internal.ts` (and
 *  `src/scan/internal.ts` / `src/codex-credential.ts`): the two live-destination readers below stat-before-read
 *  and refuse an oversized file rather than OOM on a pathological one. Kept local — a cross-module export just
 *  for this constant would over-couple the modules. */
const MAX_APPLY_READ_BYTES = 16 * 1024 * 1024; // 16 MiB, matching src/provision/internal.ts

/** The two engine primitives apply dispatches to, injectable so a test can wrap them to exercise the
 *  AppliedButUnjournaledError regime honestly (a real write that lands, then the real error type). */
export interface ProvisionEngine {
  mergeConfig(targetPath: string, patch: Record<string, unknown>, opts: MergeOptions): MergeResult;
  writeTextFile(targetPath: string, content: string, opts: MergeOptions): MergeResult;
}

const REAL_ENGINE: ProvisionEngine = { mergeConfig, writeTextFile };

export interface ApplyInput {
  manifest: Manifest;
  /** Absolute root of the blueprint directory; manifest `source` paths are relative to it. */
  blueprintRoot: string;
  /** Absolute project root where native surfaces are written; manifest `destination` paths are relative to it. */
  projectRoot: string;
  /** Root for backups + the undo journal (KTD2). Tests inject a temp dir; the engine writes real paths. */
  dataDir: string;
}

export interface ApplyOptions {
  /** Injectable engine writers (default: the real config-write primitives). */
  engine?: ProvisionEngine;
}

/** One write this run performed (never a noop/scaffold-skip). `undoId` is null when the engine self-no-op'd
 *  or the write was applied-but-unjournaled (un-undoable). */
export interface AppliedWrite {
  targetPath: string;
  action: Extract<PlanAction, "create" | "overwrite" | "merge">;
  created: boolean;
  undoId: string | null;
  /** Present ONLY for an applied-but-unjournaled write — the write LANDED on disk but the journal write failed,
   *  so it is un-undoable (`undoId` is null and it is never in the rollback list). `backupPath` is the byte-exact
   *  backup to recover from when reverting by hand, or `null` when this write CREATED the target (delete the file
   *  to revert). A consumer finds every un-undoable write via `applied.filter((w) => w.unjournaled)`. */
  unjournaled?: { backupPath: string | null; error: string };
}

/**
 * The apply report (KTD2) — mirrors `UninstallOutcome`'s applied/failed shape plus `noops`. Three honesty
 * signals let a U6 CLI / U7 MCP consumer report the truth after an imperfect run without a fragile path-string
 * join back to `applied`:
 *   - `applied[].unjournaled` — an applied write that could not be journaled (un-undoable); recover from its
 *     `backupPath` (or delete a created file) if reverting. On a mid-write abort these SURVIVE in `applied`
 *     (they were never in the rollback list), so a consumer can see what is still stuck on disk.
 *   - `rollbackFailures` — on the abort path, the targets whose rollback `undo()` itself FAILED: they remain
 *     applied on disk despite `rolledBack: true`. Absent/empty on a clean rollback and on the success path,
 *     which is what makes `rolledBack: true` honest rather than an unconditional claim.
 *   - `rolledBack` — true when a genuine mid-write fault aborted the run and LIFO reversal ran.
 * On a clean mid-write abort, `applied` holds only the un-undoable survivors (every reversible write was
 * reversed); on the success path `rolledBack` is false and both annotations are absent/empty.
 */
export interface ApplyOutcome {
  batchId: string;
  applied: AppliedWrite[];
  noops: string[];
  failed: Array<{ path: string; error: string }>;
  rolledBack: boolean;
  /** Present only when a rollback `undo()` failed — those targets remain on disk despite `rolledBack: true`. */
  rollbackFailures?: Array<{ path: string; error: string }>;
}

/**
 * Provision `manifest` onto `projectRoot`, abort-all with LIFO rollback. Reads are real filesystem reads
 * rooted at `blueprintRoot`/`projectRoot` (the composition root; render/diff/targets stay pure/DI); the engine
 * writes real paths under `dataDir`'s journal.
 */
export function apply(input: ApplyInput, options: ApplyOptions = {}): ApplyOutcome {
  const { manifest, blueprintRoot, projectRoot, dataDir } = input;
  const engine = options.engine ?? REAL_ENGINE;
  const batchId = randomUUID();

  // ── Preflight, phase 1: render (pure) ──
  const renderIo: RenderIo = {
    readSource: (source) => readFileBounded(posix.join(blueprintRoot, source)),
    readDestination: (destination) => readFileBounded(posix.join(projectRoot, destination)),
  };
  const rendered = renderBlueprint(manifest, renderIo);
  if (!rendered.ok) {
    return preflightFailure(batchId, projectRoot, rendered.error.destination, renderErrorText(rendered.error));
  }
  const files = rendered.files;

  // ── Preflight, phase 2: diff (pure) over the SAME files — rows co-index with files (brief pt 7) ──
  const readDestinationBytes: DestinationReader = (destination) => readDestination(posix.join(projectRoot, destination));
  const diffed = diffRendered(files, readDestinationBytes);
  if (!diffed.ok) {
    return preflightFailure(batchId, projectRoot, diffed.error.destination, diffErrorText(diffed.error));
  }
  const rows = diffed.rows;

  // ── Preflight, phase 3: resolve every row; for non-skip rows run compat → shape-guard → effective-scan ──
  const inspection = realInspection();
  const targets: Array<ResolvedTarget | null> = new Array(files.length).fill(null);
  const preflightFailures: Array<{ path: string; error: string }> = [];
  // Group the CONTRIBUTORS of every row (including noop / scaffold-skip rows) by resolved destination. Grouping
  // must span ALL rows, not just non-skip ones: a whole-file writer whose content already matches disk currently
  // diffs to `noop`, and if that row were invisible to the guard, two whole-file writers to one destination
  // could escape detection and oscillate on later applies. A skip row is still a contributor if it resolves.
  const contributorsByDestination = new Map<string, Contributor[]>();
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const skip = isSkip(rows[i]!.action);
    const absPath = posix.join(projectRoot, file.destination);

    // A non-provisionable harness or an unresolvable destination makes the row INVALID, and validity is a
    // property of the BLUEPRINT, not of current disk (FOLD 4 class-fix, gate round 3): reject it for EVERY row —
    // including a noop / scaffold-skip whose bytes happen to match — so the same blueprint that would fail on a
    // fresh clone also fails here, rather than passing as a disk-dependent "successful no-op". (Compat + the
    // actual write below stay non-skip-only — those ARE about the live write target.)
    if (!isProvisionHarness(file.harness)) {
      preflightFailures.push({ path: absPath, error: `role '${file.role}' targets non-provisionable harness '${file.harness}'` });
      continue;
    }
    const target = resolveTarget(projectRoot, file.harness, file.destination);
    if (!target) {
      preflightFailures.push({ path: absPath, error: `destination '${file.destination}' does not resolve to a known ${file.harness} surface` });
      continue;
    }
    const contributors = contributorsByDestination.get(target.destination) ?? [];
    contributors.push({ transform: file.transform, patch: file.transform === "config-merge" ? file.patch : undefined });
    contributorsByDestination.set(target.destination, contributors);

    // ── Blueprint-validity checks (brief FOLD 1 + FOLD 4): run for EVERY resolving row, INCLUDING noop /
    //    scaffold-skip rows, BEFORE the skip-continue. Validity is a property of the BLUEPRINT, not of ambient
    //    disk: a whole-file copy to a merge surface, or a secret-bearing source, that currently diffs to `noop`
    //    only because disk already matches it must fail exactly as it would on a fresh clone — otherwise the
    //    same blueprint validates or refuses depending on the machine it runs on. Shape guard BEFORE secret scan
    //    (a whole-file copy of a config source onto a merge surface is refused by shape, never reaching decode). ──

    // (i) Transform-vs-surface-shape clobber guard (FOLD 3): a whole-file transform (copy/compose/scaffold)
    //     overwrites the ENTIRE file, so aiming one at a `shape:"merge"` surface (`.cursor/mcp.json`, `.mcp.json`,
    //     the `.codex/config.toml` MCP tables) would clobber the user's own foreign content in that shared config.
    //     Only `config-merge` may write a merge surface. Content-free: names the surface label + offending transform.
    if (file.transform !== "config-merge" && target.surface.shape === "merge") {
      preflightFailures.push({
        path: target.destination,
        error: `whole-file transform '${file.transform}' cannot target merge surface '${target.surface.label}' — only config-merge may write a shared merge surface`,
      });
      continue;
    }

    // (ii) Secret-egress scan (issue #43, brief FOLD 1) of the bytes apply would WRITE. apply is egress defense
    //      on what it CONTRIBUTES — it scans the patch/content of THIS row, NEVER the existing disk content or the
    //      merge result (foreign config legitimately holds the user's OWN secrets; scanning those would
    //      false-positive on real configs). A keyword-only secret in a config-merge SOURCE (no distinctive value
    //      pattern) is the U6/U7 verb front-gate's job, NOT a re-run of the loader gate here. Fail CLOSED on a hit.
    //      Every `JSON.stringify` below is total for every REACHABLE input: JSON never yields a BigInt, smol-toml
    //      REJECTS a non-losslessly-representable integer at parse time (a big-int toml fails closed as unparseable
    //      here or as malformed-source in render), and no registry surface is yaml — so no `BigInt` can reach it.
    if (file.transform === "config-merge") {
      // Decoded scan of the patch WE contribute — render already parsed it into `file.patch`.
      if (containsSecret(JSON.stringify(file.patch))) {
        preflightFailures.push({ path: target.destination, error: secretMessage(file.role, target.destination) });
        continue;
      }
    } else if (file.content !== null) {
      // A whole-file write (copy/compose/scaffold) with materialized content. RAW-scan the exact bytes we would
      // write: this closes the TEXT-format gap — a secret in a CLAUDE.md / AGENTS.md / `.md` role file is now
      // scanned, not just config formats. (A scaffold-skip row carries `content === null` — nothing is written,
      // so there is nothing to scan; it falls through untouched.)
      if (containsSecret(file.content)) {
        preflightFailures.push({ path: target.destination, error: secretMessage(file.role, target.destination) });
        continue;
      }
      // For a parser-consumed format (json/toml/yaml) ALSO scan the DECODED/effective form: a secret hidden
      // behind an encoding escape (JSON `\uXXXX`) slips past the raw scan above but not a scan of what the parser
      // materializes. Unparseable ⇒ fail CLOSED — bytes we cannot decode are bytes we cannot certify secret-free.
      const format = target.surface.format;
      if (format !== "text") {
        const parsed = parseConfigValue(format, file.content);
        if (!parsed.ok) {
          preflightFailures.push({ path: target.destination, error: `unparseable ${format} config source at '${target.destination}'` });
          continue;
        }
        if (containsSecret(JSON.stringify(parsed.value))) {
          preflightFailures.push({ path: target.destination, error: secretMessage(file.role, target.destination) });
          continue;
        }
      }
    }

    if (skip) continue; // validity passed; compat + `targets[i]` + the write are for NON-SKIP rows only

    // (iii) Compatibility is about the LIVE write target (not blueprint validity), so it runs for non-skip rows
    //       only: absence is compatible for every create surface; a merge surface must be a readable, parseable
    //       object. A skip row's live state was already the basis for its noop/scaffold-skip diff.
    const compat = checkTargetCompatibility(target, inspection);
    if (!compat.compatible) {
      preflightFailures.push({ path: target.destination, error: compat.message });
      continue;
    }

    targets[i] = target; // fully validated — the write pass may use it
  }
  // Duplicate-destination guards (brief pt 3 corollary + FOLD 2) over the FULL contributor set per destination.
  for (const [destination, contributors] of contributorsByDestination) {
    if (contributors.length < 2) continue;
    // (B) 2+ rows compose safely ONLY when every writer is `config-merge` (the shared `.cursor/mcp.json`
    // multi-role registration). A whole-file copy/compose/scaffold sharing that destination is last-writer-wins
    // and could silently drop a role's content — refuse it loudly, before any write.
    if (!contributors.every((c) => c.transform === "config-merge")) {
      preflightFailures.push({
        path: destination,
        error: `${contributors.length} non-mergeable writers target '${destination}' — an ambiguous, last-writer-wins blueprint (only all-config-merge rows may share a destination)`,
      });
      continue;
    }
    // (C) all config-merge, but two patches disagree on a shared leaf ⇒ order-dependent last-writer-wins ON that
    // leaf, which oscillates across applies. Disjoint patches (two different mcp server keys) never conflict and
    // compose safely; any conflicting pair refuses the whole blueprint. Content-free — names only the destination.
    if (anyPatchesConflict(contributors.map((c) => c.patch!))) {
      preflightFailures.push({
        path: destination,
        error: `conflicting config-merge patches target '${destination}' — two rows disagree on a shared config leaf`,
      });
    }
  }
  if (preflightFailures.length > 0) {
    return { batchId, applied: [], noops: [], failed: preflightFailures, rolledBack: false };
  }

  // ── Write pass — nothing has been written until here; every target is proven compatible ──
  const opts: MergeOptions = { dataDir, batchId, projectRoot };
  const applied: AppliedWrite[] = [];
  const noops: string[] = [];
  // Built incrementally so a rollback can never touch an applied-but-unjournaled write (it has no undoId).
  const rollback: Array<{ undoId: string; targetPath: string }> = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const action = rows[i]!.action;
    if (isSkip(action)) {
      noops.push(posix.join(projectRoot, file.destination));
      continue;
    }
    const target = targets[i]!; // preflight proved every write target resolves
    const path = target.destination;

    try {
      mkdirSync(dirname(path), { recursive: true }); // the engine writes into, but never creates, the parent dir
      const res = writeOne(engine, file, path, opts);
      if (res.noop) {
        // The engine's own byte/semantic compare found nothing to change (e.g. a second same-patch row into an
        // already-created file) — record it as a noop, not an applied write.
        noops.push(path);
        continue;
      }
      applied.push({ targetPath: path, action, created: res.created, undoId: res.undoId });
      if (res.undoId) rollback.push({ undoId: res.undoId, targetPath: path });
    } catch (err) {
      if (err instanceof AppliedButUnjournaledError) {
        // The write LANDED but its journal entry didn't record — un-undoable. Warn, annotate it, CONTINUE.
        // `created` is derived from the error's OWN contract (backupPath===null means the write created the target).
        //
        // DEFERRED recovery gap (gate round 3, issue #50/U6): if a LATER row in this same batch legally writes the
        // SAME path (only config-merge can — whole-file same-dest is refused) and journals successfully, that later
        // write's byte-exact backup captures THIS unjournaled mutation's result, not the pre-batch bytes. A fresh
        // process then reverses only the later entry and reports it `reversed`, unaware the pre-batch state was never
        // fully restored. Reachable only via the rare post-rename journal-failure window PLUS a same-path config-merge
        // later in the batch. The durable fix (poison the path after an unjournaled write; refuse later same-path
        // writes in the batch) rides with U6's write-path hardening; today the un-undoable write is at least surfaced
        // via `applied[].unjournaled`.
        console.error(`[agent-os] provision apply: '${path}' applied but journaling failed (recover from backup if reverting):`, err);
        applied.push({
          targetPath: path,
          action,
          created: err.backupPath === null,
          undoId: null,
          unjournaled: { backupPath: err.backupPath, error: errorText(err) },
        });
        continue;
      }
      // Genuine failure: the mutation (or the mkdir before it) never landed. Roll this batch's earlier writes
      // back LIFO and abort. `applied` becomes the un-undoable SURVIVORS only (`undoId === null`) — the reversed
      // journaled writes are dropped, but any applied-but-unjournaled write stays, honestly, because it is still
      // on disk. `rollbackFailures` names any target whose reversal itself failed (still on disk, not honest to
      // drop) so `rolledBack: true` never overclaims.
      const rollbackFailures = rollbackLifo(rollback, dataDir);
      const outcome: ApplyOutcome = {
        batchId,
        applied: applied.filter((w) => w.undoId === null),
        noops,
        failed: [{ path, error: errorText(err) }],
        rolledBack: true,
      };
      if (rollbackFailures.length > 0) outcome.rollbackFailures = rollbackFailures;
      return outcome;
    }
  }

  return { batchId, applied, noops, failed: [], rolledBack: false };
}

/** One row that resolves to a shared destination. `patch` is present ONLY for a `config-merge` contributor,
 *  so the leaf-conflict guard can compare what each merge row would contribute without re-reading the render. */
type Contributor = { transform: RenderedFile["transform"]; patch?: Record<string, unknown> };

/** The content-free preflight message for an effective-form secret hit (brief FOLD 1). Names the role + the
 *  destination path only — NEVER the secret bytes or any other file content (threat model: no secret escapes). */
function secretMessage(role: string, destination: string): string {
  return `role '${role}' → '${destination}': effective/decoded form contains a secret`;
}

/** True when any pair among these `config-merge` patches disagrees on a shared leaf. O(n²) pairwise, but a
 *  destination's contributor count is tiny (one row per role), so the simple form is correct and cheap. */
function anyPatchesConflict(patches: ReadonlyArray<Record<string, unknown>>): boolean {
  for (let a = 0; a < patches.length; a++) {
    for (let b = a + 1; b < patches.length; b++) {
      if (patchesConflict(patches[a]!, patches[b]!)) return true;
    }
  }
  return false;
}

/** Pure structural conflict test for two `config-merge` patches (brief FOLD 2C). Recurse both plain objects; for
 *  a key present in BOTH, if both values are plain objects recurse, else conflict iff the two values are not
 *  deep-equal. Disjoint keys (two different mcp server keys) never overlap on a leaf, so they compose safely —
 *  that is the legal multi-role registration into one shared config. Mirrors the engine's deep-merge leaf
 *  semantics, so the guard refuses exactly the patches a real apply would resolve last-writer-wins. */
function patchesConflict(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const key of Object.keys(a)) {
    if (!Object.hasOwn(b, key)) continue;
    const av = a[key];
    const bv = b[key];
    if (isPlainRecord(av) && isPlainRecord(bv)) {
      if (patchesConflict(av, bv)) return true;
    } else if (!isDeepStrictEqual(av, bv)) {
      return true;
    }
  }
  return false;
}

/** Dispatch one rendered file to the engine by transform (brief WRITE-PASS RULES). */
function writeOne(engine: ProvisionEngine, file: RenderedFile, path: string, opts: MergeOptions): MergeResult {
  switch (file.transform) {
    case "config-merge":
      return engine.mergeConfig(path, file.patch, opts);
    case "copy":
    case "compose":
      return engine.writeTextFile(path, file.content, opts);
    case "scaffold":
      // A "create"-action scaffold always carries materialized content; a present scaffold diffs to
      // scaffold-skip and never reaches the write pass. The guard keeps apply total if that ever changes.
      if (file.content === null) throw new Error(`provision apply: scaffold '${path}' reached the write pass with no content`);
      return engine.writeTextFile(path, file.content, opts);
  }
}

/** Reverse a batch's successful writes newest-first. Best-effort: a rollback failure is logged AND returned (so
 *  the caller can surface it in `rollbackFailures` — a still-applied file `rolledBack: true` would otherwise
 *  hide), never masking the original error the caller is already reporting. Returns the `{path,error}` of every
 *  target whose `undo()` threw; an empty array when every reversal succeeded. */
function rollbackLifo(
  rollback: ReadonlyArray<{ undoId: string; targetPath: string }>,
  dataDir: string,
): Array<{ path: string; error: string }> {
  const failures: Array<{ path: string; error: string }> = [];
  for (let i = rollback.length - 1; i >= 0; i--) {
    const { undoId, targetPath } = rollback[i]!;
    try {
      undo(undoId, dataDir);
    } catch (err) {
      console.error(`[agent-os] provision apply: rollback of '${targetPath}' failed (leaving it as-is):`, err);
      failures.push({ path: targetPath, error: errorText(err) });
    }
  }
  return failures;
}

/** A type predicate (not a plain boolean) so the write loop's `if (isSkip(action)) continue;` narrows the
 *  fall-through `action` to exactly `AppliedWrite["action"]` — the compiler checks the narrowing instead of
 *  the two call sites asserting it with `as`. */
const isSkip = (action: PlanAction): action is Extract<PlanAction, "noop" | "scaffold-skip"> =>
  action === "noop" || action === "scaffold-skip";

function isProvisionHarness(harness: Runtime): harness is ProvisionHarness {
  return harness === "claude-code" || harness === "codex" || harness === "cursor";
}

/** Real byte-aware destination reader for the diff (KTD8 needs raw bytes for the text identity check). Mirrors
 *  the engine's lstat discipline: a symlink or non-regular node reads as `blocked`, never silently absent; an
 *  oversized file (past the shared 16 MiB read bound) is refused the same way, before it is read into memory. */
function readDestination(absPath: string): DestinationRead {
  try {
    const stat = lstatSync(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: "blocked" };
    if (stat.size > MAX_APPLY_READ_BYTES) return { ok: false, reason: "blocked" };
    const bytes = readFileSync(absPath);
    return { ok: true, content: bytes.toString("utf8"), bytes };
  } catch (err) {
    return { ok: false, reason: isNotFound(err) ? "absent" : "blocked" };
  }
}

/** Real path inspection for `checkTargetCompatibility`. `stat` maps the live node to a `TargetPathState`;
 *  a non-ENOENT lookup failure throws so the compatibility check classifies it as inspection-failed. */
function realInspection(): TargetInspection {
  return {
    stat: (path): TargetPathState => {
      let stat;
      try {
        stat = lstatSync(path);
      } catch (err) {
        if (isNotFound(err)) return "absent";
        throw err;
      }
      if (stat.isSymbolicLink()) return "symlink";
      if (stat.isFile()) return "file";
      if (stat.isDirectory()) return "directory";
      return "other";
    },
    read: (path): string | null => {
      try {
        // Match the shared read-boundary discipline: refuse a non-regular or oversized file before reading it.
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > MAX_APPLY_READ_BYTES) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

function preflightFailure(batchId: string, projectRoot: string, destination: string, error: string): ApplyOutcome {
  return {
    batchId,
    applied: [],
    noops: [],
    failed: [{ path: posix.join(projectRoot, destination), error }],
    rolledBack: false,
  };
}

function renderErrorText(error: RenderError): string {
  const where = `role '${error.role}' (${error.harness}) → '${error.destination}'`;
  return "source" in error ? `render ${error.problem} for ${where} from '${error.source}'` : `render ${error.problem} for ${where}`;
}

function diffErrorText(error: DiffError): string {
  return `diff ${error.problem} for role '${error.role}' (${error.harness}) → '${error.destination}'`;
}
