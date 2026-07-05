import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Breadcrumb, Handoff } from "../src/contract/index";
import { createRoutes } from "../src/server/routes";
import { generateToken, securityGate } from "../src/server/security";
import { openDb, type OpenedDb } from "../src/store/db";
import { createRepo, type Repo } from "../src/store/repo";
import { handoffs } from "../src/store/schema";

// A REAL Bun server + real MCP clients over Streamable HTTP on loopback — the plan's "drive the tools
// through a real client session" mandate. Bind on port 0 to learn the port, then hot-swap in the gate/app
// built for that exact port (the gate's Host allowlist keys off the bound port).
const PROJECT = "/Users/jarod/proj";
let root: string;
let opened: OpenedDb;
let repo: Repo;
let server: ReturnType<typeof Bun.serve>;
let port: number;
let token: string;
let clock: number; // injectable wall-clock the tests advance
const openClients: Client[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-"));
  opened = openDb(join(root, "t.db"));
  repo = createRepo(opened.db);
  clock = 1000;
  token = generateToken();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("boot", { status: 503 }) });
  port = server.port!;
  const gate = securityGate({ token, port });
  const app = createRoutes({ repo, gate, machineId: "test-machine", now: () => clock });
  server.reload({ fetch: app.fetch });
});

afterEach(async () => {
  for (const c of openClients.splice(0)) {
    try {
      await c.close();
    } catch {
      /* ignore — best-effort teardown */
    }
  }
  server.stop(true);
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

async function connect(clientName = "claude-code"): Promise<Client> {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { "x-agent-os-token": token } },
  });
  await client.connect(transport);
  openClients.push(client);
  return client;
}

/** The MCP tool-result shape our tools return (a `text` content block). `callTool`'s declared return is a
 *  broader union (CallToolResult | CompatibilityCallToolResult); our tools only ever emit text content, so
 *  `call()` narrows to this — precise and `any`-free. */
interface TextToolResult {
  content: Array<{ type: string; text?: string }>;
}
function textOf(result: TextToolResult): string {
  return result.content.find((x) => x.type === "text")?.text ?? "";
}
function call(client: Client, name: string, args: Record<string, unknown>): Promise<TextToolResult> {
  return client.callTool({ name, arguments: args }) as Promise<TextToolResult>;
}

function handoff(over: Partial<Handoff> = {}): Handoff {
  return {
    project: PROJECT, sessionId: "seed", machineId: "mac-1", source: "claude-code",
    cursor: { inFlight: "sk-SECRET", lastDecided: "chose zod", next: "write tests" }, ts: 1000, ...over,
  };
}
function crumb(over: Partial<Breadcrumb> = {}): Breadcrumb {
  return {
    id: "c", project: PROJECT, sessionId: "seed", machineId: "mac-1", source: "claude-code",
    kind: "note", summary: "did a thing", ts: 1000, sensitivity: "personal", ...over,
  };
}

describe("read_work_state (real client)", () => {
  test("returns the curated payload, redacted through the choke-point", async () => {
    await repo.writeHandoff(handoff({ ts: 1000 }));
    await repo.writeBreadcrumb(crumb({ id: "leak", ts: 1500, summary: "export TOKEN=abc", sensitivity: "secret" }));
    const client = await connect();
    const payload = JSON.parse(textOf(await call(client, "read_work_state", { project: PROJECT })));
    expect(payload.lane).toBe("curated");
    expect(payload.freshness).toBe("stale");
    expect(payload.handoff.cursor.inFlight).toBe("[redacted:secret]");
    expect(payload.raw_trail_tail[0].summary).toBe("[redacted:secret]");
  });

  test("falls back to the raw lane when there is no handoff (AE1)", async () => {
    await repo.writeBreadcrumb(crumb({ id: "only", ts: 1200, summary: "wrote code", sensitivity: "personal" }));
    const payload = JSON.parse(textOf(await call(await connect(), "read_work_state", { project: PROJECT })));
    expect(payload.lane).toBe("raw");
    expect(payload.freshness).toBe("uncurated");
    expect(payload.raw_trail_tail[0].summary).toBe("wrote code");
  });

  test("caps the raw trail at the default (U2-R6), keeping the newest", async () => {
    for (let i = 1; i <= 55; i++) {
      await repo.writeBreadcrumb(crumb({ id: `c${i}`, ts: i, summary: `e${i}`, sensitivity: "personal" }));
    }
    const payload = JSON.parse(textOf(await call(await connect(), "read_work_state", { project: PROJECT })));
    expect(payload.raw_trail_tail).toHaveLength(50);
    expect(payload.raw_trail_tail[49].summary).toBe("e55");
  });
});

