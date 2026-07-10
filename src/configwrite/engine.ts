/**
 * Config-write discipline engine (U14) — the ONE file-mutation utility every installer (U6/U8) and
 * parity action (U10) is built on. R11 / KTD6: no config write anywhere in Agent OS bypasses this,
 * because Jarod's *live* `~/.claude`, `~/.claude.json`, and `~/.codex` configs are the write targets.
 *
 * Two public primitives share one discipline: `mergeConfig` (add/replace keys — merge-don't-clobber) and
 * `removeConfigKeys` (delete keys/array-elements — targeted removal, the correct reversal for a config a
 * foreign process also owns and rewrites). Both run through the shared `publish` core, in order:
 *   parse (fail CLOSED on a corrupt config) → transform (merge or remove) → serialize
 *   → short-circuit if the result already matches disk → byte-exact backup → atomic temp-write+rename
 *   → journal the undo entry.
 *
 * Two invariants make this safe to point at a live setup:
 *   1. The ORIGINAL FILE IS UNTOUCHED until the final atomic rename. A throw at any earlier step —
 *      corrupt parse, serialize failure, a read-only directory — leaves it exactly as it was.
 *   2. Reversibility comes from the byte-exact backup, INDEPENDENT of merge fidelity. A semantic merge
 *      may not preserve comments/formatting in a hand-edited TOML file, but `undo` restores the raw
 *      bytes, so nothing a merge drops is ever unrecoverable.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
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
   *  between rename and a post-hoc chmod. The undo journal still records the ORIGINAL mode, so uninstall
   *  restores the file's pre-install mode. Omitted ⇒ preserve the existing file's mode — the default, correct
   *  for the non-secret configs every other caller writes (CC's settings.json / ~/.claude.json). */
  targetMode?: number;
  /** Dotted paths (same vocabulary as `removeConfigKeys`) whose subtrees are REPLACED wholesale instead of
   *  deep-merged: each is stripped from the base before the patch re-adds it, so a stale key on a pre-existing
   *  entry — an embedded-token `headers`/`http_headers` a caller no longer writes — cannot survive the merge.
   *  Still idempotent: a re-merge that reproduces the same bytes no-ops like any other write. */
  replaceSubtrees?: string[];
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
 */
export function mergeConfig(targetPath: string, patch: unknown, opts: MergeOptions = {}): MergeResult {
  // Fail closed on a STATIC non-object patch before any file work (the CALLBACK form is resolved against the
  // parsed base inside `publish`, and its RETURN is validated there the same way). A patch is a partial config,
  // hence always a plain object (JSON object / TOML table / YAML map). A null/undefined/array/scalar patch would
  // hit deepMerge's non-object fallback and REPLACE the whole config wholesale — a silent clobber that violates
  // merge-don't-clobber — so reject it here rather than let it through.
  const isCallback = typeof patch === "function";
  if (!isCallback && !isPlainObject(patch)) {
    throw new Error("configwrite: patch must be a plain object (a partial config to merge)");
  }
  return publish(targetPath, opts, (base) => {
    const resolved = isCallback ? (patch as (current: unknown) => unknown)(base) : patch;
    if (!isPlainObject(resolved)) {
      throw new Error("configwrite: patch must be a plain object (a partial config to merge)");
    }
    // replaceSubtrees: strip each owned path from the base so the merge re-adds it FRESH — a wholesale replace
    // that drops any stale key on a pre-existing entry the caller no longer writes (see MergeOptions).
    const stripped = opts.replaceSubtrees?.length ? removeKeys(base, opts.replaceSubtrees) : base;
    return deepMerge(stripped, resolved);
  });
}

/**
 * Remove each dotted key path from the config at `targetPath` — the reverse of `mergeConfig`, on the SAME
 * discipline (byte-exact 0600 backup → atomic temp-write+rename → journaled undo). This is TARGETED removal: it
 * deletes only the named keys/array-elements and preserves everything else, so it is the correct reversal for a
 * config a FOREIGN process also owns and rewrites continuously (`~/.claude.json`, `~/.codex/config.toml`) —
 * where a whole-file `undo` restore would throw on the (near-always) diverged file, or clobber the owner's live
 * state. A path that doesn't resolve is skipped, so a double-remove is an idempotent no-op; removing from a
 * target that doesn't exist is a no-op that never creates a file. Reversible like any write — `undo` re-adds
 * exactly what was removed.
 */
