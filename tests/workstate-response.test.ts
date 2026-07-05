import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Breadcrumb, Handoff } from "../src/contract/index";
import { openDb, type OpenedDb } from "../src/store/db";
import { accessLog } from "../src/store/schema";
import { createRepo, type Repo } from "../src/store/repo";
import { readWorkStateResponse } from "../src/workstate/response";

// Real file db per test (WAL genuinely active) — mirrors tests/store.test.ts.
let root: string;
let opened: OpenedDb;
let repo: Repo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wsr-"));
  opened = openDb(join(root, "test.db"));
  repo = createRepo(opened.db);
});
afterEach(() => {
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

const PROJECT = "/Users/jarod/proj";
const CONSUMER = { harness: "test-harness", tool: "read_work_state", sessionId: "sess-1" };

function handoff(over: Partial<Handoff> = {}): Handoff {
  return {
    project: PROJECT, sessionId: "s1", machineId: "mac-1", source: "claude-code",
    cursor: { inFlight: "sk-SECRET-inflight", lastDecided: "chose zod", next: "write tests" },
    ts: 100, ...over,
  };
}
function crumb(over: Partial<Breadcrumb> = {}): Breadcrumb {
  return {
    id: "b", project: PROJECT, sessionId: "s1", machineId: "mac-1", source: "claude-code",
    kind: "note", summary: "did a thing", ts: 150, sensitivity: "personal", ...over,
  };
}

describe("readWorkStateResponse — freshness", () => {
  test("fresh: curated handoff is the latest activity (no newer breadcrumbs)", async () => {
    await repo.writeHandoff(handoff());
    const r = await readWorkStateResponse(repo, PROJECT, CONSUMER);
    expect(r?.lane).toBe("curated");
    expect(r?.freshness).toBe("fresh");
    expect(r?.raw_trail_tail).toEqual([]);
    expect(r?.handoff).not.toBeNull();
  });

  test("stale: work happened after the last handoff", async () => {
    await repo.writeHandoff(handoff({ ts: 100 }));
    await repo.writeBreadcrumb(crumb({ id: "newer", ts: 150 }));
    const r = await readWorkStateResponse(repo, PROJECT, CONSUMER);
    expect(r?.lane).toBe("curated");
    expect(r?.freshness).toBe("stale");
    expect(r?.raw_trail_tail).toHaveLength(1);
  });

  test("uncurated: raw trail only, no handoff (AE1)", async () => {
    await repo.writeBreadcrumb(crumb({ id: "only", ts: 150 }));
    const r = await readWorkStateResponse(repo, PROJECT, CONSUMER);
    expect(r?.lane).toBe("raw");
    expect(r?.freshness).toBe("uncurated");
    expect(r?.handoff).toBeNull();
  });
});

describe("readWorkStateResponse — redaction through the shared path", () => {
  test("redacts the handoff cursor secret and an escalated breadcrumb", async () => {
    await repo.writeHandoff(handoff({ ts: 100 }));
    await repo.writeBreadcrumb(crumb({ id: "secretcrumb", ts: 150, summary: "TOKEN=abc", sensitivity: "secret" }));
    const r = await readWorkStateResponse(repo, PROJECT, CONSUMER);
    expect(r?.handoff?.cursor.inFlight).toBe("[redacted:secret]");
    expect(r?.raw_trail_tail[0]?.summary).toBe("[redacted:secret]");
  });

  test("passes a personal summary through (resume needs it)", async () => {
    await repo.writeBreadcrumb(crumb({ id: "ok", ts: 10, summary: "refactored repo.ts", sensitivity: "personal" }));
    const r = await readWorkStateResponse(repo, PROJECT, CONSUMER);
    expect(r?.raw_trail_tail[0]?.summary).toBe("refactored repo.ts");
  });
});

describe("readWorkStateResponse — U2-R6 cap + shape + logging", () => {
  test("caps raw_trail_tail to the most-recent-N, ascending", async () => {
    for (let i = 1; i <= 5; i++) {
      await repo.writeBreadcrumb(crumb({ id: `c${i}`, ts: i * 10, summary: `event ${i}` }));
    }
    const r = await readWorkStateResponse(repo, PROJECT, CONSUMER, { limit: 2 });
    expect(r?.raw_trail_tail).toHaveLength(2);
    // Most-recent 2 (ts 40, 50), restored to ascending order.
    expect(r?.raw_trail_tail.map((b) => b.summary)).toEqual(["event 4", "event 5"]);
  });

  test("envelope is snake_case with derived last_activity", async () => {
    await repo.writeHandoff(handoff({ ts: 100 }));
    await repo.writeBreadcrumb(crumb({ id: "n", ts: 175 }));
    const r = await readWorkStateResponse(repo, PROJECT, CONSUMER);
    expect(Object.keys(r ?? {}).sort()).toEqual(
      ["freshness", "handoff", "lane", "last_activity", "project", "raw_trail_tail"],
    );
    expect(r?.last_activity).toBe(175); // newest activity, not the handoff ts
  });

  test("logs access on every call — including a miss (null)", async () => {
    const miss = await readWorkStateResponse(repo, "/no/such/project", CONSUMER, { now: 12345 });
    expect(miss).toBeNull();
    const rows = opened.db.select().from(accessLog).where(eq(accessLog.tool, "read_work_state")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.harness).toBe("test-harness");
    expect(rows[0]?.project).toBe("/no/such/project");
    expect(rows[0]?.ts).toBe(12345);
  });
});