describe("write_handoff (real client)", () => {
  test("persists a handoff and flips freshness to fresh", async () => {
    await repo.writeBreadcrumb(crumb({ id: "pre", ts: 1000, summary: "earlier work" }));
    const client = await connect();
    let payload = JSON.parse(textOf(await call(client, "read_work_state", { project: PROJECT })));
    expect(payload.freshness).toBe("uncurated");

    clock = 2000; // the handoff lands after the breadcrumb
    const w = await call(client, "write_handoff", {
      project: PROJECT, source: "claude-code", cursor: { inFlight: "buf", lastDecided: "did X", next: "do Y" },
    });
    expect(JSON.parse(textOf(w)).ok).toBe(true);

    payload = JSON.parse(textOf(await call(client, "read_work_state", { project: PROJECT })));
    expect(payload.lane).toBe("curated");
    expect(payload.freshness).toBe("fresh");
  });

  test("rejects a schema-invalid cursor and persists nothing (U2-R1)", async () => {
    const client = await connect();
    try {
      // Missing lastDecided + next — fails the contract Cursor schema at the boundary.
      await call(client, "write_handoff", { project: PROJECT, source: "claude-code", cursor: { inFlight: "x" } });
    } catch {
      /* SDK may reject with an McpError; either way nothing must persist */
    }
    expect(await repo.readWorkState(PROJECT)).toBeNull();
  });

  test("two concurrent sessions get distinct ids; both handoffs persist (KTD8)", async () => {
    const a = await connect("claude-code");
    const b = await connect("codex");
    clock = 3000;
    await call(a, "write_handoff", { project: PROJECT, source: "claude-code", cursor: { inFlight: "A", lastDecided: "a", next: "a2" } });
    await call(b, "write_handoff", { project: PROJECT, source: "codex", cursor: { inFlight: "B", lastDecided: "b", next: "b2" } });

    const rows = opened.db.select().from(handoffs).where(eq(handoffs.project, PROJECT)).all();
    expect(rows).toHaveLength(2); // distinct (project, sessionId) keys — neither clobbered the other
    expect(new Set(rows.map((r) => r.sessionId)).size).toBe(2);
    // readWorkState still resolves ONE deterministic current.
    expect((await repo.readWorkState(PROJECT))?.lane).toBe("curated");
  });
});

describe("query_breadcrumbs (real client)", () => {
  test("returns redacted crumbs strictly after `since`", async () => {
    await repo.writeBreadcrumb(crumb({ id: "old", ts: 1000, summary: "old note", sensitivity: "personal" }));
    await repo.writeBreadcrumb(crumb({ id: "new", ts: 2000, summary: "SECRET=zzz", sensitivity: "secret" }));
    const crumbs = JSON.parse(textOf(await call(await connect(), "query_breadcrumbs", { project: PROJECT, since: 1500 })));
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].id).toBe("new");
    expect(crumbs[0].summary).toBe("[redacted:secret]");
  });
});

describe("route/tool parity + gate + robustness", () => {
  test("GET /work-state returns byte-identical payload to the read_work_state tool", async () => {
    await repo.writeHandoff(handoff({ ts: 1000 }));
    await repo.writeBreadcrumb(crumb({ id: "n", ts: 1500, summary: "more work", sensitivity: "personal" }));
    const toolText = textOf(await call(await connect(), "read_work_state", { project: PROJECT }));
    const httpRes = await fetch(`http://127.0.0.1:${port}/work-state?project=${encodeURIComponent(PROJECT)}`, {
      headers: { "x-agent-os-token": token },
    });
    expect(httpRes.status).toBe(200);
    expect(await httpRes.text()).toBe(toolText); // identical by construction (shared response path)
  });

  test("the security gate covers /mcp — a connection without the token is refused", async () => {
    const client = new Client({ name: "no-token", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await expect(client.connect(transport)).rejects.toThrow();
  });

  test("malformed tool input is rejected and the server keeps serving", async () => {
    const client = await connect();
    try {
      await client.callTool({ name: "read_work_state", arguments: { project: 123 } }); // project must be a string
    } catch {
      /* rejected — expected */
    }
    await repo.writeBreadcrumb(crumb({ id: "ok", ts: 1000, summary: "still alive", sensitivity: "personal" }));
    const payload = JSON.parse(textOf(await call(client, "read_work_state", { project: PROJECT })));
    expect(payload.lane).toBe("raw"); // the same session still serves a valid call
  });
});

describe("session lifecycle", () => {
  test("an idle session is evicted on the next new connection (no leak on silent disconnect)", async () => {
    const a = await connect("claude-code");
    await repo.writeBreadcrumb(crumb({ id: "x", ts: 1000, summary: "hi", sensitivity: "personal" }));
    expect(JSON.parse(textOf(await call(a, "read_work_state", { project: PROJECT }))).lane).toBe("raw");

    // Advance past the idle TTL (2h), then a NEW connection triggers the sweep that evicts `a`.
    clock += 3 * 60 * 60 * 1000;
    await connect("codex");

    // `a`'s session is gone; its next call is rejected (the client would have to re-initialize).
    await expect(a.callTool({ name: "read_work_state", arguments: { project: PROJECT } })).rejects.toThrow();
  });
});
