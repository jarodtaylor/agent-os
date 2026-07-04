/**
 * U2 repository — the one seam substrate readers/writers go through on top of the raw Drizzle
 * tables in `schema.ts`.
 *
 * Architecture decision #1 (async interface, synchronous body): every method's TS signature
 * returns a `Promise` — that is the Turso/libSQL swap point (KTD3): an async client can drop in
 * behind this same `Repo` interface later without touching a single call site. But bun:sqlite is a
 * SYNCHRONOUS driver, and each method's actual DB work stays synchronous underneath: the `async`
 * keyword on a method is the ONLY async thing about it — there is no `await` anywhere in a method
 * body. A multi-statement write runs inside `db.transaction(tx => { ... })`, and that callback must
 * ALSO stay synchronous — an `async` transaction callback would let bun-sqlite's `COMMIT` fire
 * before the callback's returned promise resolves, breaking atomicity. This all-synchronous-under-
 * an-async-shell property is exactly what scenario 7 (concurrent writes, never `SQLITE_BUSY`) rests
 * on: a sync body runs to completion in one turn of the event loop, so two "concurrent" calls can
 * never interleave their statements — there is nothing for WAL's writer lock to contend with.
 */
import { and, asc, desc, eq, gt, isNotNull } from "drizzle-orm";
import { WorkState, type Breadcrumb, type Handoff } from "../contract/schema";
import type { Store } from "./db";
import { accessLog, breadcrumbs, captureCursor, handoffs, projects } from "./schema";

/** One row to append to the explicit tool-consumption log — see `logAccess` below. */
export interface AccessLogEntry {
  sessionId?: string;
  harness: string;
  tool: string;
  project: string;
  ts: number;
}

export interface Repo {
  /** Upsert on `(project, sessionId)` — the latest write for a given session wins; a different
   *  session on the same project gets its own row (KTD8). */
  writeHandoff(handoff: Handoff): Promise<void>;
  /** Idempotent append keyed on `id` — re-appending an already-seen event id is a no-op, so a
   *  tailer that re-reads a source line after a restart never duplicates a row. */
  writeBreadcrumb(breadcrumb: Breadcrumb): Promise<void>;
  /** Derive the resume payload for `project` (architecture decision #2): most-recent handoff is
   *  the curated primary, with any STRICTLY NEWER breadcrumbs riding along as `rawTrailTail` (AE2);
   *  no handoff but breadcrumbs exist falls back to an uncurated `lane: "raw"` state built from the
   *  whole trail (AE1); neither existing returns `null`. The assembled object is validated against
   *  `WorkState` before it is returned — never cast. */
  readWorkState(project: string): Promise<WorkState | null>;
  /** Round-trips a tailer's resume offset for one watched source file (upsert on `sourcePath`). */
  writeCaptureCursor(sourcePath: string, byteOffset: number): Promise<void>;
  /** `null` when the path has never been recorded — distinct from an offset of `0`. */
  readCaptureCursor(sourcePath: string): Promise<number | null>;
  /** Append one row to `access_log`. This is the ONLY thing that writes to it — see the module
   *  header on why it is never auto-invoked from inside a read/write method above. */
  logAccess(entry: AccessLogEntry): Promise<void>;
  /** Fraction of distinct sessions that consumed the store through a logged tool call. See the
   *  method body for the exact ratio and its documented edge cases. */
  hitRate(): Promise<number>;
}

