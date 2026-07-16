/**
 * Claude Code inventory scanner (U9) — the ONE module that knows where Claude Code keeps its stack, the
 * Observe-half peer of `capture/claude-code.ts`. Isolating this knowledge here is the point: when the CC
 * config layout shifts (an undocumented contract — Risks & Dependencies), only this file changes.
 *
 * Three surfaces, three documented facts that a naive scan gets wrong:
 *
 *  1. MCP servers live in `~/.claude.json`, NOT `settings.json` (the trap the plan calls out). User-scope
 *     servers are `~/.claude.json .mcpServers`; a project's local-scope servers are
 *     `~/.claude.json .projects["<abs path>"].mcpServers` (also in `.claude.json`, keyed by project) plus
 *     the project-shared `<projectDir>/.mcp.json .mcpServers`. `settings.json` is scanned ONLY for plugins.
 *  2. Skills are `~/.claude/skills/<name>/SKILL.md` dirs (many symlinked) — see `listSkills`.
 *  3. Plugins are `~/.claude/settings.json .enabledPlugins`, a `{ "<name>@<marketplace>": boolean }` map.
 *     The boolean MATTERS — a disabled plugin is `false` and is NOT in the inventory (R8: reflect the
 *     actual enabled stack, not everything ever installed).
 *
 * Project-scoped surfaces are scanned only when `ctx.projectDir` is set; the default scan is the
 * global/user stack — what cross-runtime parity acts on.
 */
import { join } from "node:path";
import type { InventoryItem } from "../contract/index";
import { asRecord, dedupeItems, listSkills, makeItem, namedItems, readJson, type ScanContext } from "./internal";

/** Observe Claude Code's skills, MCP servers, and enabled plugins from its on-disk configs. Pure + sync:
 *  reads the live files and returns the current inventory (R8) — no persistence, so a rescan always
 *  reflects disk (AE5). Fail-soft per surface; a wholesale throw is caught by `scanAll` (R9). */
export function scanClaudeCode(ctx: ScanContext): InventoryItem[] {
  const items: InventoryItem[] = [];

  // ── MCP servers — from `~/.claude.json` (the trap: NOT settings.json) ──
  const claudeJson = readJson(join(ctx.homeDir, ".claude.json"));
  items.push(...namedItems(ctx, "claude-code", "mcp", claudeJson?.mcpServers));

  // ── Skills — `~/.claude/skills/<name>/SKILL.md` ──
  items.push(...listSkills(ctx, "claude-code", join(ctx.homeDir, ".claude", "skills")));

  // ── Plugins — `settings.json .enabledPlugins`, a `{ "<name>@<mkt>": boolean }` map; enabled (=== true)
  //    only (a disabled plugin is `false`), and an empty key contributes nothing (contract `name.min(1)`). ──
  const settings = readJson(join(ctx.homeDir, ".claude", "settings.json"));
  const enabledPlugins = asRecord(settings?.enabledPlugins);
  for (const name of Object.keys(enabledPlugins)) {
    if (name.length > 0 && enabledPlugins[name] === true) items.push(makeItem(ctx, "claude-code", "plugin", name));
  }

  // ── Project-scoped surfaces (only when a project context is given) ──
  if (ctx.projectDir) {
    // Per-project (local-scope) MCP servers — also in `.claude.json`, keyed by the project's abs path.
    const projectEntry = (claudeJson?.projects ?? null) as Record<string, unknown> | null;
    const projectMcp = projectEntry?.[ctx.projectDir] as Record<string, unknown> | undefined;
    items.push(...namedItems(ctx, "claude-code", "mcp", projectMcp?.mcpServers));
    // Project-shared MCP servers — the checked-in `<projectDir>/.mcp.json`.
    const dotMcp = readJson(join(ctx.projectDir, ".mcp.json"));
    items.push(...namedItems(ctx, "claude-code", "mcp", dotMcp?.mcpServers));
    items.push(...listSkills(ctx, "claude-code", join(ctx.projectDir, ".claude", "skills")));
  }

  // A server present both globally and in the project is ONE item, not a duplicate.
  return dedupeItems(items);
}
