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
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * Open (creating the file and its parent dir if absent) the sqlite db at `path`, enable WAL + a
 * busy timeout on the RAW client, then bring the schema up to date via the committed migrations.
 *
 * `:memory:` is rejected, not merely discouraged: `PRAGMA journal_mode=WAL` is a silent no-op on an
 * in-memory db, so an in-memory store would hand back the WAL/concurrency guarantees the rest of the
 * store's contract assumes without actually having them — fail closed instead.
 */
export function openDb(path: string): OpenedDb {
  if (path === ":memory:") {
    throw new Error("openDb requires a real file path: WAL and the store's concurrency guarantees are a no-op on ':memory:'");
  }
  // bun:sqlite won't create missing parent directories, so a first-run data-dir path would throw at
  // `new Database` before the store ever opens. Create the parent up front (no-op if it exists),
  // OWNER-ONLY (0700): this dir holds the brain (store.db carries secret-marked content) and the
  // security token, so no other local user may traverse in. 0700's owner bits survive any umask, and
  // a 0700 dir protects every file inside it regardless of the files' own modes.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const sqlite = new Database(path);
  try {
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA busy_timeout = 5000;");

    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    return { db, close: () => sqlite.close() };
  } catch (err) {
    // A failing pragma or migration would otherwise leak the open handle — fd + WAL lock — with no
    // `close()` handed back for the caller to release, so a retry can't recover cleanly. Close first.
    sqlite.close();
    throw err;
  }
}
