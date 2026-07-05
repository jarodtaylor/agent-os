/**
 * OS data-dir resolution + the well-known file paths under it (U3: extracted from
 * `configwrite/internal.ts` unchanged — the server needs the same dataDir resolution config-write
 * already had, so it now lives in a dependency-free module both sides import from).
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the OS data dir under which every substrate subsystem keeps its files: the sqlite store
 * (`store.db`), the per-boot security token (`agent-os.token`), config-write's backups, and its
 * undo journal.
 *
 * Precedence: explicit `dataDir` (tests inject a temp dir) → `AGENT_OS_DATA_DIR` (escape hatch) →
 * the platform default. This function only computes the path — each subsystem creates the
 * directory (and sets its own file permissions) on first use; see `store/db.ts#openDb` and
 * `server/security.ts#writeTokenFile`.
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

/** Path to the sqlite store db file (see `store/db.ts#openDb`). */
export function dbPath(dataDir: string): string {
  return join(dataDir, "store.db");
}

/** Path to the per-boot security token file (see `server/security.ts`), written mode `0600`. */
export function tokenPath(dataDir: string): string {
  return join(dataDir, "agent-os.token");
}