/** Build a `Repo` bound to an already-open, already-migrated `Store` (see `db.ts#openDb`). */
export function createRepo(db: Store): Repo {
  return {
    async writeHandoff(handoff) {
      // Two statements (project registry + the handoff row itself) must land together, hence the
      // transaction — and per the module header, this callback stays fully synchronous.
      db.transaction((tx) => {
        ensureProject(tx, handoff.project, handoff.ts);
        tx.insert(handoffs)
          .values({
            project: handoff.project,
            sessionId: handoff.sessionId,
            machineId: handoff.machineId,
            source: handoff.source,
            cursorInFlight: handoff.cursor.inFlight,
            cursorLastDecided: handoff.cursor.lastDecided,
            cursorNext: handoff.cursor.next,
            ts: handoff.ts,
          })
          .onConflictDoUpdate({
            target: [handoffs.project, handoffs.sessionId],
            set: {
              machineId: handoff.machineId,
              source: handoff.source,
              cursorInFlight: handoff.cursor.inFlight,
              cursorLastDecided: handoff.cursor.lastDecided,
              cursorNext: handoff.cursor.next,
              ts: handoff.ts,
            },
          })
          .run();
      });
    },

    async writeBreadcrumb(breadcrumb) {
      db.transaction((tx) => {
        ensureProject(tx, breadcrumb.project, breadcrumb.ts);
        tx.insert(breadcrumbs)
          .values({
            id: breadcrumb.id,
            project: breadcrumb.project,
            sessionId: breadcrumb.sessionId,
            machineId: breadcrumb.machineId,
            source: breadcrumb.source,
            kind: breadcrumb.kind,
            summary: breadcrumb.summary,
            ts: breadcrumb.ts,
            sensitivity: breadcrumb.sensitivity,
          })
          .onConflictDoNothing() // append-only idempotency — see the `breadcrumbs` table doc
          .run();
      });
    },

    async readWorkState(project) {
      // Current handoff = ORDER BY ts DESC, sessionId DESC LIMIT 1 — a deterministic tiebreak
      // when two sessions on the same project close at the identical ts (scenario 2).
      const handoffRow = db
        .select()
        .from(handoffs)
        .where(eq(handoffs.project, project))
        .orderBy(desc(handoffs.ts), desc(handoffs.sessionId))
        .limit(1)
        .get();

      if (handoffRow) {
        // AE2: only breadcrumbs STRICTLY newer than the curated handoff ride along as the raw tail.
        const rawTrail = selectBreadcrumbTrail(db, project, handoffRow.ts);

        const lastActivity = rawTrail.reduce((max, row) => Math.max(max, row.ts), handoffRow.ts);

        const candidate = {
          project,
          machineId: handoffRow.machineId,
          source: handoffRow.source,
          lastActivity,
          lane: "curated",
          handoff: handoffRowToRecord(handoffRow),
          ...(rawTrail.length > 0 ? { rawTrailTail: rawTrail.map(breadcrumbRowToRecord) } : {}),
        };
        // Validate the ASSEMBLED object, never cast (architecture decision #2) — this also
        // re-validates the nested handoff/breadcrumb shapes pulled off raw DB rows above.
        return WorkState.parse(candidate);
      }

      // AE1: no curated handoff — fall back to the raw trail itself, if any exists.
      const allCrumbs = selectBreadcrumbTrail(db, project);

      if (allCrumbs.length === 0) return null;

      // "Primary record" for an uncurated trail = its most recent event (deterministic: the (ts,
      // id) ordering above puts the highest-ts, highest-id row last).
      const mostRecent = allCrumbs[allCrumbs.length - 1]!;
      const lastActivity = allCrumbs.reduce((max, row) => Math.max(max, row.ts), -Infinity);

      const candidate = {
        project,
        machineId: mostRecent.machineId,
        source: mostRecent.source,
        lastActivity,
        lane: "raw",
        rawTrailTail: allCrumbs.map(breadcrumbRowToRecord),
      };
      return WorkState.parse(candidate);
    },

    async writeCaptureCursor(sourcePath, byteOffset) {
      // Single statement — atomic on its own, no explicit transaction needed.
      const updatedAt = Date.now();
      db.insert(captureCursor)
        .values({ sourcePath, byteOffset, updatedAt })
        .onConflictDoUpdate({
          target: captureCursor.sourcePath,
          set: { byteOffset, updatedAt },
        })
        .run();
    },

    async readCaptureCursor(sourcePath) {
      const row = db.select().from(captureCursor).where(eq(captureCursor.sourcePath, sourcePath)).get();
      return row ? row.byteOffset : null;
    },

    async logAccess(entry) {
      db.insert(accessLog)
        .values({
          sessionId: entry.sessionId ?? null,
          harness: entry.harness,
          tool: entry.tool,
          project: entry.project,
          ts: entry.ts,
        })
        .run();
    },

    async hitRate() {
      // Architecture decision #4's ratio: distinct sessions that CONSUMED the store through a logged
      // tool call, over the whole population of sessions the store has ever seen. The denominator is
      // the UNION of breadcrumb sessions (every real session emits a raw trail via the tailer) and
      // access-log sessions, so a consuming session is always counted in its own denominator and the
      // rate stays in [0, 1] — even for a synthetic session that logged access without ever emitting
      // a breadcrumb. Revisit when U4 wires the real per-tool measurement.
      const consumed = new Set(
        db
          .selectDistinct({ sessionId: accessLog.sessionId })
          .from(accessLog)
          .where(isNotNull(accessLog.sessionId))
          .all()
          .map((r) => r.sessionId)
          .filter((s): s is string => s !== null),
      );
      const breadcrumbSessions = new Set<string>(
        db.selectDistinct({ sessionId: breadcrumbs.sessionId }).from(breadcrumbs).all().map((r) => r.sessionId),
      );
      // Denominator = every session the store has seen; a consuming session counts in its own population.
      const universe = consumed.union(breadcrumbSessions);

      if (universe.size === 0) return 0; // guard divide-by-zero
      return consumed.size / universe.size;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The project's raw-lane breadcrumbs in deterministic `(ts, id)` order — the ONE place that ordering
 * (the AE1/AE2 tiebreak invariant the tests pin) is expressed, so `readWorkState`'s two call sites
 * can't drift apart. `afterTs` bounds the scan to events STRICTLY newer than a handoff (AE2's curated
 * tail); omitted, it returns the whole trail (AE1's fallback).
 */
function selectBreadcrumbTrail(db: Store, project: string, afterTs?: number) {
  const where =
    afterTs === undefined
      ? eq(breadcrumbs.project, project)
      : and(eq(breadcrumbs.project, project), gt(breadcrumbs.ts, afterTs));
  return db.select().from(breadcrumbs).where(where).orderBy(asc(breadcrumbs.ts), asc(breadcrumbs.id)).all();
}

/**
 * Register `project` in the registry as a side effect of writing a handoff/breadcrumb that
 * references it ("Registry; upsert on write"). `ON CONFLICT DO NOTHING` is deliberate, not a
 * shortcut: `createdAt` is a first-seen marker, and a true upsert would reset it to "now" on every
 * later write for the same project, defeating its purpose.
 *
 * Typed structurally (`Pick<Store, "insert">`) rather than as the transaction's own type, so this
 * helper works whether called with the outer `db` or the `tx` handle a transaction callback gets —
 * both expose the same `.insert()` builder.
 */
function ensureProject(session: Pick<Store, "insert">, project: string, ts: number): void {
  session.insert(projects).values({ name: project, createdAt: ts }).onConflictDoNothing().run();
}

/** Flatten a `handoffs` row back into the contract's nested `Cursor` shape. Returned as a plain
 *  object, not cast to `Handoff` — `WorkState.parse` at the call site is what actually validates it. */
function handoffRowToRecord(row: typeof handoffs.$inferSelect) {
  return {
    project: row.project,
    sessionId: row.sessionId,
    machineId: row.machineId,
    source: row.source,
    cursor: {
      inFlight: row.cursorInFlight,
      lastDecided: row.cursorLastDecided,
      next: row.cursorNext,
    },
    ts: row.ts,
  };
}

/** Map a `breadcrumbs` row to the contract's flat `Breadcrumb` shape (plain object; see the note
 *  on `handoffRowToRecord` above about where validation actually happens). */
function breadcrumbRowToRecord(row: typeof breadcrumbs.$inferSelect) {
  return {
    id: row.id,
    project: row.project,
    sessionId: row.sessionId,
    machineId: row.machineId,
    source: row.source,
    kind: row.kind,
    summary: row.summary,
    ts: row.ts,
    sensitivity: row.sensitivity,
  };
}
