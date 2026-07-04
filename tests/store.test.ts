import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Breadcrumb, Handoff } from "../src/contract/index";
import { openDb, type OpenedDb } from "../src/store/db";
import { createRepo, type Repo } from "../src/store/repo";
import {
  accessLog,
  breadcrumbs as breadcrumbsTable,
  captureCursor as captureCursorTable,
  handoffs as handoffsTable,
  inventory as inventoryTable,
  projects as projectsTable,
} from "../src/store/schema";

// Every test gets its own temp DIR (not just a temp file) holding a real sqlite FILE db, cleaned up
// recursively in `afterEach` — that sweeps WAL's `-wal`/`-shm` sidecars too, not just the `.db`
// itself (mirrors tests/configwrite.test.ts's isolated-workspace-per-test pattern). Using a real
// file db (never `:memory:`) everywhere, not just for the concurrency scenario, means WAL is always
// genuinely active — `PRAGMA journal_mode=WAL` is a documented no-op on `:memory:` (brief
// blind-spot #2), so there is no special-cased setup path that could silently diverge from prod.
let root: string;
let opened: OpenedDb;
let repo: Repo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "store-"));
  opened = openDb(join(root, "test.db"));
  repo = createRepo(opened.db);
});

afterEach(() => {
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    project: "/Users/jarod/proj",
    sessionId: "s1",
    machineId: "mac-1",
    source: "claude-code",
    cursor: { inFlight: "editing foo", lastDecided: "use zod", next: "write tests" },
    ts: 1_720_000_000_000,
    ...overrides,
  };
}

function makeBreadcrumb(overrides: Partial<Breadcrumb> = {}): Breadcrumb {
  return {
    id: uniqueId("evt"),
    project: "/Users/jarod/proj",
    sessionId: "s1",
    machineId: "mac-1",
    source: "claude-code",
    kind: "note",
    summary: "did a thing",
    ts: 1_720_000_000_000,
    sensitivity: "personal",
    ...overrides,
  };
}

// ── Migration bootstrap (brief blind-spot #1) ─────────────────────────────────

describe("migration bootstrap", () => {
  test("openDb on a brand-new path builds all 6 tables from the committed migrations", () => {
    const freshPath = join(root, "fresh.db");
    expect(existsSync(freshPath)).toBe(false);

    // Must not throw — proves `migrate()` builds a working db from scratch off drizzle/*.sql alone.
    const fresh = openDb(freshPath);
    try {
      // Each of the 6 tables is queryable (a missing migration would throw "no such table" here).
      expect(fresh.db.select().from(projectsTable).all()).toEqual([]);
      expect(fresh.db.select().from(handoffsTable).all()).toEqual([]);
      expect(fresh.db.select().from(breadcrumbsTable).all()).toEqual([]);
      expect(fresh.db.select().from(inventoryTable).all()).toEqual([]);
      expect(fresh.db.select().from(accessLog).all()).toEqual([]);
      expect(fresh.db.select().from(captureCursorTable).all()).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  test("WAL is genuinely active on a temp FILE db (the :memory: no-op this must avoid)", () => {
    const row = opened.db.$client.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe("wal");
  });
});

// ── Scenario 1: handoff write→read round-trip ─────────────────────────────────

describe("scenario 1 — handoff write→read round-trip", () => {
  test("a written handoff comes back as the curated work state", async () => {
    const handoff = makeHandoff();
    await repo.writeHandoff(handoff);

    const state = await repo.readWorkState(handoff.project);
    expect(state).not.toBeNull();
    expect(state!.lane).toBe("curated");
    expect(state!.machineId).toBe(handoff.machineId);
    expect(state!.source).toBe(handoff.source);
    expect(state!.lastActivity).toBe(handoff.ts);
    if (state!.lane === "curated") {
      expect(state!.handoff).toEqual(handoff);
      expect(state!.rawTrailTail).toBeUndefined();
    }
  });
});

// ── Scenario 2: two handoff writes to one project ─────────────────────────────

describe("scenario 2 — two handoff writes to one project both persist; deterministic current cursor", () => {
  test("distinct sessions both persist, and the higher sessionId wins an exact ts tie", async () => {
    // SAME ts on purpose: this isolates the sessionId-DESC tiebreak. With different ts values, ts
    // ordering alone would decide and the tiebreak would never actually be exercised.
    const ts = 1_720_000_000_000;
    const h1 = makeHandoff({ sessionId: "session-a", ts, cursor: { inFlight: "", lastDecided: "A", next: "A-next" } });
    const h2 = makeHandoff({ sessionId: "session-b", ts, cursor: { inFlight: "", lastDecided: "B", next: "B-next" } });

    await Promise.all([repo.writeHandoff(h1), repo.writeHandoff(h2)]);

    // Both rows persisted as distinct sessions — neither write clobbered the other (KTD8).
    const rows = opened.db.select().from(handoffsTable).where(eq(handoffsTable.project, h1.project)).all();
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.sessionId))).toEqual(new Set(["session-a", "session-b"]));

    // Deterministic tiebreak: "session-b" > "session-a" lexicographically, so ts DESC, sessionId
    // DESC resolves to session-b as the current handoff.
    const state = await repo.readWorkState(h1.project);
    expect(state!.lane).toBe("curated");
    if (state!.lane === "curated") {
      expect(state!.handoff.sessionId).toBe("session-b");
      expect(state!.handoff.cursor.next).toBe("B-next");
    }
  });
});

