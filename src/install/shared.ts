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
 * rewrites ONLY events that currently exist (so it never fabricates an empty `SessionEnd: []` on a file that
 * lacked one), and returns an EMPTY patch — a `mergeConfig` no-op — when no named event is present, so calling
 * it on an already-clean or hookless config writes nothing. Reading `current` from the engine's own parse (not
 * a pre-read) is what makes this array RMW single-read.
 */
export function hooksPatchWithoutOurs(
  current: unknown,
  events: ReadonlyArray<readonly [event: string, ourCommand: string]>,
): Record<string, unknown> {
  const config = current as Record<string, unknown> | undefined;
  const hooks = (config?.hooks as Record<string, unknown> | undefined) ?? {};
  const patch: Record<string, unknown[]> = {};
  for (const [event, ourCommand] of events) {
    if (Array.isArray(hooks[event])) patch[event] = existingEntriesWithoutOurs(config, event, ourCommand);
  }
  return Object.keys(patch).length > 0 ? { hooks: patch } : {};
}

/**
 * The uninstall-side hook stripper both installers share: when `targetPath` exists, run a `mergeConfig`
 * callback that rewrites each named event's array to itself MINUS our own entry (`hooksPatchWithoutOurs`),
 * against the engine's OWN read. Returns `[targetPath]` when that actually changed the file, or `[]` on a
 * no-op / an absent file (never CREATE a hooks file by uninstalling — hence the `existsSync` guard). A
 * diverged/corrupt/symlinked target is logged with `errLabel` and swallowed, returning `[]`, so ONE target's
 * failure never aborts an uninstall's other removals (per-target isolation). `events` is the same
 * `[event, ourCommand]` list `hooksPatchWithoutOurs` takes.
 */
export function removeHooksIfPresent(
  targetPath: string,
  events: ReadonlyArray<readonly [event: string, ourCommand: string]>,
  opts: { dataDir: string; errLabel: string },
): string[] {
  if (!existsSync(targetPath)) return [];
  try {
    const res = mergeConfig(targetPath, (current: unknown) => hooksPatchWithoutOurs(current, events), { dataDir: opts.dataDir });
    return res.noop ? [] : [targetPath];
  } catch (err) {
    console.error(`[agent-os] uninstall: ${opts.errLabel} '${targetPath}':`, err);
    return [];
  }
}
