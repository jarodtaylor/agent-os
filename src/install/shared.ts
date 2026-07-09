/**
 * Shared installer helpers (U8) — identical logic both `claude-code.ts` and `codex.ts` need for their
 * read-modify-write config upserts (backup-first, atomic, journaled undo lives in `../configwrite/index`;
 * this module only holds the small pre-merge shaping both installers do the same way).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** True iff a settings hook ENTRY already references our exact command — used to strip a prior install of
 *  ours before re-adding it, so re-install replaces (never duplicates). Exact-match avoids false positives
 *  against an unrelated user hook; a moved repo simply leaves its now-dead entry (fails open, harmless). */
export function referencesCommand(entry: unknown, command: string): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some((h) => (h as { command?: unknown })?.command === command);
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

/** The existing `hooks.<event>` entries with OUR entry (by `command`) stripped, so the caller can append a
 *  fresh one and re-install stays idempotent. Non-array / missing → []. */
export function existingEntriesWithoutOurs(
  config: Record<string, unknown> | undefined,
  event: string,
  ourCommand: string,
): unknown[] {
  const hooks = (config?.hooks as Record<string, unknown> | undefined) ?? {};
  const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  return arr.filter((entry) => !referencesCommand(entry, ourCommand));
}