export function removeConfigKeys(targetPath: string, keyPaths: string[], opts: MergeOptions = {}): MergeResult {
  return publish(targetPath, opts, (base) => removeKeys(base, keyPaths), { createIfAbsent: false });
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
 */
function publish(
  targetPath: string,
  opts: MergeOptions,
  transform: (base: unknown) => unknown,
  { createIfAbsent = true }: { createIfAbsent?: boolean } = {},
): MergeResult {
  const format = detectFormat(targetPath, opts.format);
  const dataDir = resolveDataDir(opts.dataDir);

  // Fail closed on a symlink target: renameSync would replace the link itself with a regular file,
  // silently breaking a dotfile-managed config and defeating byte-exact reversibility (the backup holds
  // only dereferenced bytes, so undo can't restore the link). Symlink write-through is a deferred
  // enhancement — no dotfile manager is in use today.
  if (isSymlink(targetPath)) {
    throw new Error(`configwrite: refusing to write '${targetPath}' — it is a symlink; symlinked configs are not supported yet`);
  }

  const existed = existsSync(targetPath);
  // A removal (createIfAbsent:false) on a missing target is a no-op: nothing to remove, and we must never
  // create a file by removing keys from it.
  if (!existed && !createIfAbsent) {
    return { targetPath, noop: true, created: false, undoId: null, backupPath: null };
  }
  const originalMode = existed ? statSync(targetPath).mode & 0o777 : null;
  const currentText = existed ? readFileSync(targetPath, "utf8") : undefined;

  // Parse BEFORE anything is written. A corrupt existing config aborts here, leaving it untouched.
  const base = existed ? parseConfig(format, currentText!, targetPath) : undefined;
  const nextText = serializeConfig(format, transform(base));

  // No-op short-circuit: if the computed bytes already match disk, do nothing — no backup, no write, no
  // journal entry. This is what makes the engine idempotent in PRACTICE: an installer re-run (every
  // session, say) neither rewrites the file nor accumulates backups/journal noise.
  if (existed && nextText === currentText) {
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
    // a looser inherited mode and tightened afterwards (which leaves a readable window). Undo still restores
    // `originalMode` (recorded above), so uninstall returns the file to its pre-install mode.
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
    // The write applied but journaling failed. KEEP the backup (the only recovery path) and surface that
    // the mutation landed, so the caller recovers from the backup instead of retrying a completed write.
    throw new Error(
      `configwrite: write to '${targetPath}' APPLIED but journaling failed — recover from backup '${backupPath ?? "(none; a created file — delete it to revert)"}': ${errMessage(err)}`,
    );
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
 * Delete each dotted `keyPath` from `base` in place, returning it. Objects delete the key; arrays splice a
 * numeric index (so `hooks.SessionStart.0` removes the first entry). A path that doesn't resolve — a missing
 * segment or an out-of-range index — is skipped, which is exactly what makes a double-remove an idempotent
 * no-op. Prototype-pollution-safe: a `__proto__`/`constructor`/`prototype` segment is refused, so it never
 * walks onto the prototype (shares `deepMerge`'s FORBIDDEN_KEYS). `base` is the engine's OWN freshly-parsed
 * value (never a caller's object), so mutating it in place is safe and avoids a deep clone.
 */
function removeKeys(base: unknown, keyPaths: string[]): unknown {
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
      const idx = Number(last);
      if (Number.isInteger(idx) && idx >= 0 && idx < container.length) container.splice(idx, 1);
    } else if (isPlainObject(container)) {
      delete container[last];
    }
  }
  return base;
}

/** One navigation step for `removeKeys`: index into an array by numeric segment, or read an object key.
 *  Returns `undefined` — a dead end the caller stops descending from — for any non-container or absent segment. */
function stepInto(container: unknown, segment: string): unknown {
  if (Array.isArray(container)) {
    const idx = Number(segment);
    return Number.isInteger(idx) && idx >= 0 && idx < container.length ? container[idx] : undefined;
  }
  if (isPlainObject(container)) return container[segment];
  return undefined;
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

/** True iff `path` is itself a symlink (even a broken one). Uses lstat so it never follows the link. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // path doesn't exist / inaccessible — not a symlink we need to guard against
  }
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
