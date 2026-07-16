/**
 * Claude Code inventory scanner (U9) — the ONE module that knows where Claude Code keeps its stack, the
 * Observe-half peer of `capture/claude-code.ts`. Isolating this knowledge here is the point: when the CC
 * config layout shifts (an undocumented contract — Risks & Dependencies), only this file changes.
 *
 * Three USER-SCOPE surfaces, three documented facts a naive scan gets wrong:
 *
 *  1. MCP servers live in `~/.claude.json .mcpServers`, NOT `settings.json` (the trap the plan calls out).
 *     `settings.json` is scanned ONLY for plugins.
 *  2. Skills are `~/.claude/skills/<name>/SKILL.md` dirs (many symlinked) — see `listSkills`.
 *  3. Plugins are `~/.claude/settings.json .enabledPlugins`, a `{ "<name>@<marketplace>": boolean }` map.
 *     The boolean MATTERS — a disabled plugin is `false` and is NOT in the inventory (R8: reflect the
 *     actual enabled stack, not everything ever installed).
 *
 * Scope is USER/GLOBAL — "what is installed in this harness", the cross-runtime parity question (F4). The
 * per-project axis (`~/.claude.json .projects[dir].mcpServers`, `<dir>/.mcp.json`, project skills, and the
 * project `settings.json` plugin precedence decision #25 relies on) is DEFERRED to U11 — where the view that
 * consumes per-project detail is designed and user-vs-project precedence gets specified (issue #35). Shipping
 * the complete, verified global unit beats a global scan plus a half-built per-project drill-down.
 *
 * NOTE (issue #36): `~/.claude/skills` is a plausible but not-fully-verified CC skill root — it overlaps a
 * shared `~/.agents/skills` convention. Skill-root discovery is being verified holistically across harnesses.
 */
import { join } from "node:path";
import type { InventoryItem } from "../contract/index";
import { asRecord, listSkills, makeItem, namedItems, readJson, type ScanContext } from "./internal";

/** Observe Claude Code's user-scope skills, MCP servers, and enabled plugins from its on-disk configs. Pure
 *  + sync: reads the live files and returns the current inventory (R8) — no persistence, so a rescan always
 *  reflects disk (AE5). Fail-soft per surface; a wholesale throw is caught by `scanAll` (R9). */
export function scanClaudeCode(ctx: ScanContext): InventoryItem[] {
  // MCP servers — from `~/.claude.json` (the trap: NOT settings.json).
  const claudeJson = readJson(join(ctx.homeDir, ".claude.json"));

  // Plugins — `settings.json .enabledPlugins`, a `{ "<name>@<mkt>": boolean }` map; enabled (=== true) only
  // (a disabled plugin is `false`), and an empty key contributes nothing (contract `name.min(1)`).
  const enabledPlugins = asRecord(readJson(join(ctx.homeDir, ".claude", "settings.json"))?.enabledPlugins);
  const plugins = Object.keys(enabledPlugins)
    .filter((name) => name.length > 0 && enabledPlugins[name] === true)
    .map((name) => makeItem(ctx, "claude-code", "plugin", name));

  // Array-literal spread is iteration-based (no function-call arg limit), so it stays safe on a pathological
  // huge surface — unlike `items.push(...arr)`, which RangeErrors on an untrusted-length array.
  return [
    ...namedItems(ctx, "claude-code", "mcp", claudeJson?.mcpServers),
    ...listSkills(ctx, "claude-code", join(ctx.homeDir, ".claude", "skills")), // `~/.claude/skills/<name>/SKILL.md`
    ...plugins,
  ];
}
