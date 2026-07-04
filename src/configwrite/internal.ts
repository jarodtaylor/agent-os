/**
 * configwrite internal foundation: the format vocabulary + where backups and the undo journal live.
 *
 * Both the mutation engine (`engine.ts`) and the undo journal (`undo.ts`) depend on these, so they
 * live in a dependency-free module. That keeps the import graph a strict DAG —
 * `engine → {internal, undo}`, `undo → internal`, `internal → nothing` — with no cycle, and it keeps
 * `engine.ts` from having to reach into `undo.ts` for the data-dir location (an inverted dependency).
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";

/** The config file formats the engine can merge. JSON is native; TOML/YAML go through their libs. */
export const ConfigFormat = z.enum(["json", "toml", "yaml"]);
export type ConfigFormat = z.infer<typeof ConfigFormat>;

/**
 * Resolve the OS data dir that holds backups + the undo journal.
 *
 * Precedence: explicit `dataDir` (tests inject a temp dir) → `AGENT_OS_DATA_DIR` (escape hatch) →
 * the platform default. The dir is created owner-only (`0700`) on first write because backups can
 * contain the very same credentials the configs embed — the store must never be more exposed than
 * the originals.
 */
export function resolveDataDir(dataDir?: string): string {
  if (dataDir) return dataDir;
  if (process.env.AGENT_OS_DATA_DIR) return process.env.AGENT_OS_DATA_DIR;
  // macOS is the slice-1 host (roster decision); Application Support is its OS data dir.
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "agent-os");
  }
  // Elsewhere (Linux CI), fall back to XDG so the utility stays correct off the primary host.
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-os");
}

/** Directory holding byte-exact backups of pre-mutation config files. */
export function backupsDir(dataDir: string): string {
  return join(dataDir, "backups");
}

/** The append-only JSONL undo journal. On disk (not in memory) so a separate process — an
 *  uninstaller running long after the installer exited — can still restore from it. */
export function journalPath(dataDir: string): string {
  return join(dataDir, "undo-journal.jsonl");
}

/** Stable content identity for undo's safety check — a SHA-256 hex digest of a file's bytes/text. */
export function hashContent(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
