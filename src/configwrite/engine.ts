/**
 * Config-write discipline engine (U14) — the ONE file-mutation utility every installer (U6/U8) and
 * parity action (U10) is built on. R11 / KTD6: no config write anywhere in Agent OS bypasses this,
 * because Jarod's *live* `~/.claude`, `~/.claude.json`, and `~/.codex` configs are the write targets.
 *
 * The discipline, in order:
 *   parse (fail CLOSED on a corrupt config) → deep-merge (don't clobber unrelated keys) → serialize
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
 * The one entry point callers use; see the module header for the full safety contract.
 */
export function mergeConfig(targetPath: string, patch: unknown, opts: MergeOptions = {}): MergeResult {
  // Fail closed: a patch is a partial config, hence always a plain object (JSON object / TOML table /
  // YAML map). A null/undefined/array/scalar patch would hit deepMerge's non-object fallback and REPLACE
  // the whole config wholesale — a silent clobber that violates merge-don't-clobber — so reject it here,
  // before any file work, rather than let it through.
  if (!isPlainObject(patch)) {
    throw new Error("configwrite: patch must be a plain object (a partial config to merge)");
  }
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
  const originalMode = existed ? statSync(targetPath).mode & 0o777 : null;
  const currentText = existed ? readFileSync(targetPath, "utf8") : undefined;

  // Parse BEFORE anything is written. A corrupt existing config aborts here, leaving it untouched.
  const base = existed ? parseConfig(format, currentText!, targetPath) : undefined;
  const nextText = serializeConfig(format, deepMerge(base, patch));

  // No-op short-circuit: if the merged bytes already match disk, do nothing — no backup, no write, no
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
