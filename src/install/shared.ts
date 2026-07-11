/**
 * Shared installer helpers (U8) — identical logic both `claude-code.ts` and `codex.ts` need for their
 * read-modify-write config upserts (backup-first, atomic, journaled undo lives in `../configwrite/index`;
 * this module only holds the small pre-merge shaping both installers do the same way).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppliedButUnjournaledError, mergeConfig, MERGE_NOOP, removeConfigKeys } from "../configwrite/index";

/** This repo's root: `src/install/shared.ts` → `../..`. Safe for any `src/install/` caller — `import.meta.dir`
 *  is THIS file's own directory, and `claude-code.ts` / `codex.ts` live in that same directory. */
export function defaultRepoRoot(): string {
  return join(import.meta.dir, "..", "..");
}

/** The shell command CC runs for a hook / headers-helper: `bun run "<abs script>"` (quoted so a repo path
 *  containing spaces still executes as one argument). */
export function bunCommand(repoRoot: string, script: string): string {
  return `bun run "${join(repoRoot, "hooks", script)}"`;
}

/** Parse a JSON config file; `undefined` when absent. Throws on corrupt JSON — never merge into a config we
 *  can't parse (mirrors the engine's own fail-closed parse). */
export function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`install: existing '${path}' is not valid JSON — fix or remove it before installing`);
  }
}

/** The existing `hooks.<event>` entries with our own nested hook removed from each entry, so the caller can
 *  append a fresh entry and re-install stays idempotent. Filters at the NESTED HOOK level, not the whole
 *  entry: a user hook co-located in the same entry as ours (same matcher, two nested hooks in one entry) is
 *  no longer collateral damage — only our own nested hook is stripped out, and the entry itself is dropped
 *  only when nothing of the user's remains. Non-array / missing → [].
 */
export function existingEntriesWithoutOurs(config: unknown, event: string, ourCommand: string): unknown[] {
  const cfg = config as Record<string, unknown> | undefined;
  const hooks = (cfg?.hooks as Record<string, unknown> | undefined) ?? {};
  const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  const out: unknown[] = [];
  for (const entry of arr) {
    const nested = entry && typeof entry === "object" ? (entry as { hooks?: unknown }).hooks : undefined;
    if (!Array.isArray(nested)) {
      out.push(entry); // no nested hooks array → keep verbatim (never our shape)
      continue;
    }
    const kept = nested.filter((h) => (h as { command?: unknown })?.command !== ourCommand);
    if (kept.length === nested.length) out.push(entry); // none of ours → keep the entry unchanged
    else if (kept.length > 0) out.push({ ...(entry as object), hooks: kept }); // co-located → preserve user's hooks + matcher
    // else: the entry held ONLY our hook(s) → drop it entirely (so re-install re-adds a single fresh entry)
  }
  return out;
}

/**
 * A `mergeConfig` callback-PATCH (not the raw hooks — the `{hooks:{...}}` envelope `mergeConfig` expects) that
 * rewrites each named hook event's array to itself MINUS our own entry — the targeted-removal read-modify-write
 * both uninstallers use to strip their hook without a whole-file undo. Built to touch only what's ours: it
 * rewrites ONLY events our removal ACTUALLY changed. An event whose array is unchanged (none of our hooks were
 * in it) is left out, as is an absent event (so it never fabricates an empty `SessionEnd: []` on a file that
 * lacked one). When NO event changed it returns an EMPTY patch `{}`, which `removeHooksIfPresent` maps to the
 * engine's `MERGE_NOOP` abstain sentinel — so the engine skips serialize/backup/write entirely instead of
 * reserializing (and thus REFORMATTING) a foreign file whose byte layout differs from our serializer. Reading
 * `current` from the engine's own parse (not a pre-read) is what makes this array RMW single-read.
 */
