/**
 * Shared installer helpers (U8) — identical logic both `claude-code.ts` and `codex.ts` need for their
 * read-modify-write config upserts (backup-first, atomic, journaled undo lives in `../configwrite/index`;
 * this module only holds the small pre-merge shaping both installers do the same way).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeConfig } from "../configwrite/index";

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
 * lacked one). When NO event changed it returns an EMPTY patch `{}` — the signal `removeHooksIfPresent` uses to
 * skip the write outright: the engine's no-op short-circuit is BYTE-level, so an empty-patch `mergeConfig` would
 * still re-serialize and thus REFORMAT a foreign file whose byte layout differs from our serializer; only
 * skipping the call keeps an already-clean uninstall from touching it. Reading `current` from the engine's own
 * parse (not a pre-read) is what makes this array RMW single-read.
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
 * names each target that could NOT be cleaned (a diverged/corrupt/symlinked file), with its error message.
 * Keeping the two separate lets a caller distinguish a true no-op (both empty — nothing of ours was there)
 * from a cleanup that partially failed (`failed` non-empty) — the same `[]` used to collapse both.
 */
export interface UninstallOutcome {
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

/** Message text of a caught unknown error, for an `UninstallOutcome.failed[].error` field. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The uninstall-side hook stripper both installers share: when `targetPath` exists AND holds one of our hooks,
 * run a `mergeConfig` callback that rewrites each named event's array to itself MINUS our own entry
 * (`hooksPatchWithoutOurs`), against the engine's OWN read. Reports an `UninstallOutcome`: `removed` names
 * `targetPath` when the strip actually changed the file (else empty — a no-op / an absent file / a file with
 * none of our hooks; never CREATE a hooks file by uninstalling, hence the `existsSync` guard); `failed` names
 * it with the error message when a diverged/corrupt/symlinked target can't be stripped. The failure is logged
 * with `errLabel` AND surfaced in `failed` (never swallowed into the same empty result as a true no-op), yet
 * ONE target's failure still never aborts an uninstall's other removals (per-target isolation).
 *
 * The presence pre-check is what keeps an already-clean uninstall from touching a foreign file's BYTES: an
 * empty-patch `mergeConfig` would still re-serialize (the engine's no-op short-circuit is byte-level) and thus
 * REFORMAT a hooks file whose layout differs from our serializer, so when nothing of ours is on disk we skip
 * the write entirely. That read only DECIDES whether to write — race-safe, since a foreign process never ADDS
 * our command — while the strip itself still builds its array from the engine's own fresh read. `events` is the
 * same `[event, ourCommand]` list `hooksPatchWithoutOurs` takes.
 */
export function removeHooksIfPresent(
  targetPath: string,
  events: ReadonlyArray<readonly [event: string, ourCommand: string]>,
  opts: { dataDir: string; errLabel: string },
): UninstallOutcome {
  if (!existsSync(targetPath)) return { removed: [], failed: [] };
  try {
    // Skip the write ENTIRELY when none of our hooks are on disk (empty patch) — see the header on why an
    // empty-patch mergeConfig would still reformat a foreign file. `readJson` throwing on a corrupt/unreadable
    // target lands in the catch below, exactly as the mergeConfig parse used to.
    if (Object.keys(hooksPatchWithoutOurs(readJson(targetPath), events)).length === 0) {
      return { removed: [], failed: [] };
    }
    const res = mergeConfig(targetPath, (current: unknown) => hooksPatchWithoutOurs(current, events), { dataDir: opts.dataDir });
    return { removed: res.noop ? [] : [targetPath], failed: [] };
  } catch (err) {
    console.error(`[agent-os] uninstall: ${opts.errLabel} '${targetPath}':`, err);
    return { removed: [], failed: [{ path: targetPath, error: errorText(err) }] };
  }
}
