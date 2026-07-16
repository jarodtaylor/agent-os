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
}
// The per-project scope axis (a `projectDir` input + its per-project surfaces) is DEFERRED to U11 — see
// issue #35. U9 scans the USER/GLOBAL stack, which is what cross-runtime parity acts on.

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
 *   - the child value must itself be a config TABLE (object). A scalar/array/null child is malformed — e.g.
 *     `[mcp_servers]` with a stray `ghost = false` makes `mcp_servers.ghost` the boolean `false`, NOT a
 *     server table — so emitting it would fabricate a phantom active server (it also makes `enabled` look
 *     absent). A real server/plugin is always a table; anything else is skipped.
 *   - an entry whose table is EXPLICITLY `enabled = false` is skipped. Codex writes `enabled` into each
 *     `[mcp_servers.x]` / `[plugins."y"]` table; Claude Code's `~/.claude.json .mcpServers` has no such flag,
 *     so all of its entries are kept. Present-and-unflagged counts as enabled — a missing flag is NOT "off"
 *     (a scanner must not invent a disable the config didn't state).
 *   - an empty-string key is skipped: it would emit `name: ""`, which the contract's `name.min(1)` rejects,
 *     so a hand-mangled `{"": {}}` never produces an item that fails `InventoryItem.parse` downstream.
 * A non-object surface yields `[]`. Returns an array to spread like `listSkills`, never mutating an accumulator.
 */
export function namedItems(ctx: ScanContext, runtime: Runtime, kind: ItemKind, surface: unknown): InventoryItem[] {
  const entries = asRecord(surface);
  return Object.keys(entries)
    .filter((name) => {
      const entry = entries[name];
      return name.length > 0 && isRecord(entry) && entry.enabled !== false;
    })
    .map((name) => makeItem(ctx, runtime, kind, name));
}

/** True only for a plain object (a config table) — not `null`, not an array, not a scalar. The one gate
 *  both `asRecord` and `namedItems` (the per-child check) key off, so "is this a real config table?" is
 *  decided in exactly one place. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A value as a plain-object record, or `{}` for anything else (array, `null`, scalar) — so a malformed
 *  config (`mcpServers: "oops"`, `mcpServers: [...]`) yields no keys and no throw, never junk like
 *  `Object.keys("oops")` → `["0",…]`. */
export function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
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

/** Upper bound on a config we'll read into memory — generous (real configs are KBs; `~/.claude.json` can
 *  reach low MBs), so it never rejects a legitimate file, but it bounds the OOM surface of a pathological
 *  oversized one (the attacker-owns-HOME residual). */
const MAX_CONFIG_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Fail-SOFT by design: `null` on an absent, non-regular, oversized, unreadable, OR malformed file. The
 * DELIBERATE inverse of the install-time readers (`install/shared.ts#readJson`, `install/codex.ts`'s local
 * `readToml`), which fail CLOSED — they throw on a corrupt config to gate a merge INTO it. A scanner instead
 * degrades one bad surface to empty and keeps going (R9), so do not "consolidate" these same-named readers.
 *
 * Two boundary guards are load-bearing, not cosmetic:
 *   - The stat-before-read confirms a bounded REGULAR file. `readFileSync` on a FIFO / character-device path
 *     BLOCKS INDEFINITELY (no writer ever comes), and because scans are synchronous + sequential one such
 *     path would hang the WHOLE inventory past any try/catch. A directory/device/oversized target is skipped.
 *   - The warns log the PATH ONLY — NEVER the parse error or file content. A `config.toml` legitimately holds
 *     MCP bearer headers / env secrets, and smol-toml's error message quotes the offending source line, so
 *     logging the error would leak a secret through stderr (no secret escapes any read path). This warn is a
 *     debugging aid; the structured "shown as degraded" signal a consumer renders is deferred to issue #37.
 *
 * There is a mild stat→read TOCTOU (the path could become a FIFO between the two calls), acceptable for a
 * scanner reading the user's own local configs — swapping the target mid-scan needs write access to HOME.
 */
function readParsed(path: string, parse: (raw: string) => unknown): Record<string, unknown> | null {
  let raw: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
      console.warn(`[agent-os] inventory scan: '${path}' is not a readable regular config file (degraded)`);
      return null; // FIFO / device / directory / oversized — skip WITHOUT reading, so a FIFO can't hang the scan
    }
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // absent (ENOENT) or unreadable — silent; the surface simply contributes nothing
  }
  try {
    const v = parse(raw);
    // A top-level non-object (a JSON array or bare scalar) is not a config map — treat as empty.
    return isRecord(v) ? v : null;
  } catch {
    console.warn(`[agent-os] inventory scan: '${path}' is malformed (degraded)`); // PATH only — never the error/content
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
// A `(kind, name)` dedupe helper lived here to collapse global+project overlap; it left with the per-project
// axis (issue #35). Each user-scope surface has unique object keys, so a rescan can't produce duplicates —
// dedupe returns with project scope, when it has a source of overlap again.