export function hooksPatchWithoutOurs(
  current: unknown,
  events: ReadonlyArray<readonly [event: string, ourCommand: string]>,
): Record<string, unknown> {
  const config = current as Record<string, unknown> | undefined;
  const hooks = (config?.hooks as Record<string, unknown> | undefined) ?? {};
  const patch: Record<string, unknown[]> = {};
  for (const [event, ourCommand] of events) {
    const currentEntries = hooks[event];
    if (!Array.isArray(currentEntries)) continue; // absent event → never touched (no fabricated empty array)
    const filtered = existingEntriesWithoutOurs(config, event, ourCommand);
    // Include the event ONLY when the strip actually removed one of our hooks. `existingEntriesWithoutOurs`
    // never adds or reorders and keeps the SAME reference for every entry it leaves untouched (a new object
    // only for a co-located entry it strips ours out of, nothing for a dropped one), so a length-or-reference
    // mismatch is an exact "did any of ours go" test — it catches the co-located strip a bare length check
    // (same entry count, one fewer nested hook) would miss. Arrays match ⇒ nothing of ours was present ⇒ omit
    // the event, so an already-clean config yields the empty patch that makes the uninstall a true no-op.
    if (filtered.length !== currentEntries.length || filtered.some((entry, i) => entry !== currentEntries[i])) {
      patch[event] = filtered;
    }
  }
  return Object.keys(patch).length > 0 ? { hooks: patch } : {};
}

/**
 * The result of an uninstall pass: `removed` names the config paths whose bytes actually changed, `failed`
 * names each target that could NOT be cleaned (a diverged/corrupt/symlinked file), and `warnings` names each
 * target whose change LANDED but whose undo-journal write failed (`AppliedButUnjournaledError`). Keeping the
 * three separate lets a caller distinguish a true no-op (all empty — nothing of ours was there) from a cleanup
 * that partially failed (`failed` non-empty) from one that succeeded-but-unrecorded (`warnings` non-empty). A
 * `warnings` entry is ALSO in `removed` (the mutation is applied — recover from its backup only if reverting);
 * it is deliberately NOT in `failed`, since the entry really is gone. Each defaults to `[]`.
 */
export interface UninstallOutcome {
  removed: string[];
  failed: Array<{ path: string; error: string }>;
  warnings: Array<{ path: string; error: string }>;
}

/** Message text of a caught unknown error, for an `UninstallOutcome.failed[].error` field. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The uninstall-side hook stripper both installers share: ONE `mergeConfig` call whose CALLBACK rewrites each
 * named event's array to itself MINUS our own entry (`hooksPatchWithoutOurs`), against the engine's OWN read —
 * and ABSTAINS (returns `MERGE_NOOP`) when that read shows none of our hooks, so a foreign-formatted clean file
 * is never reserialized to our layout. Reports an `UninstallOutcome`: `removed` names `targetPath` when the
 * strip actually changed the file; `warnings` names it when the strip LANDED but journaling failed (still
 * removed, recoverable from backup); `failed` names it with the error when a diverged/corrupt/symlinked target
 * can't be stripped. Each failure/warning is logged with `errLabel`, and ONE target's failure never aborts an
 * uninstall's other removals (per-target isolation).
 *
 * ALL presence semantics come from the engine's ONE read — no separate pre-check to race against. An
 * ENOENT-absent target → the callback sees `undefined` → empty patch → `MERGE_NOOP` → a clean no-op that
 * CREATES nothing; a dangling hook symlink — which `existsSync` would misreport as absent, silently leaving its
 * live registration behind — makes the engine's `statTarget` throw its symlink refusal, caught here as a
 * `failed` entry; a corrupt/unreadable target throws in the engine's parse, likewise `failed`. Dropping the old
 * precheck closes its race window: our hook vanishing between a pre-read and the engine's read used to leave the
 * callback returning `{}` and the engine reserializing (reformatting) a now-clean foreign file. `events` is the
 * same `[event, ourCommand]` list `hooksPatchWithoutOurs` takes.
 */
