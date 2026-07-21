/**
 * Config-write discipline engine (U14) — the ONE file-mutation utility every installer (U6/U8) and
 * parity action (U10) is built on. R11 / KTD6: no config write anywhere in Agent OS bypasses this,
 * because Jarod's *live* `~/.claude`, `~/.claude.json`, and `~/.codex` configs are the write targets.
 *
 * Three public primitives share one discipline: `mergeConfig` (add/replace keys — merge-don't-clobber),
 * `removeConfigKeys` (delete keys/array-elements — targeted removal, the correct reversal for a config a
 * foreign process also owns and rewrites), and `writeTextFile` (publish a whole file verbatim — the opaque
 * `text` format, for markdown role files and extension-less configs, KTD1). All run through the shared
 * `publish` core, in order:
 *   parse (fail CLOSED on a corrupt config) → transform (merge or remove) → serialize
 *   → short-circuit if the result already matches disk → byte-exact backup → atomic temp-write+rename
 *   → journal the undo entry.
 * The `text` format is the one exception to two of those steps: it treats the file as one opaque string — its
 * parse and serialize are IDENTITY (no fail-closed parsing to trip, no trailing-newline canonicalization) — so
 * a copy of valid-UTF-8 content round-trips byte-for-byte; the backup / atomic-rename / journal / undo half is
 * shared unchanged. Byte-identity of the idempotence check is enforced separately, by the byte-exact no-op
 * comparison below (a string compare would be lossy on invalid UTF-8). It has no merge/removal semantics, so
 * `mergeConfig`/`removeConfigKeys` refuse it (see `publish`).
 *
 * Two invariants make this safe to point at a live setup:
 *   1. The ORIGINAL FILE IS UNTOUCHED until the final atomic rename. A throw at any earlier step —
 *      corrupt parse, serialize failure, a read-only directory — leaves it exactly as it was.
 *   2. Reversibility comes from the byte-exact backup, INDEPENDENT of merge fidelity. A semantic merge
 *      may not preserve comments/formatting in a hand-edited TOML file, but `undo` restores the raw
 *      bytes, so nothing a merge drops is ever unrecoverable.
 *
 * SCOPE — single-process discipline. These invariants hold WITHIN one process. The engine takes no
 * cross-process lock and does no optimistic-concurrency check, so the read-modify-write is atomic against
 * OUR OWN writes, never against a concurrent external rewriter: a foreign write that lands between the
 * engine's read and its atomic rename is silently SUPERSEDED by the rename. The byte-exact backup + undo
 * journal make such a lost foreign write RECOVERABLE, not PREVENTABLE. Tracked as GitHub issue #28
 * (promotion trigger: the first observed lost foreign write, or U10 parity provisioning putting real
 * concurrent pressure on these live configs).
 */
import { copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { backupsDir, hashContent, resolveDataDir, type ConfigFormat } from "./internal";
import { recordUndo, type UndoEntry } from "./undo";

export interface MergeOptions {
  /** Override format detection (by default inferred from the target's extension). */
  format?: ConfigFormat;
  /** Root for backups + the undo journal. Defaults to the OS data dir; tests inject a temp dir. */
  dataDir?: string;
  /** Force the PUBLISHED file's mode to this — chmod the temp to it BEFORE the atomic rename — instead of
   *  preserving an existing target's mode. Use for a file this write embeds a SECRET into (the Codex
   *  installer's config.toml), so the secret is never on disk at a looser mode, even for the transient window
   *  between rename and a post-hoc chmod. The undo journal records the ORIGINAL mode, but the two reversal paths
   *  treat it differently: a whole-file `undo` re-applies that recorded mode directly, restoring the pre-install
   *  mode; a TARGETED uninstall (`removeConfigKeys`) preserves the file's CURRENT mode and deliberately NEVER
   *  loosens it — a file tightened to 0600 at install STAYS 0600 after targeted removal. Loosening on uninstall
   *  is unsafe: a secret added to the file while Agent OS held it at 0600 would be exposed by widening the mode
   *  back, so a tightening is never autonomously reversed (full mode-lifecycle restoration is deferred — issue
   *  #33). Omitted ⇒ preserve the existing file's mode — the default, correct for the non-secret configs every
   *  other caller writes (CC's settings.json / ~/.claude.json). */
  targetMode?: number;
  /** Dotted paths (same vocabulary as `removeConfigKeys`) whose subtrees are REPLACED wholesale instead of
   *  deep-merged: each is stripped from the base before the patch re-adds it, so a stale key on a pre-existing
   *  entry — an embedded-token `headers`/`http_headers` a caller no longer writes — cannot survive the merge.
   *  Still idempotent: a re-merge that reproduces the same bytes no-ops like any other write. */
  replaceSubtrees?: string[];
  /** Batch identity for a U10 provision run (KTD2): stamped onto this write's undo entry so a later `undo`
   *  can reverse a whole batch — the journal entries sharing `batchId`. `batchId` is an opaque run id;
   *  `projectRoot` is the run's project root. Both omitted ⇒ an unbatched write (every installer today, and
   *  all pre-U10 journals, which stay readable). The batch-undo consumer lands in U5; here the fields are only
   *  recorded. */
  batchId?: string;
  projectRoot?: string;
}

export interface MergeResult {
  targetPath: string;
  /** true when the merged content already equals what's on disk — nothing was written, backed up, or journaled. */
  noop: boolean;
  /** true when the target did not exist and was created (its undo entry deletes it). */
  created: boolean;
  /** The id to hand to `undo()`, or `null` on a no-op (nothing to reverse). */
  undoId: string | null;
  /** Path to the byte-exact backup, or `null` when the target was created or the call was a no-op. */
  backupPath: string | null;
}

/**
 * Thrown when the atomic rename SUCCEEDED (the mutation is live on disk) but the follow-up journal write did
 * not — the one "applied but not recorded" window in `publish`. It is a distinct type, not a plain Error, so a
 * caller can tell this apart from a genuine failure where the mutation NEVER landed: the change IS applied
 * (recover from `backupPath` if a revert is needed), so treating it as an unapplied error would double-count it
 * as failed. `backupPath` is `null` when the target was CREATED (no backup — delete the file to revert).
 */
export class AppliedButUnjournaledError extends Error {
  readonly targetPath: string;
  readonly backupPath: string | null;
  constructor(targetPath: string, backupPath: string | null, cause: unknown) {
    super(
      `configwrite: write to '${targetPath}' APPLIED but journaling failed — recover from backup '${backupPath ?? "(none; a created file — delete it to revert)"}': ${errMessage(cause)}`,
      { cause },
    );
    this.name = "AppliedButUnjournaledError";
    this.targetPath = targetPath;
    this.backupPath = backupPath;
  }
}

/**
 * Deep-merge `patch` into a config at `targetPath`, backing it up first and publishing atomically.
 * The primary entry point callers use; see the module header for the full safety contract.
 *
 * `patch` is either a partial config OBJECT (deep-merged into the current config) or a CALLBACK
 * `(current) => patch` that receives the engine's OWN parsed read and returns that partial config. The
 * callback form closes an installer's non-atomic double-read: a read-modify-write — e.g. appending one hook to
 * an already-populated array, which deepMerge REPLACES, so the caller must hand over the whole desired array —
 * builds its result from the SAME read the engine merges, instead of from a separate pre-read a concurrent
 * foreign write could land after and be reverted. `current` is `undefined` when the target does not exist yet
 * (mirrors the shared installers' `readJson`).
 *
 * A callback (or a static patch) may ABSTAIN by returning `MERGE_NOOP`: publish then guarantees ZERO
 * filesystem effects — no serialize, no backup, no write, no journal, and (on an absent target) no create.
 * This lets a read-modify-write whose read shows nothing to do (an uninstall stripper finding none of our keys
 * on a foreign-formatted file) skip the write ENTIRELY, so it never reserializes a clean file into our layout —
 * a decision the caller can only make from the engine's OWN read, which the callback receives.
 */
export function mergeConfig(targetPath: string, patch: unknown, opts: MergeOptions = {}): MergeResult {
  // Fail closed on a STATIC non-object patch before any file work (the CALLBACK form is resolved against the
  // parsed base inside `publish`, and its RETURN is validated there the same way). A patch is a partial config,
  // hence always a plain object (JSON object / TOML table / YAML map) — or the MERGE_NOOP abstain sentinel. A
  // null/undefined/array/scalar patch would hit deepMerge's non-object fallback and REPLACE the whole config
  // wholesale — a silent clobber that violates merge-don't-clobber — so reject it here rather than let it through.
  const isCallback = typeof patch === "function";
  if (!isCallback && patch !== MERGE_NOOP && !isPlainObject(patch)) {
    throw new Error("configwrite: patch must be a plain object (a partial config to merge)");
  }
  return publish(
    targetPath,
    opts,
    (base) => {
      const resolved = isCallback ? (patch as (current: unknown) => unknown)(base) : patch;
      // Abstain: a callback (or static patch) returning MERGE_NOOP forces publish's zero-effect short-circuit.
      if (resolved === MERGE_NOOP) return MERGE_NOOP;
      if (!isPlainObject(resolved)) {
        throw new Error("configwrite: patch must be a plain object (a partial config to merge)");
      }
      // replaceSubtrees: strip each owned path from the base so the merge re-adds it FRESH — a wholesale replace
      // that drops any stale key on a pre-existing entry the caller no longer writes (see MergeOptions). The
      // strip's `deleted` flag is irrelevant here — in this deepMerge branch a no-op is the byte-compare in
      // `publish`, never MERGE_NOOP (that abstain path returned earlier, before this replaceSubtrees strip).
      const stripped = opts.replaceSubtrees?.length ? removeKeys(base, opts.replaceSubtrees).value : base;
      return deepMerge(stripped, resolved);
    },
    // Alias guard fires ONLY when replaceSubtrees strips subtrees — THAT branch runs `removeKeys` on `base` in
    // place, so on aliased YAML it carries the same corruption risk as removeConfigKeys. A plain deepMerge builds
    // NEW trees and never mutates `base`, so an aliased document merges fine and stays unguarded.
    { guardsRemoval: !!opts.replaceSubtrees?.length },
  );
}

/**
 * The abstain sentinel a `publish` transform returns to force a TRUE no-op: nothing resolved to change, so
 * publish skips serialize / backup / write / journal — and, on an absent target, does NOT create it (the
 * short-circuit runs before both the serialize and the create paths). Guarantees ZERO filesystem effects.
 *
 * Both public primitives lean on it. `removeConfigKeys` returns it when NO key actually matched — without it,
 * re-serializing the (unchanged) parsed tree would rewrite a foreign-formatted file (4-space JSON, comment-
 * bearing TOML that `smol-toml` drops on reserialize) to our canonical layout for a delete that removed
 * nothing, creating backup/journal noise and a false `removed` report. `mergeConfig`'s CALLBACK form returns
 * it to abstain (an uninstall stripper whose read shows none of our keys left: reformatting a clean foreign
 * file for a no-change merge is the exact damage this prevents) — the one case merge no-ops WITHOUT the
 * post-serialize byte-compare. A unique symbol so it can never collide with a real config value; `MERGE_NOOP`
 * is its public name, the merge callback being the public consumer.
 */
export const MERGE_NOOP: unique symbol = Symbol("configwrite.merge-noop");

/**
 * Remove each dotted key path from the config at `targetPath` — the reverse of `mergeConfig`, on the SAME
 * discipline (byte-exact 0600 backup → atomic temp-write+rename → journaled undo). This is TARGETED removal: it
 * deletes only the named keys/array-elements and preserves everything else, so it is the correct reversal for a
 * config a FOREIGN process also owns and rewrites continuously (`~/.claude.json`, `~/.codex/config.toml`) —
 * where a whole-file `undo` restore would throw on the (near-always) diverged file, or clobber the owner's live
 * state. A path that doesn't resolve is skipped, so a double-remove is an idempotent no-op; removing from a
 * target that doesn't exist is a no-op that never creates a file. Reversible like any write — `undo` re-adds
 * exactly what was removed. `opts` omits `replaceSubtrees` (a merge-only option this removal path never reads;
 * accepting it would silently no-op).
 */
export function removeConfigKeys(
  targetPath: string,
  keyPaths: string[],
  opts: Omit<MergeOptions, "replaceSubtrees"> = {},
): MergeResult {
  return publish(
    targetPath,
    opts,
    (base) => {
      const { value, deleted } = removeKeys(base, keyPaths);
      // Nothing resolved for deletion ⇒ force a true no-op (MERGE_NOOP), so an absent-key removal never
      // re-serializes and thus never reformats a foreign-formatted live config. A real deletion falls through to
      // the normal serialize + byte-compare path (which then writes, since a resolved delete always changes the bytes).
      return deleted ? value : MERGE_NOOP;
    },
    { createIfAbsent: false, guardsRemoval: true },
  );
}

/**
 * Publish a whole-file surface — a markdown role file, an extension-less config — through the SAME discipline
 * as `mergeConfig` (byte-exact backup → atomic temp-write+rename → journaled undo), but the patch is the FULL
 * rendered `content`, not a partial merge. This is the whole-file counterpart U10 provisioning needs for its
 * copy/compose transforms; `mergeConfig` can't serve it because it structurally rejects a non-object (string)
 * patch (KTD1).
 *
 * Forces the opaque `text` format unconditionally — never inferred from the extension, since the real targets
 * (`CLAUDE.md`, `AGENTS.md`, extension-less role files) would make `detectFormat` throw. `content` is written
 * VERBATIM: byte-identical to its source even with zero or multiple trailing newlines (the canonicalization
 * `serializeConfig` applies to structured formats is bypassed for `text`), so a copy stays byte-exact and a
 * re-write of identical bytes is a true no-op (no backup, no journal). Undo restores the exact prior bytes +
 * mode, or deletes the file when this write created it. `opts.format`/`replaceSubtrees` are omitted — the
 * format is always `text` and the merge-only `replaceSubtrees` doesn't apply.
 */
export function writeTextFile(
  targetPath: string,
  content: string,
  opts: Omit<MergeOptions, "format" | "replaceSubtrees"> = {},
): MergeResult {
  return publish(targetPath, { ...opts, format: "text" }, () => content, { allowText: true });
}

/**
 * The shared write discipline behind `mergeConfig` and `removeConfigKeys`: parse the current config (fail
 * CLOSED on corruption), apply `transform` to compute the next value, and — only when the serialized result
 * differs from disk — back up byte-exact, publish atomically, and journal the undo entry. Extracting it keeps
 * the two public primitives on ONE audited implementation of the backup / atomic-rename / journal invariants
 * rather than two copies that could drift.
 *
 * `createIfAbsent` (default true, for merge) writes the transform's result as a NEW file when the target is
 * absent; `false` (for removal) makes an absent target a no-op — there is nothing to remove, and a removal must
 * never CREATE a file.
 *
 * `guardsRemoval` (default false) marks a transform with REMOVAL semantics — one that runs `removeKeys` on the
 * parsed base IN PLACE (always for removeConfigKeys; for mergeConfig only when `replaceSubtrees` strips subtrees).
 * On a YAML target it arms the anchor/alias shared-identity guard below; every other caller leaves it false.
 */
function publish(
  targetPath: string,
  opts: MergeOptions,
  transform: (base: unknown) => unknown,
  {
    createIfAbsent = true,
    guardsRemoval = false,
    allowText = false,
  }: { createIfAbsent?: boolean; guardsRemoval?: boolean; allowText?: boolean } = {},
): MergeResult {
  const format = detectFormat(targetPath, opts.format);
  // The opaque whole-file `text` format has no merge/removal semantics — its patch is the FULL content, not a
  // partial config — so `mergeConfig`/`removeConfigKeys` must never operate on it. `writeTextFile` is the one
  // caller that sets `allowText`; every other entry point reaches here with it false, so an explicit
  // `format: "text"` passed to merge/remove fails loudly here instead of silently misbehaving (KTD1).
  if (format === "text" && !allowText) {
    throw new Error(
      `configwrite: '${targetPath}' resolves to the whole-file 'text' format, which mergeConfig/removeConfigKeys cannot handle — use writeTextFile`,
    );
  }
  // Batch identity (KTD2) is both-or-neither and NON-EMPTY STRINGS. `publish` stamps opts.batchId/projectRoot
  // straight into the UndoEntry, whose read schema (undo.ts) requires non-empty strings — so ANY value that
  // schema would reject (undefined, "", or a truthy NON-STRING like a number/object slipped past the TS types)
  // must be refused HERE, or the write appends a journal row that `listUndo` silently drops, leaving the
  // mutation applied-but-un-undoable (a success return + undoId that resolves to nothing). Fail CLOSED before
  // any file work, matching the engine's parse-fail-closed discipline — the invariant holds at the write
  // boundary even though the only batch producer (U5) will always pass a well-formed UUID + project root.
  const isBatchKey = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  const hasBatch = opts.batchId !== undefined || opts.projectRoot !== undefined;
  if (hasBatch && (!isBatchKey(opts.batchId) || !isBatchKey(opts.projectRoot))) {
    throw new Error(
      "configwrite: a batched write requires both batchId and projectRoot to be non-empty strings (both-or-neither)",
    );
  }
  const dataDir = resolveDataDir(opts.dataDir);

  // ONE presence decision for both merge and removal (see `statTarget`): a regular file is "present", a genuine
  // ENOENT is "absent", and everything indeterminate — a symlink, or a lookup that failed for any other reason —
  // THROWS rather than silently reading as absence (which would fake a clean no-op on removal, or route an
  // unreadable existing config to the create path on merge).
  const existed = statTarget(targetPath) === "present";
  // A removal (createIfAbsent:false) on a missing target is a no-op: nothing to remove, and we must never
  // create a file by removing keys from it.
  if (!existed && !createIfAbsent) {
    return { targetPath, noop: true, created: false, undoId: null, backupPath: null };
  }
  const originalMode = existed ? statSync(targetPath).mode & 0o777 : null;
  const currentText = existed ? readFileSync(targetPath, "utf8") : undefined;

  // Parse BEFORE anything is written. A corrupt existing config aborts here, leaving it untouched.
  const base = existed ? parseConfig(format, currentText!, targetPath) : undefined;

  // Anchor/alias shared-identity guard — fail CLOSED before the transform runs, so nothing is ever mutated. A
  // YAML `&anchor`/`*alias` makes the parser hand back the SAME JS object under two paths (`a: &x {…}` + `b: *x`
  // → a and b are ONE object), and a removal transform mutates the parsed tree IN PLACE (delete a key / splice an
  // array element), so an in-place delete under `a` would silently corrupt the untargeted `b` on serialize. Only
  // YAML can produce these shared identities — JSON.parse and smol-toml build a fresh object per node and
  // structurally never alias — so this walk runs for YAML removals ONLY (zero cost on JSON/TOML and plain merges).
  // Copy-on-write removal that would make this safe is deferred (issue #32); until then we refuse over corrupt.
  if (guardsRemoval && format === "yaml" && hasSharedIdentity(base)) {
    throw new Error(
      `configwrite: refusing targeted removal on '${targetPath}' — the YAML document uses anchors/aliases (shared nodes), which in-place removal would corrupt; tracked as issue #32`,
    );
  }

  const next = transform(base);
  // A transform may force a TRUE no-op by returning MERGE_NOOP — nothing resolved to change — so we must NOT
  // serialize (and, on an absent target, must NOT create it: this short-circuit runs BEFORE the serialize and
  // create paths, so an abstaining callback on a missing file writes nothing). The removal path uses this:
  // re-serializing an unchanged tree would rewrite a foreign-formatted file to our canonical layout for a
  // delete/merge that changed nothing. (A plain object patch instead no-ops via the byte-compare below.)
  if (next === MERGE_NOOP) {
    return { targetPath, noop: true, created: false, undoId: null, backupPath: null };
  }
  const nextText = serializeConfig(format, next);

  // No-op short-circuit: if the computed bytes already match disk, do nothing — no backup, no write, no
  // journal entry. This is what makes the engine idempotent in PRACTICE: an installer re-run (every
  // session, say) neither rewrites the file nor accumulates backups/journal noise.
  //
  // For the opaque `text` format the compare must be BYTE-exact, not string-exact: `currentText` was decoded
  // as utf8, which is LOSSY for invalid byte sequences (they collapse to U+FFFD), so a string compare could
  // falsely no-op on a target whose raw bytes differ but decode-equal — skipping the write and leaving
  // divergent bytes on disk, which breaks text's byte-identity contract. Compare rendered bytes to the raw
  // file bytes for `text`; structured formats keep the (canonicalized) string compare, unchanged.
  const isNoop = existed && (format === "text" ? Buffer.from(nextText).equals(readFileSync(targetPath)) : nextText === currentText);
  if (isNoop) {
    return { targetPath, noop: true, created: false, undoId: null, backupPath: null };
  }

  const backupDir = existed ? backupsDir(dataDir) : null;
  const backupPath = backupDir ? join(backupDir, backupName(targetPath)) : null;
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  const undoId = randomUUID();
  const entry: UndoEntry = {
    id: undoId,
    targetPath,
    backupPath,
    created: !existed,
    mode: originalMode,
    format,
    postHash: hashContent(nextText),
    ts: Date.now(),
    // Batch identity (KTD2) — recorded only when a caller (a U10 provision run) supplies it; `undefined`
    // otherwise, so JSON.stringify omits the keys and unbatched installer journals stay unchanged.
    batchId: opts.batchId,
    projectRoot: opts.projectRoot,
  };

  // `committed` splits the two failure regimes. Before the rename the target is untouched — roll our
  // residue back and fail cleanly. After it the mutation is LIVE, so a later failure (a journal write
  // that throws) must PRESERVE the backup and tell the caller the write landed, never report a done
  // mutation as a clean failure that leaves it applied-but-unrecoverable.
  let committed = false;
  try {
    if (existed) {
      // Byte-exact backup FIRST: a raw file copy, so undo is perfect regardless of merge fidelity.
      mkdirSync(backupDir!, { recursive: true, mode: 0o700 });
      copyFileSync(targetPath, backupPath!);
      chmodSync(backupPath!, 0o600);
    }
    // Atomic publish: write to a sibling temp (starts owner-only), force the intended mode, then
    // rename over the target. rename(2) is atomic on POSIX, so a reader never sees a half-written file,
    // and the original survives untouched if any step above threw. `targetMode` (when set) wins over the
    // preserved original mode, so a secret-bearing file is PUBLISHED owner-only — never renamed into place at
    // a looser inherited mode and tightened afterwards (which leaves a readable window). `originalMode` is
    // recorded above so a whole-file `undo` can re-apply it directly; a TARGETED uninstall, by contrast,
    // preserves the current mode and deliberately never loosens it (see `MergeOptions.targetMode`) — full
    // mode-lifecycle restoration is deferred (issue #33).
    writeFileSync(tmpPath, nextText, { mode: 0o600 });
    chmodSync(tmpPath, opts.targetMode ?? originalMode ?? 0o600);
    renameSync(tmpPath, targetPath);
    committed = true;
    // Journal LAST, but still inside the try: the mutation is now live, so its undo record must exist.
    recordUndo(entry, dataDir);
  } catch (err) {
    safeRm(tmpPath); // a no-op once the rename has consumed the temp
    if (!committed) {
      // Nothing was published — the target is byte-for-byte its original self; drop our backup too.
      if (backupPath) safeRm(backupPath);
      throw err;
    }
    // The write applied but journaling failed. KEEP the backup (the only recovery path) and surface — via a
    // DISTINCT typed error — that the mutation landed, so the caller counts it applied (recover from the backup)
    // rather than misreading a completed write as an unapplied failure.
    throw new AppliedButUnjournaledError(targetPath, backupPath, err);
  }

  return { targetPath, noop: false, created: !existed, undoId, backupPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────────────────────

/** Keys that must never be assigned through a merge — assigning `__proto__` via `[]` mutates the prototype. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Deep-merge `patch` into `base`, preserving unrelated keys (R11, "merge-don't-clobber").
 *
 * ARRAYS AND SCALARS ARE REPLACED (patch wins) — NOT appended or index-merged. This is a load-bearing
 * contract, deliberately narrow: a caller that must PRESERVE existing array elements — e.g. U6 adding
 * one hook to Claude Code's already-populated `settings.json` `hooks` array — MUST read-modify-write
 * the whole array itself and pass the combined result as the patch. A naive `{hooks:{SessionStart:[mine]}}`
 * patch WOULD DROP Jarod's existing entries. Array-append is intentionally out of U14's scope (the
 * byte-exact backup makes any replace reversible); it earns a strategy option when a real consumer needs it.
 *
 * Object-recurse + array/scalar-replace is idempotent: re-merging the same patch yields identical bytes,
 * which is exactly what the engine's no-op short-circuit relies on.
 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const key of Object.keys(patch)) {
      if (FORBIDDEN_KEYS.has(key)) continue; // prototype-pollution guard — this is the shared safety utility
      out[key] = Object.hasOwn(base, key) ? deepMerge(base[key], patch[key]) : patch[key];
    }
    return out;
  }
  return patch;
}

/**
 * A plain data object we recurse into — an object literal or a null-prototype object. Deliberately
 * REJECTS arrays, `Date` (and thus smol-toml's `TomlDate extends Date`), and class instances, so those
 * are treated as opaque scalars the patch replaces wholesale.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Delete each dotted `keyPath` from `base` in place, returning `{ value, deleted }`: `value` is the (mutated)
 * `base`, and `deleted` reports whether ANY path actually resolved to a real target. The removal caller maps a
 * `deleted:false` into a TRUE no-op (skipping serialize/write), so an absent-key removal never reformats a
 * foreign-formatted live config by re-serializing an unchanged tree. Objects delete the key; arrays splice a
 * numeric index (so `hooks.SessionStart.0` removes the first entry). A path resolves only to an EXISTING
 * target — an own key (by `hasOwn`, so a null/false/"" value still counts as present) or an in-range index;
 * anything else — a missing segment, an absent final key, or an out-of-range index — is skipped, which is
 * exactly what makes a double-remove an idempotent no-op. Prototype-pollution-safe: a `__proto__`/`constructor`/`prototype` segment is refused, so it never
 * walks onto the prototype (shares `deepMerge`'s FORBIDDEN_KEYS). `base` is the engine's OWN freshly-parsed
 * value (never a caller's object), so mutating it in place is safe and avoids a deep clone.
 *
 * TWO PASSES, resolve-then-mutate, so every path's target is fixed against the tree AS IT WAS WHEN THE CALL
 * BEGAN — no deletion perturbs a target resolved earlier. Pass 1 walks each path to its (container,
 * final-segment) target WITHOUT mutating; pass 2 applies the deletes, splicing each array's indices
 * HIGHEST-FIRST so an earlier removal never renumbers a later target. This is what makes multiple numeric
 * paths into the SAME array (`list.0` + `list.2`) remove exactly the ORIGINAL elements named, rather than
 * splicing sequentially and shifting the ones behind each removal. Resolving up front also fixes the subtler
 * case of a path that walks THROUGH a sibling another path removes: pass 1 captured its container reference,
 * so pass 2's mutation still lands (splicing an array never invalidates a reference already taken to one of
 * its elements). In short: the index in a path refers to the array as it was when the call began.
 */
function removeKeys(base: unknown, keyPaths: string[]): { value: unknown; deleted: boolean } {
  const objectDeletes: Array<{ container: Record<string, unknown>; key: string }> = [];
  // Array removals grouped by container identity; the per-container Set dedupes two paths naming the same
  // element (so one call removes it once) and lets pass 2 splice that container's indices highest-first.
  const arraySplices = new Map<unknown[], Set<number>>();

  // ── Pass 1: resolve every path to its EXISTING target (an own key or in-range index), mutating nothing ──
  for (const keyPath of keyPaths) {
    const segments = keyPath.split(".");
    // Walk to the container holding the FINAL segment; stop at the first dead end (absent/forbidden segment).
    let container: unknown = base;
    for (let i = 0; i < segments.length - 1 && container !== undefined; i++) {
      container = FORBIDDEN_KEYS.has(segments[i]!) ? undefined : stepInto(container, segments[i]!);
    }
    const last = segments[segments.length - 1]!;
    if (container === undefined || FORBIDDEN_KEYS.has(last)) continue;
    if (Array.isArray(container)) {
      const idx = arrayIndex(container, last);
      if (idx !== undefined) {
        let indices = arraySplices.get(container);
        if (!indices) arraySplices.set(container, (indices = new Set()));
        indices.add(idx);
      }
    } else if (isPlainObject(container) && Object.hasOwn(container, last)) {
      // Require the OWN key to EXIST (mirroring the array branch's in-range `idx` check above) — by `hasOwn`,
      // not truthiness, so a null/false/"" value still counts as present. A parent-exists/leaf-absent path
      // resolves to NOTHING: recording it would flip `deleted` true and re-serialize, reformatting a
      // foreign-formatted live config for a delete that removes nothing.
      objectDeletes.push({ container, key: last });
    }
  }

  // ── Pass 2: apply. Object deletes in any order; each array's indices spliced highest-first. ──
  for (const { container, key } of objectDeletes) delete container[key];
  for (const [arr, indices] of arraySplices) {
    for (const idx of [...indices].sort((a, b) => b - a)) arr.splice(idx, 1);
  }
  // `deleted` iff pass 1 recorded at least one target (an EXISTING own object key, or a resolved in-range array
  // index — each `arraySplices` entry is a non-empty Set by construction). The removal caller turns `false` into
  // a true no-op so an absent-key remove never re-serializes (and thus never reformats) a foreign-formatted file.
  return { value: base, deleted: objectDeletes.length > 0 || arraySplices.size > 0 };
}

/** One navigation step for `removeKeys`: index into an array by numeric segment, or read an object key.
 *  Returns `undefined` — a dead end the caller stops descending from — for any non-container or absent segment. */
function stepInto(container: unknown, segment: string): unknown {
  if (Array.isArray(container)) {
    const idx = arrayIndex(container, segment);
    return idx === undefined ? undefined : container[idx];
  }
  if (isPlainObject(container)) return container[segment];
  return undefined;
}

/** A canonical base-10 non-negative integer segment: `0`, or a nonzero-leading digit run. Gates `arrayIndex`
 *  so the forms `Number()` would silently coerce to a misleading index never resolve — ""→0, "0x1"→1, "1e1"→10,
 *  "01"→1, " 1"→1 — nor the negatives/decimals it also accepts; only a genuine canonical index gets through. */
const CANONICAL_ARRAY_INDEX = /^(0|[1-9]\d*)$/;

/** A dotted-path `segment` parsed as a valid, in-range index into `container` — the shared bounds-check
 *  behind both `stepInto`'s read and `removeKeys`'s splice. `undefined` for anything else (non-canonical per
 *  `CANONICAL_ARRAY_INDEX`, or out of range), matching `stepInto`'s own dead-end sentinel. The regex guarantees
 *  a non-negative integer, so only the upper bound remains to check. */
function arrayIndex(container: unknown[], segment: string): number | undefined {
  if (!CANONICAL_ARRAY_INDEX.test(segment)) return undefined;
  const idx = Number(segment);
  return idx < container.length ? idx : undefined;
}

/**
 * Does `root` hold a container reachable from 2+ parent slots — a YAML anchor/alias resolved to a SHARED JS
 * identity (`a: &x {…}` + `b: *x` → a and b are ONE object), or an alias cycle? `publish` calls this to arm the
 * fail-closed removal guard on YAML: `removeKeys` mutates the parsed tree IN PLACE, so a delete/splice under one
 * path to a shared node silently corrupts every OTHER path to it.
 *
 * Walks exactly the containers `removeKeys` can descend into and mutate — plain objects and arrays (a `Date` or
 * scalar leaf is opaque, never mutated, so a shared one is harmless and skipped, mirroring `stepInto`) — with ONE
 * `seen` set: the first time a container is popped it is recorded and its children pushed; encountering it AGAIN
 * means a second parent slot reached it (shared identity) OR an alias cycle led back to it — either way, return
 * true. Never descending into an already-seen node is also what makes the walk TERMINATE on a cyclic document
 * (`x.self: *x`) instead of looping forever — seeing the repeat IS the signal, so it is reported, not followed.
 */
function hasSharedIdentity(root: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!Array.isArray(node) && !isPlainObject(node)) continue; // scalar / Date / class instance — an opaque leaf
    if (seen.has(node)) return true; // reached via a second parent slot (shared alias) or closed an alias cycle
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    } else {
      for (const key of Object.keys(node)) stack.push(node[key]);
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format: detect, parse, serialize
// ─────────────────────────────────────────────────────────────────────────────

const EXT_FORMAT: Record<string, ConfigFormat> = {
  ".json": "json",
  ".toml": "toml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

function detectFormat(targetPath: string, override?: ConfigFormat): ConfigFormat {
  if (override) return override;
  const ext = extname(targetPath).toLowerCase();
  const fmt = EXT_FORMAT[ext];
  if (!fmt) {
    throw new Error(`configwrite: cannot infer format from '${targetPath}' (extension '${ext || "none"}'); pass opts.format`);
  }
  return fmt;
}

function parseConfig(format: ConfigFormat, text: string, path: string): unknown {
  try {
    switch (format) {
      case "json":
        return JSON.parse(text);
      case "toml":
        return parseToml(text);
      case "yaml":
        return parseYaml(text);
      case "text":
        return text; // opaque whole-file: no structured parse — the decoded content passes through as-is (identity, never throws)
      default:
        return assertNever(format);
    }
  } catch (err) {
    // Fail CLOSED: refuse to merge into a config we can't parse — aborting here leaves the original
    // untouched. NEVER interpolate the raw parser message: `yaml` and `smol-toml` render a code-frame of
    // the surrounding SOURCE, which would reproduce a secret adjacent to the syntax error into this Error
    // (and thence any log/telemetry sink). The structured line/col locates it; the byte-exact original
    // stays on disk for the owner to inspect directly.
    throw new Error(`configwrite: failed to parse existing ${format} config at '${path}'${parseLocation(err)}; file is not valid ${format}`);
  }
}

function serializeConfig(format: ConfigFormat, value: unknown): string {
  // Whole-file `text` (KTD1): the value IS the full rendered content string — return it VERBATIM, before the
  // structured-format switch and its trailing-newline canonicalization below. Load-bearing: verbatim output
  // preserves the caller's string exactly (even with zero or multiple trailing newlines), so a copy of valid-
  // UTF-8 content stays byte-identical and a re-apply is a true no-op via publish's byte-compare. writeTextFile
  // is the only producer, and its transform
  // returns a string, so `value` is always a string here.
  if (format === "text") return value as string;
  let text: string;
  switch (format) {
    case "json":
      text = JSON.stringify(value, null, 2);
      break;
    case "toml":
      text = stringifyToml(value);
      break;
    case "yaml":
      text = stringifyYaml(value);
      break;
    default:
      return assertNever(format);
  }
  // Canonicalize to exactly one trailing newline so re-serialized output is byte-stable across formats
  // (JSON.stringify emits none; yaml/toml emit one) — the no-op short-circuit compares raw bytes.
  return text.replace(/\n+$/, "") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable + collision-proof backup name: `<basename>.<compact-iso>.<short-uuid>.bak`. */
function backupName(targetPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${basename(targetPath)}.${stamp}.${randomUUID().slice(0, 8)}.bak`;
}

/**
 * The engine's ONE presence decision, shared by merge and removal. Three outcomes: a REGULAR FILE is
 * "present"; a genuinely missing entry (lstat ENOENT — including a path made unreachable by a missing parent,
 * which is indistinguishable by errno and equivalent for our purposes) is "absent"; everything else THROWS —
 * a symlink (dangling or resolved: renameSync would replace the LINK itself with a regular file, silently
 * breaking a dotfile-managed config, and the byte-exact backup holds only dereferenced bytes so undo could not
 * restore the link — symlink write-through is a deferred enhancement); any OTHER non-regular node — a directory,
 * FIFO, socket, or device — since reading "present" would hand it to publish's readFileSync/copyFileSync (a FIFO
 * with no writer BLOCKS the process forever; a directory throws EISDIR), so a config target that isn't a plain
 * file is refused up front; or an indeterminate lookup (EACCES, ENOTDIR, EIO, …). Indeterminate must NEVER read
 * as absence: on a removal it would fake a clean no-op while our registration stays live; on a merge it is worse
 * — an existsSync-false verdict routed an UNREADABLE existing config to the create path, where temp+rename would
 * clobber a file we never read. Uses lstat, so it never follows the link (and never opens a FIFO to test it).
 */
function statTarget(path: string): "present" | "absent" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return "absent";
    throw err; // EACCES / ENOTDIR / EIO / … — indeterminate, never silently "absent"
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`configwrite: refusing to write '${path}' — it is a symlink; symlinked configs are not supported yet`);
  }
  // Anything else that isn't a plain file (directory, FIFO, socket, device) must NOT read as "present": publish
  // would then readFileSync/copyFileSync it — a FIFO with no writer BLOCKS forever, a directory throws EISDIR — so
  // refuse it here at the lstat presence check, before any open. Symlinks are handled just above; this catches
  // every other non-regular node.
  if (!stat.isFile()) {
    throw new Error(`configwrite: refusing to use '${path}' — not a regular file (directory/FIFO/socket/device); configs must be regular files`);
  }
  return "present";
}

/** Best-effort removal; used only on the failure path where the caller is already throwing. */
function safeRm(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // swallow — we're cleaning up residue while unwinding a prior error
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A content-free "(at line X, column Y)" from a parser error's STRUCTURED position fields — never its
 * message, which for `yaml`/`smol-toml` embeds a source frame that can carry a secret. Falls back to no
 * location (still content-free) when the error exposes no numeric position.
 */
function parseLocation(err: unknown): string {
  if (err && typeof err === "object") {
    // smol-toml TomlError exposes numeric line/column.
    const { line, column } = err as { line?: unknown; column?: unknown };
    if (typeof line === "number") {
      return typeof column === "number" ? ` (at line ${line}, column ${column})` : ` (at line ${line})`;
    }
    // yaml YAMLParseError exposes linePos: [{ line, col }, ...].
    const linePos = (err as { linePos?: unknown }).linePos;
    if (Array.isArray(linePos) && linePos[0] && typeof linePos[0] === "object") {
      const { line: l, col } = linePos[0] as { line?: unknown; col?: unknown };
      if (typeof l === "number") {
        return typeof col === "number" ? ` (at line ${l}, column ${col})` : ` (at line ${l})`;
      }
    }
  }
  return "";
}

/** Compile-time exhaustiveness guard: adding a `ConfigFormat` without a case fails to type-check. */
function assertNever(x: never): never {
  throw new Error(`configwrite: unhandled config format '${String(x)}'`);
}
