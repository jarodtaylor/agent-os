/**
 * Shared types + fail-soft read/emit helpers for the inventory scanners (U9 — the Observe half).
 *
 * The per-runtime modules (`claude-code.ts`, `codex.ts`) own their surface KNOWLEDGE — which files
 * hold what, and the documented traps (Claude Code MCP servers live in `~/.claude.json`, NOT
 * `settings.json`). This base module owns the two things every scanner shares: the ONE
 * `InventoryItem` constructor, and the fail-soft file reads.
 *
 * Every reader here fails SOFT — a missing or corrupt config yields an empty result, never a throw —
 * so one unreadable surface degrades only that surface (R9). The whole-runtime backstop (a scanner
 * that throws anyway degrades only its own runtime, never the inventory) is the try/catch in
 * `index.ts#scanAll`. Defense in depth: soft reads first, source-level catch as the last line.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { InventoryItem, ItemKind, Runtime } from "../contract/index";

/**
 * Everything a scanner needs, injected — never read from `homedir()`/`resolveMachineId` inside a
 * scanner, so tests drive a fixture HOME and the caller resolves identity once.
 */
export interface ScanContext {
  /** The `~` root every surface resolves under. `homedir()` in production; a temp dir in tests. */
  homeDir: string;
  /** This machine's federation id (`paths.ts#resolveMachineId`), stamped onto every item. */
  machineId: string;
  /**
   * Optional project directory. When set, project-scoped surfaces are ALSO scanned (Claude Code's
   * per-project `mcpServers` + the project `.mcp.json` + `<projectDir>/.claude/skills/`). Omitted →
   * the global/user-scope stack only, which is what the cross-runtime "at a glance" inventory wants.
   */
  projectDir?: string;
}

/**
 * One source's scan. Returns its items, or its EMPTY shape on any internal fault (never throws for a
 * missing/corrupt config). Declared sync-or-async so a future filesystem source stays a sync one-liner
 * while an async source (e.g. a Hermes `localhost:9119` probe) drops into the same registry with no
 * spine change — the extensibility the unit exists to protect (decisions #40/#44).
 */
export type SourceScanner = (ctx: ScanContext) => InventoryItem[] | Promise<InventoryItem[]>;

/** The federation `source` stamped on every inventory item: the OS's scanner is the PRODUCER of the
 *  record — distinct from the observed `runtime`. Cursor/Antigravity/OpenCode aren't in the `Source`
 *  enum; `agent-os` is, precisely because agent-os is what observed them. */
const SCANNER_SOURCE = "agent-os" as const;

/** Build one contract `InventoryItem`. `runtime` is the OBSERVED harness; `source` is always the OS. */
export function makeItem(ctx: ScanContext, runtime: Runtime, kind: ItemKind, name: string): InventoryItem {
  return { runtime, kind, name, machineId: ctx.machineId, source: SCANNER_SOURCE };
}

/**
 * One item per key of a name-keyed config surface (an `mcpServers` / `plugins` map) — the shape every
 * scanner's "enumerate this surface" step reduces to. Two honesty rules keep the inventory reflecting the
 * ACTUAL active stack (R8), not everything ever configured:
 *   - an entry whose config table is EXPLICITLY `enabled = false` is skipped. Codex writes `enabled` into
 *     each `[mcp_servers.x]` / `[plugins."y"]` table; Claude Code's `~/.claude.json .mcpServers` has no such
 *     flag, so all of its entries are kept. Present-and-unflagged counts as enabled — a missing flag is NOT
 *     "off" (a scanner must not invent a disable the config didn't state).
 *   - an empty-string key is skipped: it would emit `name: ""`, which the contract's `name.min(1)` rejects,
 *     so a hand-mangled `{"": {}}` never produces an item that fails `InventoryItem.parse` downstream.
 * A non-object surface yields `[]`. Returns an array to spread like `listSkills`, never mutating an accumulator.
 */
