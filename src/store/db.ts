/**
 * U2 store bootstrap — opens (or creates) the sqlite file at `path`, turns on WAL, and brings the
 * schema up to date by running the COMMITTED migrations in `drizzle/` (never `drizzle-kit push`).
 *
 * Migration-bootstrap discipline (brief blind-spot #1): this is the ONLY code path that creates
 * tables. `tests/store.test.ts` bootstraps through this exact function too, so there is no second,
 * divergent "test schema" that could stay green while `drizzle-kit migrate` against the same
 * committed SQL silently breaks.
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "node:path";
import * as schema from "./schema";

// Resolved relative to THIS file (Bun's `import.meta.dir`), not `process.cwd()`, so `openDb()`
// behaves the same regardless of the directory a caller's process happened to start from.
const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "..", "drizzle");

export type Store = ReturnType<typeof drizzle<typeof schema>>;

export interface OpenedDb {
  db: Store;
  /** Releases the underlying sqlite file handle. Tests call this in `afterEach`. */
  close: () => void;
}

/**
 * Open (creating if absent) the sqlite file at `path`, enable WAL + a busy timeout on the RAW
 * client, then bring the schema up to date via the committed migrations.
 *
 * WAL is a no-op on `:memory:` — callers that need the WAL/concurrency guarantees (this store
 * always does, in production) MUST pass a real file path, never `:memory:`.
 */
export function openDb(path: string): OpenedDb {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");

  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return { db, close: () => sqlite.close() };
}
