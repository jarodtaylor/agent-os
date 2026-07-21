/**
 * configwrite internal foundation: the format vocabulary + where backups and the undo journal live.
 *
 * Both the mutation engine (`engine.ts`) and the undo journal (`undo.ts`) depend on these, so they
 * live in a low-level module that depends on neither of them — its own only dependency is the leaf
 * `paths` module. That keeps the import graph a strict DAG — `engine → {internal, undo}`,
 * `undo → internal`, `internal → paths` — with no cycle, and it keeps `engine.ts` from having to
 * reach into `undo.ts` for the data-dir location (an inverted dependency).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as z from "zod";

/** Re-exported so `engine.ts`/`undo.ts`'s existing `from "./internal"` imports keep working —
 *  the OS-data-dir resolution itself moved to `../paths` (U3), since the server needs it too. */
export { resolveDataDir } from "../paths";

/** The formats the engine can write. JSON is native; TOML/YAML go through their libs; `text` is the
 *  opaque whole-file format (KTD1) — parse/serialize are identity on raw bytes, no merge semantics, so a
 *  markdown role file or an extension-less config gets the same backup/atomic-write/undo discipline as a
 *  structured config. `text` is never inferred from an extension; a caller (writeTextFile) forces it. */
export const ConfigFormat = z.enum(["json", "toml", "yaml", "text"]);
export type ConfigFormat = z.infer<typeof ConfigFormat>;

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
