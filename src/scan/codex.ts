/**
 * Codex inventory scanner (U9) — the ONE module that knows where Codex keeps its stack, the Observe-half
 * peer of `capture/codex.ts`. Codex is config-file-centric: its MCP servers and plugins live in one
 * `~/.codex/config.toml`, parsed with the same `smol-toml` the config-write engine uses.
 *
 * Two surfaces in `config.toml`:
 *  1. MCP servers — the `[mcp_servers.<name>]` tables → the keys of `config.mcp_servers`. Sub-tables like
 *     `[mcp_servers.<name>.env]` / `[mcp_servers.<name>.tools.*]` nest UNDER a server, so the top-level keys
 *     are exactly the server names. Each table carries `enabled = true/false`; a disabled one is skipped
 *     (R8 — the active stack), handled by `namedItems`.
 *  2. Plugins — the `[plugins."<name>@<marketplace>"]` tables → the keys of `config.plugins`, same
 *     `name@marketplace` identifier + `enabled` flag as above, and the same identifier Claude Code's
 *     `enabledPlugins` uses (so the two are directly comparable for parity).
 *
 * Codex SKILLS are DEFERRED (issue #36): the naive `~/.codex/skills` root is verified-wrong (it holds only a
 * `.system` dir), and Codex's real skill discovery (a shared `~/.agents/skills` convention + repo
 * `.agents/skills` + `[[skills.config]]` disables) needs authoritative verification before it can be scanned
 * honestly — so U9 scans only the config.toml surfaces it has confirmed against a live instance.
 */
import { join } from "node:path";
import type { InventoryItem } from "../contract/index";
import { namedItems, readToml, type ScanContext } from "./internal";

/** Observe Codex's MCP servers + plugins from `~/.codex/config.toml`. Pure + sync (R8/AE5); fail-soft — a
 *  corrupt `config.toml` yields no items rather than throwing, and a wholesale throw is caught by `scanAll`
 *  (R9). Codex skill scanning is deferred (issue #36). */
export function scanCodex(ctx: ScanContext): InventoryItem[] {
  const config = readToml(join(ctx.homeDir, ".codex", "config.toml"));
  return [
    ...namedItems(ctx, "codex", "mcp", config?.mcp_servers),
    ...namedItems(ctx, "codex", "plugin", config?.plugins),
  ];
}