export function removeHooksIfPresent(
  targetPath: string,
  events: ReadonlyArray<readonly [event: string, ourCommand: string]>,
  opts: { dataDir: string; errLabel: string },
): UninstallOutcome {
  try {
    // Single engine read: the callback strips our entries and, when NONE of ours is present, ABSTAINS via
    // MERGE_NOOP — the engine then skips serialize/backup/write/journal AND (on an absent target) create, so a
    // clean or missing file is left byte-for-byte untouched with no separate presence pre-read to race against.
    const res = mergeConfig(
      targetPath,
      (current: unknown) => {
        const patch = hooksPatchWithoutOurs(current, events);
        return Object.keys(patch).length === 0 ? MERGE_NOOP : patch;
      },
      { dataDir: opts.dataDir },
    );
    return { removed: res.noop ? [] : [targetPath], failed: [], warnings: [] };
  } catch (err) {
    if (err instanceof AppliedButUnjournaledError) {
      // The strip LANDED (our hooks are gone) but its undo entry didn't record — count it removed, and warn so
      // the applied-but-unrecorded write is visible (recover from the backup only if reverting), never failed.
      console.error(`[agent-os] uninstall: ${opts.errLabel} '${targetPath}' — applied but journaling failed (recover from backup if reverting):`, err);
      return { removed: [targetPath], failed: [], warnings: [{ path: targetPath, error: errorText(err) }] };
    }
    console.error(`[agent-os] uninstall: ${opts.errLabel} '${targetPath}':`, err);
    return { removed: [], failed: [{ path: targetPath, error: errorText(err) }], warnings: [] };
  }
}

/**
 * The uninstall-side KEY stripper both installers share (the object-keyed twin of `removeHooksIfPresent`): ONE
 * `removeConfigKeys` call that deletes the named dotted `keyPaths` from `targetPath`, on the engine's own
 * backup-then-atomic-write-then-journal discipline. Reports an `UninstallOutcome`: `removed` names `targetPath`
 * when the delete actually changed the file; `warnings` names it when the delete LANDED but journaling failed
 * (still removed, recoverable from backup); `failed` names it with the error when a diverged/corrupt/symlinked
 * target can't be stripped. Each failure/warning is logged, and ONE target's failure never aborts an uninstall's
 * other removals (per-target isolation).
 *
 * ALL presence semantics come from the engine's ONE read: an absent target — or one that resolves NONE of
 * `keyPaths` — is a true no-op that CREATES nothing and never reformats a foreign-formatted file; a symlink or
 * other non-regular target makes the engine's `statTarget` throw, caught here as a `failed` entry. `errLabel` is
 * the entity being removed (e.g. the server name), woven into the log text as `'<errLabel>'`. `failedSuffix` is
 * appended to the FAILED-branch log line only — a caller-specific tail (Codex adds "… neutralized by the
 * codex.token revocation below; remove it manually"); it defaults to empty for callers with nothing to add.
 */
export function removeKeysIfPresent(
  targetPath: string,
  keyPaths: string[],
  opts: { dataDir: string; errLabel: string; failedSuffix?: string },
): UninstallOutcome {
  try {
    const res = removeConfigKeys(targetPath, keyPaths, { dataDir: opts.dataDir });
    return { removed: res.noop ? [] : [targetPath], failed: [], warnings: [] };
  } catch (err) {
    if (err instanceof AppliedButUnjournaledError) {
      // The delete LANDED (the keys are gone) but its undo entry didn't record — count it removed, and warn so
      // the applied-but-unrecorded write is visible (recover from the backup only if reverting), never failed.
      console.error(`[agent-os] uninstall: removed '${opts.errLabel}' from '${targetPath}' but journaling failed (recover from backup if reverting):`, err);
      return { removed: [targetPath], failed: [], warnings: [{ path: targetPath, error: errorText(err) }] };
    }
    console.error(`[agent-os] uninstall: could not remove '${opts.errLabel}' from '${targetPath}'${opts.failedSuffix ?? ""}:`, err);
    return { removed: [], failed: [{ path: targetPath, error: errorText(err) }], warnings: [] };
  }
}