export function namedItems(ctx: ScanContext, runtime: Runtime, kind: ItemKind, surface: unknown): InventoryItem[] {
  const entries = asRecord(surface);
  return Object.keys(entries)
    .filter((name) => name.length > 0 && asRecord(entries[name]).enabled !== false)
    .map((name) => makeItem(ctx, runtime, kind, name));
}

/** A value as a plain-object record, or `{}` for anything else (array, `null`, scalar) — so a malformed
 *  config (`mcpServers: "oops"`, `mcpServers: [...]`) yields no keys and no throw, never junk like
 *  `Object.keys("oops")` → `["0",…]`. */
export function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Keys of a value only when it is a plain object (see `asRecord`); `[]` for any non-object surface. */
export function objectKeys(v: unknown): string[] {
  return Object.keys(asRecord(v));
}

/** Parse a JSON config, or `null` when it is absent, unreadable, or malformed (fail-soft). */
export function readJson(path: string): Record<string, unknown> | null {
  return readParsed(path, JSON.parse);
}

/** Parse a TOML config with `smol-toml` (the SAME parser configwrite uses — one TOML dialect across
 *  the codebase), or `null` when it is absent, unreadable, or malformed (fail-soft). */
export function readToml(path: string): Record<string, unknown> | null {
  return readParsed(path, (raw) => parseToml(raw));
}

/**
 * Fail-SOFT by design: `null` on an absent, unreadable, OR malformed file. This is the DELIBERATE inverse
 * of the install-time readers (`install/shared.ts#readJson`, `install/codex.ts`'s local `readToml`), which
 * fail CLOSED — they throw on a corrupt config because they gate a merge INTO it. A scanner must instead
 * degrade one bad surface to empty and keep going (R9), so do not "consolidate" these same-named readers.
 */
function readParsed(path: string, parse: (raw: string) => unknown): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // absent / unreadable — this surface contributes nothing, not an error
  }
  try {
    const v = parse(raw);
    // A top-level non-object (e.g. a JSON array or bare scalar) is not a config map — treat as empty.
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null; // malformed → degrade this surface (R9), never throw
  }
}

/** Whether `path` resolves (through symlinks) to a REGULAR FILE — the honest test for a `SKILL.md` marker.
 *  `existsSync` would be true for a DIRECTORY too, so a `SKILL.md/` directory would fake a skill (a phantom,
 *  AE5); `statSync` follows symlinks (a symlinked skill dir still counts) and throws on a broken symlink or
 *  missing path, which we swallow to `false`. Mirrors the config-write engine's regular-file discipline. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Enumerate the skills under one skills root as InventoryItems — shared by Claude Code and Codex, which
 * both use the `<name>/SKILL.md` convention. A skill is a non-dotfile entry whose `SKILL.md` is a real file:
 *
 *   - `isFile` follows symlinks, so a symlinked skill dir counts (many of Jarod's are symlinks); a BROKEN
 *     symlink or a `SKILL.md` that is itself a directory yields `false` — never a phantom (AE5).
 *   - a plain file or a dir without a `SKILL.md` file → skipped (no phantom).
 *   - dotfiles (`.system` under `~/.codex/skills`, `.DS_Store`) are skipped.
 *   - a missing/unreadable root → `[]` (no skills for this runtime, not an error).
 */
export function listSkills(ctx: ScanContext, runtime: Runtime, skillsRoot: string): InventoryItem[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith("."))
    .filter((name) => isFile(join(skillsRoot, name, "SKILL.md")))
    .map((name) => makeItem(ctx, runtime, "skill", name));
}

/** Collapse items to one per `(kind, name)` within a runtime — a server present in BOTH the global and a
 *  project surface (or a skill reachable two ways) is one inventory item, not a duplicate. Runtime is
 *  fixed per scanner, so `(kind, name)` is the natural key here; the SAME item in a different runtime is
 *  intentionally distinct (that gap is exactly what parity propagation acts on). Order-stable. */
export function dedupeItems(items: InventoryItem[]): InventoryItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const key = `${it.kind} ${it.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