// ── Scenario 3: breadcrumb append idempotency ─────────────────────────────────

describe("scenario 3 — breadcrumb append is idempotent per event id", () => {
  test("re-appending the same id does not duplicate the row", async () => {
    const breadcrumb = makeBreadcrumb({ id: "evt-fixed", summary: "first version" });
    await repo.writeBreadcrumb(breadcrumb);
    // Re-append the SAME id, as a tailer would after re-reading a source line post-restart — a
    // no-op even though the payload differs, since idempotency is keyed on id alone.
    await repo.writeBreadcrumb({ ...breadcrumb, summary: "a re-read, different text" });

    const rows = opened.db.select().from(breadcrumbsTable).where(eq(breadcrumbsTable.id, "evt-fixed")).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.summary).toBe("first version"); // ON CONFLICT DO NOTHING — first write wins
  });
});

// ── Scenario 4: lane/freshness derivation (AE1 + AE2) ─────────────────────────

describe("scenario 4 — lane/freshness derivation", () => {
  test("AE2: a handoff with newer raw breadcrumbs surfaces curated primary + raw trail tail", async () => {
    const project = "/Users/jarod/ae2";
    const handoff = makeHandoff({ project, sessionId: "s1", ts: 1000 });
    await repo.writeHandoff(handoff);

    // Older than the handoff — excluded from the raw trail tail by AE2's strict `ts > handoff.ts`.
    await repo.writeBreadcrumb(makeBreadcrumb({ project, ts: 500, summary: "before the handoff" }));
    await repo.writeBreadcrumb(makeBreadcrumb({ project, ts: 1500, summary: "after 1" }));
    await repo.writeBreadcrumb(makeBreadcrumb({ project, ts: 2000, summary: "after 2" }));

    const state = await repo.readWorkState(project);
    expect(state!.lane).toBe("curated");
    expect(state!.lastActivity).toBe(2000);
    if (state!.lane === "curated") {
      expect(state!.handoff).toEqual(handoff);
      expect(state!.rawTrailTail?.map((b) => b.summary)).toEqual(["after 1", "after 2"]);
    }
  });

  test("AE1: no handoff, breadcrumbs exist — uncurated raw lane with visible last activity", async () => {
    const project = "/Users/jarod/ae1";
    await repo.writeBreadcrumb(makeBreadcrumb({ project, ts: 100, summary: "first" }));
    await repo.writeBreadcrumb(makeBreadcrumb({ project, ts: 200, summary: "second" }));

    const state = await repo.readWorkState(project);
    expect(state!.lane).toBe("raw");
    expect(state!.lastActivity).toBe(200);
    if (state!.lane === "raw") {
      expect(state!.rawTrailTail.map((b) => b.summary)).toEqual(["first", "second"]);
      expect(state!.handoff).toBeUndefined();
    }
  });

  test("neither a handoff nor breadcrumbs exist for the project — returns null", async () => {
    expect(await repo.readWorkState("/Users/jarod/never-seen")).toBeNull();
  });
});

