/**
 * U2 store schema — the 6 Drizzle tables backing the substrate (plan §U2).
 *
 * Flat queryable columns, never JSON blobs (architecture decision #3): cursor-resolution,
 * per-id dedup, and freshness ordering are real SQL (`ORDER BY`, `ON CONFLICT`, range filters),
 * which only works because no STORED table here has an array-typed column. `Handoff.cursor` and
 * `Breadcrumb`/`WorkState` arrays are contract-level (src/contract/schema.ts) shapes assembled by
 * repo.ts from these flat rows — they are never the storage representation.
 *
 * All epoch-millisecond columns (`ts`, `createdAt`, `updatedAt`, `byteOffset`) use `integer()` in
 * its DEFAULT mode (plain `number`), never `{ mode: "timestamp" }` — timestamp mode round-trips a
 * `Date` on read, which fails the contract's `z.number().int()` at `WorkState.parse()` in repo.ts.
 */
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { BreadcrumbKind, ItemKind, Runtime, Sensitivity, Source } from "../contract/index";

/**
 * Registry of known project keys. Never written to directly — `repo.ts`'s `writeHandoff` and
 * `writeBreadcrumb` upsert a row here as a side effect (INSERT OR IGNORE) whenever they see a
 * `project` value, which is exactly what "upsert on write" means for a table with no data-bearing
 * columns of its own. `createdAt` is a first-seen marker: it is set once and never overwritten,
 * so re-seeing a project on every later write does NOT reset it to "now".
 */
export const projects = sqliteTable("projects", {
  name: text("name").primaryKey(),
  createdAt: integer("created_at"),
});

/**
 * Curated "pick up here" record, one row per (project, sessionId) — different sessions on the
 * same project coexist (KTD8); a later write for the SAME session replaces its row (true upsert,
 * "latest write wins per session"). The current handoff for a project is `ORDER BY ts DESC,
 * sessionId DESC LIMIT 1` — a deterministic tiebreak when two sessions close at the identical ts.
 */
export const handoffs = sqliteTable(
  "handoffs",
  {
    project: text("project").notNull(),
    sessionId: text("session_id").notNull(),
    machineId: text("machine_id").notNull(),
    source: text("source").$type<Source>().notNull(),
    // The Cursor's three fields, flattened (decision #3) — `inFlight` is the secret-sensitivity one.
    cursorInFlight: text("cursor_in_flight").notNull(),
    cursorLastDecided: text("cursor_last_decided").notNull(),
    cursorNext: text("cursor_next").notNull(),
    ts: integer("ts").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.project, table.sessionId] }),
    // The current-handoff query filters by project and orders by ts — index it so it never scans.
    index("handoffs_project_ts_idx").on(table.project, table.ts),
  ],
);

/**
 * One captured raw-lane event. `id` is the tailer's event id — appends are idempotent
 * (`ON CONFLICT(id) DO NOTHING` in repo.ts) so re-reading the same source line after a tailer
 * restart never duplicates a row.
 */
export const breadcrumbs = sqliteTable(
  "breadcrumbs",
  {
    id: text("id").primaryKey(),
    project: text("project").notNull(),
    sessionId: text("session_id").notNull(),
    machineId: text("machine_id").notNull(),
    source: text("source").$type<Source>().notNull(),
    kind: text("kind").$type<BreadcrumbKind>().notNull(),
    summary: text("summary").notNull(),
    ts: integer("ts").notNull(),
    sensitivity: text("sensitivity").$type<Sensitivity>().notNull(),
  },
  // Append-only, and read by readWorkState as project-scoped, ts-ordered range scans (AE1/AE2).
  // Index the (project, ts) hot path so those reads stay sub-linear as the trail grows unbounded.
  (table) => [index("breadcrumbs_project_ts_idx").on(table.project, table.ts)],
);

/**
 * One observed stack item, one row per natural key. Unlike breadcrumbs, this is a true upsert
 * (`source` can change across a re-scan — e.g. a skill symlink moves) — not append-only.
 */
export const inventory = sqliteTable(
  "inventory",
  {
    runtime: text("runtime").$type<Runtime>().notNull(),
    kind: text("kind").$type<ItemKind>().notNull(),
    name: text("name").notNull(),
    machineId: text("machine_id").notNull(),
    source: text("source").$type<Source>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.runtime, table.kind, table.name, table.machineId] })],
);

/**
 * Explicit tool-consumption log (architecture decision #4). Nothing in repo.ts auto-appends here
 * from a read/write method — only `logAccess` writes rows, and only `hitRate` reads them. See
 * repo.ts for the full rationale (hit-rate measures harness CONSUMPTION, not OS-internal capture).
 */
export const accessLog = sqliteTable("access_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id"),
  harness: text("harness").notNull(),
  tool: text("tool").notNull(),
  project: text("project").notNull(),
  ts: integer("ts").notNull(),
});

/** Tailer resume offsets, one row per watched source file path. Round-trips a byte offset so a
 *  restarted tailer resumes exactly where it left off instead of re-reading a whole log file. */
export const captureCursor = sqliteTable("capture_cursor", {
  sourcePath: text("source_path").primaryKey(),
  byteOffset: integer("byte_offset").notNull(),
  updatedAt: integer("updated_at"),
});
