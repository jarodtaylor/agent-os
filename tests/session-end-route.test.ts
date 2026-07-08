import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import type { ConnInfo } from "hono/conninfo";
import { TOKEN_HEADER } from "../src/paths";
import { createRoutes } from "../src/server/routes";
import { generateToken, securityGate } from "../src/server/security";
import { openDb, type OpenedDb } from "../src/store/db";
import { createRepo, type Repo } from "../src/store/repo";

// Mirrors tests/security.test.ts: a real temp-file store (so the write actually lands) + the REAL
// createRoutes composition, driven through Hono's in-memory app.request() with an injected loopback peer.
const PORT = 4319;
const HOST = `localhost:${PORT}`;
const FIXED_TS = 1_700_000_000_000;

let root: string;
let opened: OpenedDb;
let repo: Repo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-end-"));
  opened = openDb(join(root, "test.db"));
  repo = createRepo(opened.db);
});

afterEach(() => {
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

const fakeConn = (address: string): ((c: Context) => ConnInfo) => () => ({ remote: { address } });

function buildApp() {
  const token = generateToken();
  const gate = securityGate({ token, port: PORT, getConn: fakeConn("127.0.0.1") });
  const app = createRoutes({ repo, gate, machineId: "test-machine", now: () => FIXED_TS });
  return { app, token };
}

function post(app: ReturnType<typeof createRoutes>, token: string, body: unknown) {
  return app.request("/session-end", {
    method: "POST",
    headers: { host: HOST, [TOKEN_HEADER]: token, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /session-end — graceful-end marker", () => {
  test("writes a server-stamped session-end breadcrumb, and is idempotent on re-POST", async () => {
    const { app, token } = buildApp();
    const res = await post(app, token, { project: "/tmp/proj", sessionId: "sess-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const ws = await repo.readWorkState("/tmp/proj");
    expect(ws?.lane).toBe("raw");
    expect(ws?.rawTrailTail).toHaveLength(1);
    // machineId is stamped SERVER-side (the client never sends it), and the marker is fully server-built.
    expect(ws!.rawTrailTail![0]).toMatchObject({
      id: "sess-1:session-end",
      project: "/tmp/proj",
      sessionId: "sess-1",
      machineId: "test-machine",
      source: "claude-code",
      kind: "session-end",
      summary: "Session ended (graceful).",
      ts: FIXED_TS,
      sensitivity: "path",
    });

    // Stable id ⇒ ON CONFLICT DO NOTHING ⇒ a re-POST adds no duplicate.
    await post(app, token, { project: "/tmp/proj", sessionId: "sess-1" });
    expect((await repo.readWorkState("/tmp/proj"))?.rawTrailTail).toHaveLength(1);
  });

  test("ignores client-supplied content fields — every stored field is server-stamped", async () => {
    const { app, token } = buildApp();
    const res = await post(app, token, {
      project: "/tmp/p",
      sessionId: "s9",
      machineId: "SPOOF",
      summary: "INJECTED",
      id: "attacker",
      sensitivity: "secret",
      kind: "user-prompt",
      source: "codex",
    });
    expect(res.status).toBe(200);

    const ws = await repo.readWorkState("/tmp/p");
    expect(ws?.rawTrailTail).toHaveLength(1);
    // The request body's schema only declares project/sessionId (U6 design: every content field is
    // server-stamped), so none of the spoofed values above can reach the store.
    expect(ws!.rawTrailTail![0]).toMatchObject({
      id: "s9:session-end",
      project: "/tmp/p",
      sessionId: "s9",
      machineId: "test-machine",
      source: "claude-code",
      kind: "session-end",
      summary: "Session ended (graceful).",
      ts: FIXED_TS,
      sensitivity: "path",
    });
  });

  test("rejects a missing field with 400 and writes nothing", async () => {
    const { app, token } = buildApp();
    const res = await post(app, token, { project: "/tmp/proj" }); // no sessionId
    expect(res.status).toBe(400);
    expect(await repo.readWorkState("/tmp/proj")).toBeNull();
  });

  test("rejects an invalid JSON body with 400", async () => {
    const { app, token } = buildApp();
    expect((await post(app, token, "not-json{")).status).toBe(400);
  });

  test("is gated — a POST without the token is refused 403 and writes nothing", async () => {
    const { app } = buildApp();
    const res = await app.request("/session-end", {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({ project: "/tmp/proj", sessionId: "sess-1" }),
    });
    expect(res.status).toBe(403);
    expect(await repo.readWorkState("/tmp/proj")).toBeNull();
  });
});

describe("GET /work-state ?limit= (U6 hook over-fetch bound)", () => {
  async function seedCrumbs(project: string, n: number) {
    for (let i = 0; i < n; i++) {
      await repo.writeBreadcrumb({
        id: `crumb-${i}`,
        project,
        sessionId: "s",
        machineId: "m",
        source: "claude-code",
        kind: "note",
        summary: `step ${i}`,
        ts: FIXED_TS + i,
        sensitivity: "personal",
      });
    }
  }

  function getWorkState(app: ReturnType<typeof createRoutes>, token: string, query: string) {
    return app.request(`/work-state?${query}`, { headers: { host: HOST, [TOKEN_HEADER]: token } });
  }

  async function trailLength(res: Response): Promise<number> {
    return ((await res.json()) as { raw_trail_tail: unknown[] }).raw_trail_tail.length;
  }

  test("caps the raw trail to ?limit=, and returns the full trail when omitted", async () => {
    await seedCrumbs("/tmp/wsp", 5);
    const { app, token } = buildApp();
    const proj = encodeURIComponent("/tmp/wsp");
    expect(await trailLength(await getWorkState(app, token, `project=${proj}&limit=2`))).toBe(2);
    expect(await trailLength(await getWorkState(app, token, `project=${proj}`))).toBe(5);
  });

  test("ignores an invalid ?limit= and falls back to the default", async () => {
    await seedCrumbs("/tmp/wsp2", 3);
    const { app, token } = buildApp();
    const proj = encodeURIComponent("/tmp/wsp2");
    expect(await trailLength(await getWorkState(app, token, `project=${proj}&limit=abc`))).toBe(3);
  });

  test("an extremely large ?limit= is clamped rather than crashing (no 500)", async () => {
    await seedCrumbs("/tmp/wsp3", 5);
    const { app, token } = buildApp();
    const proj = encodeURIComponent("/tmp/wsp3");
    const res = await getWorkState(app, token, `project=${proj}&limit=999999999999999`);
    expect(res.status).toBe(200);
    expect(await trailLength(res)).toBe(5);
  });
});
