import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { propose } from "../src/mcp/provision-tools";
import { runCli } from "../src/provision/cli";
import { createRoutes } from "../src/server/routes";
import { generateToken, securityGate } from "../src/server/security";
import { openDb, type OpenedDb } from "../src/store/db";
import { createRepo, type Repo } from "../src/store/repo";
import { accessLog } from "../src/store/schema";

// U10 U7: the propose-only MCP tools. `propose()` is the tool body without MCP plumbing; one suite drives the
// real tools through a real Streamable-HTTP client session, the way a harness would.
let root: string;
let projectRoot: string;
let dataDir: string;

const PROJECT = "project"; // `init`'s default logical name is the project directory's basename

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "provision-mcp-")));
  projectRoot = join(root, PROJECT);
  dataDir = join(root, "data");
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const cli = (argv: string[]) => runCli(argv, { cwd: projectRoot, dataDir });
const writeProject = (rel: string, content: string): void => {
  mkdirSync(dirname(join(projectRoot, rel)), { recursive: true });
  writeFileSync(join(projectRoot, rel), content);
};

/** Every file under `dir`, path → bytes — the "byte-unchanged" witness for AE5. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(full, readFileSync(full, "base64"));
    }
  };
  walk(dir);
  return out;
}

describe("propose — same answers as the CLI", () => {
  test("provision_plan returns the CLI plan's rows and change count for a registered project", () => {
    expect(cli(["init"]).exitCode).toBe(0);
    const viaCli = cli(["plan", "--json"]);
    const viaTool = propose("provision_plan", PROJECT, dataDir);
    if (!viaTool.ok || viaCli.json.verb !== "plan") throw new Error("expected both to succeed");
    expect(viaTool.rows).toEqual(viaCli.json.rows);
    expect(viaTool.changes).toBe(viaCli.json.changes);
    expect(viaTool.changes).toBeGreaterThan(0);
    expect(viaTool.projectRoot).toBe(projectRoot);
  });

  test("provision_status reports drift exactly as the CLI status does", () => {
    cli(["init"]);
    expect(cli(["apply"]).exitCode).toBe(0);
    writeProject("CLAUDE.md", "hand-edited after apply\n");
    const viaCli = cli(["status", "--json"]);
    const viaTool = propose("provision_status", PROJECT, dataDir);
    if (!viaTool.ok || viaCli.json.verb !== "status") throw new Error("expected both to succeed");
    expect(viaTool.rows).toEqual(viaCli.json.rows);
    expect(viaTool.drifted).toBe(1);
    expect(viaTool.rows.some((row) => row.action === "scaffold-skip")).toBe(false);
  });
});

describe("propose — refusals (KTD11, KTD5)", () => {
  test("an unregistered project is refused by name, with no path in the answer", () => {
    cli(["init"]);
    const out = propose("provision_plan", "not-a-project", dataDir);
    expect(out).toMatchObject({ ok: false, refusal: "unknown-project", project: "not-a-project" });
    expect(JSON.stringify(out)).not.toContain(root);
  });

  test("a path-shaped project string is a logical key, never path-joined", () => {
    cli(["init"]);
    for (const project of [projectRoot, "../project", `${PROJECT}/blueprint`]) {
      expect(propose("provision_status", project, dataDir)).toMatchObject({ ok: false, refusal: "unknown-project" });
    }
  });

  test("an absent blueprint is a typed refusal pointing at init", () => {
    cli(["init"]);
    rmSync(join(projectRoot, "blueprint"), { recursive: true, force: true });
    const out = propose("provision_plan", PROJECT, dataDir);
    expect(out).toMatchObject({ ok: false, refusal: "survey-refused" });
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toContain("init");
  });

  test("a schema-incompatible blueprint carries the upgrade instruction", () => {
    cli(["init"]);
    const manifest = JSON.parse(readFileSync(join(projectRoot, "blueprint/manifest.json"), "utf8"));
    writeProject("blueprint/manifest.json", JSON.stringify({ ...manifest, schemaVersion: 99 }));
    const out = propose("provision_plan", PROJECT, dataDir);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.error).toContain("Upgrade agent-os");
  });

  test("a secret-tripping blueprint names the file and echoes no content", () => {
    const SECRET = "sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQ";
    cli(["init"]);
    writeProject("blueprint/roles/architect/agent.md", `---\nname: architect\n---\n\nuse ${SECRET} to log in\n`);
    for (const tool of ["provision_plan", "provision_status"] as const) {
      const out = propose(tool, PROJECT, dataDir);
      expect(out).toMatchObject({ ok: false, refusal: "survey-refused" });
      if (out.ok) throw new Error("unreachable");
      expect(out.error).toContain("roles/architect/agent.md");
      expect(JSON.stringify(out)).not.toContain("sk-ant");
    }
  });
});

describe("the tools over a real MCP session", () => {
  let opened: OpenedDb;
  let repo: Repo;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;
  let token: string;
  const clients: Client[] = [];

  beforeEach(() => {
    opened = openDb(join(root, "t.db"));
    repo = createRepo(opened.db);
    token = generateToken();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("boot", { status: 503 }) });
    port = server.port!;
    const app = createRoutes({ repo, gate: securityGate({ token, port }), machineId: "test-machine", now: () => 1000, dataDir });
    server.reload({ fetch: app.fetch });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      try {
        await c.close();
      } catch {
        /* best-effort teardown */
      }
    }
    server.stop(true);
    opened.close();
  });

  async function connect(): Promise<Client> {
    const client = new Client({ name: "claude-code", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { "x-agent-os-token": token } },
      }),
    );
    clients.push(client);
    return client;
  }

  const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
    (result.content as Array<{ type: string; text: string }>)[0]!.text;

  test("AE5: the inventory holds exactly the two read-only provision tools — nothing that applies, undoes, or inits", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("provision_")).sort()).toEqual(["provision_plan", "provision_status"]);
    for (const n of names) expect(n).not.toMatch(/apply|undo|init|write.*provision|provision.*write/i);
  });

  test("AE5: calling both tools leaves every project surface and the data dir byte-unchanged", async () => {
    cli(["init"]);
    cli(["apply"]);
    writeProject("CLAUDE.md", "drifted\n");
    const beforeProject = snapshot(projectRoot);
    const beforeData = snapshot(dataDir);

    const client = await connect();
    for (const name of ["provision_plan", "provision_status"]) {
      const result = await client.callTool({ name, arguments: { project: PROJECT } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result)).ok).toBe(true);
    }

    expect(snapshot(projectRoot)).toEqual(beforeProject);
    expect(snapshot(dataDir)).toEqual(beforeData);
  });

  test("a refusal comes back as a tool error with the typed payload, and every call is access-logged", async () => {
    cli(["init"]);
    const client = await connect();
    const refused = await client.callTool({ name: "provision_status", arguments: { project: "nope" } });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(textOf(refused))).toMatchObject({ ok: false, refusal: "unknown-project" });
    await client.callTool({ name: "provision_plan", arguments: { project: PROJECT } });

    const tools = opened.db.select({ tool: accessLog.tool, project: accessLog.project }).from(accessLog).orderBy(accessLog.id).all();
    expect(tools).toEqual([
      { tool: "provision_status", project: "nope" },
      { tool: "provision_plan", project: PROJECT },
    ]);
  });
});
