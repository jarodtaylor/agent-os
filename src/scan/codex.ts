/**
 * Codex inventory scanner (U9) — the ONE module that knows where Codex keeps its stack, the Observe-half
 * peer of `capture/codex.ts`. Codex is config-file-centric: its whole stack (bar skills) lives in one
 * `~/.codex/config.toml`, parsed with the same `smol-toml` the config-write engine uses.
 *
 * Two surfaces in `config.toml`, one on disk:
 *  1. MCP servers — the `[mcp_servers.<name>]` tables → the keys of `config.mcp_servers`. Sub-tables like
 *     `[mcp_servers.<name>.env]` / `[mcp_servers.<name>.tools.*]` nest UNDER a server, so the top-level keys
 *     are exactly the server names (no extra work).
 *  2. Plugins — the `[plugins."<name>@<marketplace>"]` tables → the keys of `config.plugins`. Same
 *     `name@marketplace` identifier Claude Code's `enabledPlugins` uses, so the two are directly comparable
 *     for parity.
 *  3. Skills — `~/.codex/skills/<name>/SKILL.md`, the same convention as Claude Code (the `.system` dir
 *     there is a dotfile and is skipped by `listSkills`).
 *
 * Codex has no per-project MCP surface (its `[projects."…"]` tables are trust/approval settings, not an
 * inventory), so there is no `projectDir` branch here.
 */
import { join } from "node:path";
import type { InventoryItem } from "../contract/index";
import { dedupeItems, listSkills, namedItems, readToml, type ScanContext } from "./internal";

/** Observe Codex's MCP servers, plugins, and skills from `~/.codex/config.toml` + `~/.codex/skills/`. Pure
 *  + sync (R8/AE5); fail-soft — a corrupt `config.toml` yields no config items rather than throwing, and a
 *  wholesale throw is caught by `scanAll` (R9). */
export function scanCodex(ctx: ScanContext): InventoryItem[] {
  const items: InventoryItem[] = [];

  const config = readToml(join(ctx.homeDir, ".codex", "config.toml"));
  items.push(...namedItems(ctx, "codex", "mcp", config?.mcp_servers));
  items.push(...namedItems(ctx, "codex", "plugin", config?.plugins));

  items.push(...listSkills(ctx, "codex", join(ctx.homeDir, ".codex", "skills")));

  return dedupeItems(items);
}