// ── Scenario 5: access_log is an explicit primitive, never auto-logged ────────

describe("scenario 5 — logAccess is an explicit primitive; repo read/write methods never auto-log", () => {
  test("logAccess appends a row with the given fields", async () => {
    await repo.logAccess({ sessionId: "s1", harness: "claude-code", tool: "read_work_state", project: "/p", ts: 123 });

    const rows = opened.db.select().from(accessLog).all();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      sessionId: "s1",
      harness: "claude-code",
      tool: "read_work_state",
      project: "/p",
      ts: 123,
    });
  });

  test("logAccess accepts an absent sessionId", async () => {
    await repo.logAccess({ harness: "agent-os", tool: "internal-sweep", project: "/p", ts: 1 });
    const rows = opened.db.select().from(accessLog).all();
    expect(rows[0]!.sessionId).toBeNull();
  });

  // Locks decision #4 as a regression guard: writeHandoff/writeBreadcrumb/readWorkState must NEVER
  // auto-append to access_log — that's deferred to U4's tool-registration choke-point. Asserting
  // this here means a future change that adds auto-logging inside repo.ts fails loudly instead of
  // silently choosing the deferred design.
  test("writeHandoff, writeBreadcrumb, and readWorkState do NOT auto-append to access_log", async () => {
    await repo.writeHandoff(makeHandoff());
    await repo.writeBreadcrumb(makeBreadcrumb());
    await repo.readWorkState("/Users/jarod/proj");

    expect(opened.db.select().from(accessLog).all()).toEqual([]);
  });
});

// ── Scenario 6: hitRate ────────────────────────────────────────────────────────

describe("scenario 6 — hitRate returns the fraction of distinct sessions that touched the store", () => {
  test("distinct-access-sessions / distinct-breadcrumb-sessions", async () => {
    // 4 distinct sessions produced activity (the population hitRate's denominator represents).
    await repo.writeBreadcrumb(makeBreadcrumb({ sessionId: "s1" }));
    await repo.writeBreadcrumb(makeBreadcrumb({ sessionId: "s2" }));
    await repo.writeBreadcrumb(makeBreadcrumb({ sessionId: "s3" }));
    await repo.writeBreadcrumb(makeBreadcrumb({ sessionId: "s4" }));

    // Only 2 of those 4 sessions ever consumed the store through a logged tool call. A repeat
    // access from the same session must not double-count (it's a DISTINCT-session ratio).
    await repo.logAccess({ sessionId: "s1", harness: "claude-code", tool: "read_work_state", project: "/p", ts: 1 });
    await repo.logAccess({ sessionId: "s1", harness: "claude-code", tool: "read_work_state", project: "/p", ts: 2 });
    await repo.logAccess({ sessionId: "s2", harness: "codex", tool: "read_work_state", project: "/p", ts: 3 });

    expect(await repo.hitRate()).toBeCloseTo(0.5, 10);
  });

  test("guards divide-by-zero when no session has produced any activity yet", async () => {
    expect(await repo.hitRate()).toBe(0);
  });

  test("a consuming session with no breadcrumb stays bounded to <= 1.0 (union denominator)", async () => {
    // Synthetic edge: a session logs access but never emitted a breadcrumb. The union denominator
    // counts that session in its own population, so the rate is 1.0 (1 of 1 known sessions consumed),
    // never the > 1.0 a bare access/breadcrumb ratio would produce.
    await repo.logAccess({ sessionId: "ghost", harness: "codex", tool: "read_work_state", project: "/p", ts: 1 });
    expect(await repo.hitRate()).toBe(1);
  });
});

// ── Scenario 7: concurrent writes never raise SQLITE_BUSY ─────────────────────

