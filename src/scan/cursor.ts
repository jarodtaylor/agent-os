/**
 * Cursor inventory scanner (U10/U4): user-scoped, live, and fail-soft like the existing U9 scanners.
 *
 * Verified surfaces:
 *  - `~/.cursor/agents/*.md` custom-agent files (represented by InventoryItem's existing `plugin` extension
 *    kind; U4 deliberately changes no contract enum),
 *  - `~/.cursor/skills/<name>/SKILL.md`, and
 *  - `~/.cursor/mcp.json .mcpServers`.
 *
 * Project-scoped Cursor observation is deferred to U11/issue #35; this row preserves U9's current user-scope
 * axis. Each surface fails soft independently, while `scanAll` remains the whole-runtime backstop.
 */
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { InventoryItem } from "../contract/index";
import { listSkills, makeItem, namedItems, readJson, type ScanContext } from "./internal";

export function scanCursor(ctx: ScanContext): InventoryItem[] {
  const cursorRoot = join(ctx.homeDir, ".cursor");
  const config = readJson(join(cursorRoot, "mcp.json"));
  return [
    ...listAgents(ctx, join(cursorRoot, "agents")),
    ...listSkills(ctx, "cursor", join(cursorRoot, "skills")),
    ...namedItems(ctx, "cursor", "mcp", config?.mcpServers),
  ];
}

function listAgents(ctx: ScanContext, agentsRoot: string): InventoryItem[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(({ name }) => !name.startsWith(".") && name.endsWith(".md") && name.length > ".md".length)
    .filter((entry) => isAgentFile(agentsRoot, entry))
    .map(({ name }) => makeItem(ctx, "cursor", "plugin", name.slice(0, -".md".length)));
}

function isAgentFile(root: string, entry: Dirent): boolean {
  if (entry.isFile()) return true;
  if (entry.isDirectory()) return false;
  try {
    return statSync(join(root, entry.name)).isFile(); // follow a valid symlink; reject broken/non-regular entries
  } catch {
    return false;
  }
}