describe("scenario 7 — concurrent breadcrumb + handoff + access-log writes never raise SQLITE_BUSY", () => {
  test("many interleaved async writes across all three tables all resolve without throwing", async () => {
    const project = "/Users/jarod/concurrent";
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      writes.push(repo.writeHandoff(makeHandoff({ project, sessionId: `s${i}`, ts: 1000 + i })));
      writes.push(repo.writeBreadcrumb(makeBreadcrumb({ project, sessionId: `s${i}`, ts: 1000 + i })));
      writes.push(repo.logAccess({ sessionId: `s${i}`, harness: "claude-code", tool: "t", project, ts: i }));
    }

    // The assertion IS that this doesn't throw/reject — SQLITE_BUSY surfaces as a thrown error.
    // This proves the single-writer invariant (KTD9) survives the sync-body-under-async-shell
    // wrapping. It does NOT prove true concurrent-write handling: a sync driver under an async
    // interface runs each call to completion within one event-loop turn, so nothing here actually
    // interleaves at the statement level — there is no real contention on WAL's writer lock to survive.
    await Promise.all(writes);

    const handoffRows = opened.db.select().from(handoffsTable).where(eq(handoffsTable.project, project)).all();
    const crumbRows = opened.db.select().from(breadcrumbsTable).where(eq(breadcrumbsTable.project, project)).all();
    const accessRows = opened.db.select().from(accessLog).where(eq(accessLog.project, project)).all();
    expect(handoffRows.length).toBe(25);
    expect(crumbRows.length).toBe(25);
    expect(accessRows.length).toBe(25);
  });
});

// ── Scenario 8: capture_cursor round-trips offsets ────────────────────────────

describe("scenario 8 — capture_cursor round-trips offsets", () => {
  test("write then read returns the same byte offset", async () => {
    await repo.writeCaptureCursor("/var/log/claude/session.jsonl", 4096);
    expect(await repo.readCaptureCursor("/var/log/claude/session.jsonl")).toBe(4096);
  });

  test("an unrecorded source path reads back null, distinct from an offset of 0", async () => {
    expect(await repo.readCaptureCursor("/never/seen.jsonl")).toBeNull();
  });

  test("a later write for the same path overwrites the offset (upsert, not append)", async () => {
    await repo.writeCaptureCursor("/a/b.jsonl", 100);
    await repo.writeCaptureCursor("/a/b.jsonl", 250);
    expect(await repo.readCaptureCursor("/a/b.jsonl")).toBe(250);

    const rows = opened.db.select().from(captureCursorTable).where(eq(captureCursorTable.sourcePath, "/a/b.jsonl")).all();
    expect(rows.length).toBe(1); // one row, not two
  });
});

// ── Projects registry: upserted as a write-side-effect (advisor-flagged: implement ⇒ test) ────

describe("projects registry — upserted as a side effect of writeHandoff/writeBreadcrumb", () => {
  test("writeHandoff registers its project", async () => {
    const handoff = makeHandoff({ project: "/Users/jarod/registry-1" });
    await repo.writeHandoff(handoff);

    const rows = opened.db.select().from(projectsTable).where(eq(projectsTable.name, "/Users/jarod/registry-1")).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.createdAt).toBe(handoff.ts);
  });

  test("writeBreadcrumb also registers its project", async () => {
    await repo.writeBreadcrumb(makeBreadcrumb({ project: "/Users/jarod/registry-2" }));

    const rows = opened.db.select().from(projectsTable).where(eq(projectsTable.name, "/Users/jarod/registry-2")).all();
    expect(rows.length).toBe(1);
  });

  test("createdAt is a first-seen marker — a later write never resets it", async () => {
    const project = "/Users/jarod/registry-3";
    await repo.writeHandoff(makeHandoff({ project, sessionId: "s1", ts: 1000 }));
    await repo.writeHandoff(makeHandoff({ project, sessionId: "s1", ts: 5000 })); // later write, same session

    const rows = opened.db.select().from(projectsTable).where(eq(projectsTable.name, project)).all();
    expect(rows.length).toBe(1); // still just one registry row
    expect(rows[0]!.createdAt).toBe(1000); // first-seen ts, not the later 5000
  });
});
