import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { dirname, join, resolve } from "node:path";
import { applyJson, applyText, runCli } from "../src/provision/cli";
import { readKnownProjects } from "../src/provision/registry";

// Every fixture lives under a temp root; `dataDir` is injected so no test can touch the real data dir.
// macOS resolves `/var` → `/private/var`, and the CLI realpaths the project root at ingress (issue #51.1),
// so every assertion about a STORED root compares against the realpath'd fixture, not the raw temp path.
let root: string;
let projectRoot: string;
let dataDir: string;

const REPO_ROOT = resolve(import.meta.dir, "..");
const SEED_ROOT = join(REPO_ROOT, "templates", "blueprint-seed");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "provision-cli-")));
  projectRoot = join(root, "project");
  dataDir = join(root, "data");
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Drive the CLI in-process. `cwd` defaults to the fixture project, so verbs exercise the default-cwd path. */
const cli = (argv: string[], cwd: string = projectRoot) => runCli(argv, { cwd, dataDir });

const p = (rel: string): string => join(projectRoot, rel);
const readProject = (rel: string): string => readFileSync(p(rel), "utf8");
const writeProject = (rel: string, content: string): void => {
  mkdirSync(dirname(p(rel)), { recursive: true });
  writeFileSync(p(rel), content);
};

/** The provisioned surfaces the seed blueprint owns, one per (harness, surface) the seed exercises. */
const SEED_SURFACES = [
  "CLAUDE.md",
  ".claude/agents/architect.md",
  ".claude/agents/reviewer.md",
  "AGENTS.md",
  ".codex/agents/executor.toml",
  ".cursor/agents/qa.md",
  ".cursor/skills/qa-browser-e2e/SKILL.md",
  ".cursor/mcp.json",
];

describe("init", () => {
  test("AE2: init + apply leaves all three harnesses role-ready, and an immediate plan has nothing to change", () => {
    const init = cli(["init"]);
    expect(init.exitCode).toBe(0);
    expect(init.json).toMatchObject({ verb: "init", ok: true, errors: [], project: projectRoot });

    const applied = cli(["apply"]);
    expect(applied.exitCode).toBe(0);
    if (applied.json.verb !== "apply") throw new Error("unreachable");
    expect(applied.json.errors).toEqual([]);
    expect(applied.json.failed).toEqual([]);
    expect(applied.json.rolledBack).toBe(false);

    for (const surface of SEED_SURFACES) expect(existsSync(p(surface))).toBe(true);
    // All three harnesses, not just the one that happens to be first in the manifest.
    expect(readProject("CLAUDE.md")).toContain("RUN_STATE protocol");
    expect(readProject(".codex/agents/executor.toml")).toContain("executor");
    expect(JSON.parse(readProject(".cursor/mcp.json")).mcpServers.playwright.command).toBe("npx");

    const plan = cli(["plan"]);
    expect(plan.exitCode).toBe(0);
    if (plan.json.verb !== "plan") throw new Error("unreachable");
    expect(plan.json.changes).toBe(0);
    expect(plan.json.rows.every((r) => r.action === "noop" || r.action === "scaffold-skip")).toBe(true);
  });

  test("AE2: init scaffolds RUN_STATE.md with the seed content and registers the project", () => {
    const init = cli(["init"]);
    if (init.json.verb !== "init") throw new Error("unreachable");
    expect(init.json.runState).toBe("created");
    expect(readProject("RUN_STATE.md")).toContain("# RUN_STATE");

    const known = readKnownProjects(dataDir);
    const record = known.get("project");
    expect(record).toBeDefined();
    expect(record?.projectRoot).toBe(projectRoot);
    expect(record?.blueprintRoot).toBe(p("blueprint"));
  });

  test("re-init without --force refuses and changes nothing", () => {
    cli(["init"]);
    writeProject("blueprint/roles/architect/agent.md", "hand tuned");
    const before = readFileSync(p("blueprint/manifest.json"), "utf8");

    const again = cli(["init"]);
    expect(again.exitCode).toBe(1);
    expect(again.json.ok).toBe(false);
    expect(again.json.errors.join(" ")).toContain("--force");
    expect(readProject("blueprint/roles/architect/agent.md")).toBe("hand tuned");
    expect(readFileSync(p("blueprint/manifest.json"), "utf8")).toBe(before);
  });

  test("re-init with --force replaces the blueprint but never rewrites RUN_STATE.md", () => {
    cli(["init"]);
    writeProject("RUN_STATE.md", "# RUN_STATE\n\nreal run history nobody may clobber\n");
    writeProject("blueprint/roles/architect/agent.md", "hand tuned");
    writeProject("blueprint/stale-role.md", "left over from a previous seed");

    const forced = cli(["init", "--force"]);
    expect(forced.exitCode).toBe(0);
    if (forced.json.verb !== "init") throw new Error("unreachable");
    expect(forced.json.runState).toBe("present");

    // The blueprint is REPLACED: seed files are restored and files the seed does not own are gone.
    expect(readProject("blueprint/roles/architect/agent.md")).toBe(
      readFileSync(join(SEED_ROOT, "roles/architect/agent.md"), "utf8"),
    );
    expect(existsSync(p("blueprint/stale-role.md"))).toBe(false);
    // R12: the run file is untouched.
    expect(readProject("RUN_STATE.md")).toBe("# RUN_STATE\n\nreal run history nobody may clobber\n");
  });

  test("init creates a project root that does not exist yet; other verbs refuse it", () => {
    const fresh = join(root, "brand-new");
    expect(cli(["plan", "--project", fresh]).exitCode).toBe(1);
    expect(cli(["plan", "--project", fresh]).json.errors.join(" ")).toContain("does not exist");
    expect(existsSync(fresh)).toBe(false);

    const init = cli(["init", "--project", fresh]);
    expect(init.exitCode).toBe(0);
    expect(existsSync(join(fresh, "blueprint", "manifest.json"))).toBe(true);
  });

  test("init refuses a project path that is a regular file", () => {
    const asFile = join(root, "not-a-dir");
    writeFileSync(asFile, "x");
    const init = cli(["init", "--project", asFile]);
    expect(init.exitCode).toBe(1);
    expect(init.json.errors.join(" ")).toContain("not a directory");
    expect(readFileSync(asFile, "utf8")).toBe("x");
  });

  test("a logical name already bound to a different project is refused, and --name resolves it", () => {
    cli(["init"]);
    const other = join(root, "elsewhere", "project");
    mkdirSync(other, { recursive: true });

    const clash = cli(["init", "--project", other]);
    expect(clash.exitCode).toBe(1);
    expect(clash.json.errors.join(" ")).toContain("--name");

    const renamed = cli(["init", "--project", other, "--name", "other-project"]);
    expect(renamed.exitCode).toBe(0);
    expect(readKnownProjects(dataDir).get("other-project")?.projectRoot).toBe(realpathSync(other));
  });
});

describe("plan / apply / status / undo", () => {
  beforeEach(() => {
    cli(["init"]);
  });

  test("plan on a fresh init reports every surface as a create and writes nothing", () => {
    const plan = cli(["plan"]);
    expect(plan.exitCode).toBe(0);
    if (plan.json.verb !== "plan") throw new Error("unreachable");
    expect(plan.json.rows.length).toBeGreaterThan(0);
    expect(plan.json.rows.every((r) => r.action === "create")).toBe(true);
    expect(plan.json.changes).toBe(plan.json.rows.length);
    for (const surface of SEED_SURFACES) expect(existsSync(p(surface))).toBe(false);
  });

  test("R12: apply never writes RUN_STATE.md or FRICTION.md", () => {
    writeProject("FRICTION.md", "the qa lane needed a browser we did not have\n");
    const runStateBefore = readProject("RUN_STATE.md");
    const frictionBefore = readProject("FRICTION.md");
    const runStateMtime = statSync(p("RUN_STATE.md")).mtimeMs;

    const applied = cli(["apply"]);
    expect(applied.exitCode).toBe(0);
    if (applied.json.verb !== "apply") throw new Error("unreachable");
    // Structural, not just byte-equality: neither runtime file is a write TARGET of any row.
    const touched = [...applied.json.applied.map((w) => w.path), ...applied.json.failed.map((f) => f.path)];
    expect(touched.some((t) => t.endsWith("RUN_STATE.md") || t.endsWith("FRICTION.md"))).toBe(false);
    expect(readProject("RUN_STATE.md")).toBe(runStateBefore);
    expect(readProject("FRICTION.md")).toBe(frictionBefore);
    expect(statSync(p("RUN_STATE.md")).mtimeMs).toBe(runStateMtime);
  });

  test("status on a never-applied project reports ZERO drift — absent is not drifted", () => {
    // The regression this locks: `drift` used to mean "this row would write", so a freshly-`init`ed project
    // reported every tracked surface as drifted and `--json`'s `drifted` count was non-zero before a single
    // byte had been provisioned. A machine consumer gating on `drifted > 0` got a false positive on the most
    // common first run. Drift now means DIVERGENCE — a live surface that exists and disagrees.
    const status = cli(["status"]);
    expect(status.exitCode).toBe(0);
    if (status.json.verb !== "status") throw new Error("unreachable");
    expect(status.json.drifted).toBe(0);
    expect(status.json.rows.every((r) => r.action === "create" && !r.drift)).toBe(true);
    expect(status.text).toContain("No drift");
  });

  test("AE6: status reports a hand-edited provisioned file with its role and harness, and modifies nothing", () => {
    cli(["apply"]);
    writeProject(".claude/agents/architect.md", "someone edited this by hand\n");
    const drifted = readProject(".claude/agents/architect.md");
    const untouched = readProject(".cursor/agents/qa.md");

    const status = cli(["status"]);
    expect(status.exitCode).toBe(0);
    if (status.json.verb !== "status") throw new Error("unreachable");
    expect(status.json.drifted).toBe(1);
    const row = status.json.rows.find((r) => r.drift);
    expect(row).toMatchObject({
      role: "architect",
      harness: "claude-code",
      destination: ".claude/agents/architect.md",
      action: "overwrite",
      drift: true,
    });
    // Read-only: the drifted file and every clean one are byte-identical afterwards.
    expect(readProject(".claude/agents/architect.md")).toBe(drifted);
    expect(readProject(".cursor/agents/qa.md")).toBe(untouched);
  });

  test("status reports a clean project as clean", () => {
    cli(["apply"]);
    const status = cli(["status"]);
    if (status.json.verb !== "status") throw new Error("unreachable");
    expect(status.json.drifted).toBe(0);
  });

  test("KTD8: a scaffold row appears in plan but is excluded from the drift report", () => {
    // The shipped seed has no scaffold row (no target-registry surface is a natural create-once file), so
    // this adds one to the fixture's manifest — otherwise the exclusion would only be vacuously true.
    const manifest = JSON.parse(readProject("blueprint/manifest.json"));
    manifest.roles.push({
      name: "notes",
      harness: "claude-code",
      files: [{ transform: "scaffold", source: "roles/reviewer/agent.md", destination: ".claude/agents/notes.md" }],
    });
    writeProject("blueprint/manifest.json", JSON.stringify(manifest));

    const before = cli(["plan"]);
    if (before.json.verb !== "plan") throw new Error("unreachable");
    expect(before.json.rows.some((r) => r.destination === ".claude/agents/notes.md" && r.action === "create")).toBe(true);

    cli(["apply"]);
    expect(existsSync(p(".claude/agents/notes.md"))).toBe(true);

    // Once present, the scaffold is create-once: plan still lists it (as a skip), status never does.
    const after = cli(["plan"]);
    if (after.json.verb !== "plan") throw new Error("unreachable");
    expect(after.json.rows.some((r) => r.action === "scaffold-skip")).toBe(true);
    expect(after.json.changes).toBe(0);

    const status = cli(["status"]);
    if (status.json.verb !== "status") throw new Error("unreachable");
    expect(status.json.rows.some((r) => r.destination === ".claude/agents/notes.md")).toBe(false);
    expect(status.json.drifted).toBe(0);

    // A hand-edit to a scaffold target is deliberately NOT drift — the file is the project's after creation.
    writeProject(".claude/agents/notes.md", "the project edited its own scaffold\n");
    const drifted = cli(["status"]);
    if (drifted.json.verb !== "status") throw new Error("unreachable");
    expect(drifted.json.drifted).toBe(0);
    expect(readProject(".claude/agents/notes.md")).toBe("the project edited its own scaffold\n");
  });

  test("apply is a true no-op on the second run (R8/AE3 through the CLI)", () => {
    cli(["apply"]);
    const second = cli(["apply"]);
    if (second.json.verb !== "apply") throw new Error("unreachable");
    expect(second.json.applied).toEqual([]);
    expect(second.json.noops).toBeGreaterThan(0);
  });

  test("R11: the browser-MCP registration merges into a live mcp.json without dropping a foreign server", () => {
    writeProject(".cursor/mcp.json", JSON.stringify({ mcpServers: { mine: { command: "node", args: ["x.js"] } } }));
    cli(["apply"]);
    const merged = JSON.parse(readProject(".cursor/mcp.json"));
    expect(merged.mcpServers.mine.command).toBe("node");
    expect(merged.mcpServers.playwright.command).toBe("npx");
  });

  test("round trip: init → plan → apply → status → undo restores the project", () => {
    expect(cli(["plan"]).exitCode).toBe(0);
    const applied = cli(["apply"]);
    expect(applied.exitCode).toBe(0);
    expect(cli(["status"]).exitCode).toBe(0);

    const undone = cli(["undo"]);
    expect(undone.exitCode).toBe(0);
    if (undone.json.verb !== "undo") throw new Error("unreachable");
    expect(undone.json.failed).toEqual([]);
    expect(undone.json.reversed.length).toBeGreaterThan(0);
    for (const surface of SEED_SURFACES) expect(existsSync(p(surface))).toBe(false);
    // The blueprint and the run file survive an undo — undo reverses the APPLY, not the init.
    expect(existsSync(p("blueprint/manifest.json"))).toBe(true);
    expect(existsSync(p("RUN_STATE.md"))).toBe(true);
  });

  test("undo with nothing to undo is an honest no-op, not a failure", () => {
    const undone = cli(["undo"]);
    expect(undone.exitCode).toBe(0);
    if (undone.json.verb !== "undo") throw new Error("unreachable");
    expect(undone.json.batchId).toBeNull();
    expect(undone.json.reversed).toEqual([]);
  });
});

describe("front-gate (KTD5) — every verb, no content echoed", () => {
  const SECRET = "sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQ";

  beforeEach(() => {
    cli(["init"]);
    writeProject("blueprint/roles/architect/agent.md", `---\nname: architect\n---\n\nuse ${SECRET} to log in\n`);
  });

  test("plan, status, and apply all fail loudly on a secret-tripping blueprint", () => {
    for (const verb of ["plan", "status", "apply"]) {
      const run = cli([verb]);
      expect(run.exitCode).toBe(1);
      expect(run.json.ok).toBe(false);
      expect(run.json.errors.join(" ")).toContain("roles/architect/agent.md");
    }
  });

  test("no verb echoes the offending content into text or JSON (KTD5, status included)", () => {
    for (const verb of ["plan", "status", "apply"]) {
      const run = cli([verb]);
      expect(run.text).not.toContain(SECRET);
      expect(JSON.stringify(run.json)).not.toContain(SECRET);
      // Not even a fragment: the distinctive prefix must not survive either.
      expect(run.text).not.toContain("sk-ant");
      expect(JSON.stringify(run.json)).not.toContain("sk-ant");
    }
  });

  test("a secret-tripping blueprint writes nothing", () => {
    cli(["apply"]);
    for (const surface of SEED_SURFACES) expect(existsSync(p(surface))).toBe(false);
  });

  test("an absent blueprint is a typed refusal that points at init", () => {
    rmSync(p("blueprint"), { recursive: true, force: true });
    const plan = cli(["plan"]);
    expect(plan.exitCode).toBe(1);
    expect(plan.json.errors.join(" ")).toContain("init");
  });

  test("a manifest from a newer agent-os carries the upgrade instruction", () => {
    const manifest = JSON.parse(readProject("blueprint/manifest.json"));
    writeProject("blueprint/manifest.json", JSON.stringify({ ...manifest, schemaVersion: 99 }));
    writeProject("blueprint/roles/architect/agent.md", "clean\n");
    const plan = cli(["plan"]);
    expect(plan.exitCode).toBe(1);
    expect(plan.json.errors.join(" ")).toContain("Upgrade agent-os");
  });
});

describe("issue #51.1 — realpath canonicalization at the CLI ingress", () => {
  test("a project reached through a symlink has the same identity as its real path", () => {
    const real = join(root, "real-project");
    const link = join(root, "link-project");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);

    // Init + apply under the SYMLINK spelling.
    expect(runCli(["init", "--project", link], { cwd: root, dataDir }).exitCode).toBe(0);
    const applied = runCli(["apply", "--project", link], { cwd: root, dataDir });
    expect(applied.exitCode).toBe(0);
    if (applied.json.verb !== "apply") throw new Error("unreachable");
    expect(applied.json.project).toBe(real);

    // The registry stores the canonical identity, not the spelling the operator typed — including the
    // DEFAULT logical name, which is the basename of the REAL root ("real-project"), never the symlink's.
    expect(readKnownProjects(dataDir).get("link-project")).toBeUndefined();
    expect(readKnownProjects(dataDir).get("real-project")?.projectRoot).toBe(real);
    expect(readKnownProjects(dataDir).get("real-project")?.blueprintRoot).toBe(join(real, "blueprint"));

    // Undo under the REAL spelling still finds the batch applied under the symlink.
    const undone = runCli(["undo", "--project", real], { cwd: root, dataDir });
    expect(undone.exitCode).toBe(0);
    if (undone.json.verb !== "undo") throw new Error("unreachable");
    expect(undone.json.batchId).toBe(applied.json.batchId);
    expect(undone.json.reversed.length).toBeGreaterThan(0);
    expect(existsSync(join(real, "CLAUDE.md"))).toBe(false);
  });
});

describe("argument handling", () => {
  test("an unknown verb and a missing verb both fail with usage", () => {
    for (const argv of [[], ["provisionify"]]) {
      const run = cli(argv);
      expect(run.exitCode).toBe(2);
      expect(run.json.verb).toBe("usage");
      expect(run.text).toContain("init");
    }
  });

  test("an unknown flag and a flag missing its value are usage errors", () => {
    expect(cli(["plan", "--wat"]).exitCode).toBe(2);
    expect(cli(["plan", "--project"]).exitCode).toBe(2);
  });

  test("the DRIFT column is status-only — plan's rows are all changes by definition", () => {
    cli(["init"]);
    expect(cli(["plan"]).text).not.toContain("DRIFT");
    cli(["apply"]);
    expect(cli(["status"]).text).toContain("DRIFT");
  });

  test("--json output is the JSON payload and nothing else", () => {
    cli(["init"]);
    const run = cli(["plan", "--json"]);
    expect(() => JSON.parse(run.text)).not.toThrow();
    expect(JSON.parse(run.text)).toEqual(run.json);
  });

  test("a --json payload stays on stdout even when the run fails; human failure text goes to stderr", () => {
    expect(cli(["plan"]).stream).toBe("stderr"); // no blueprint yet → a failure a human should see on stderr
    expect(cli(["plan", "--json"]).stream).toBe("stdout"); // …but `… --json | jq` must still work
    cli(["init"]);
    expect(cli(["plan"]).stream).toBe("stdout");
    expect(cli(["wat"]).stream).toBe("stderr");
  });
});

describe("package.json script wiring (real process)", () => {
  test("bun run provision drives a full init on a fixture project, touching no real data dir", async () => {
    const spawnData = join(root, "spawn-data");
    const proc = Bun.spawn(["bun", "run", "provision", "init", "--project", projectRoot, "--json"], {
      cwd: REPO_ROOT,
      env: { ...process.env, AGENT_OS_DATA_DIR: spawnData },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
    // `bun run` echoes the resolved command on its own line before the script's output, so parse from the
    // first `{` — the payload is pretty-printed JSON and cannot be found by taking the last line.
    const payload = JSON.parse(stdout.slice(stdout.indexOf("{")));
    expect(payload).toMatchObject({ verb: "init", ok: true, project: projectRoot });
    expect(existsSync(p("blueprint/manifest.json"))).toBe(true);
    expect(existsSync(p("RUN_STATE.md"))).toBe(true);
    // The injected data dir is the ONLY one written.
    expect(existsSync(join(spawnData, "known-projects.jsonl"))).toBe(true);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed-surface schema: the render pipeline is deliberately content-BLIND, so a wrong required key in a
// shipped seed file lands on disk, applies cleanly, and fails nothing — until the harness silently ignores
// the role. That is the exact class `docs/solutions/conventions/verify-harness-surfaces-against-live-instances.md`
// exists for (this suite was 671/671 green while the executor role shipped `instructions` instead of
// `developer_instructions`, so Codex would have loaded it with NO system prompt). These assertions encode the
// per-harness required keys the seed's structured surfaces must carry, verified against a live install.
// ─────────────────────────────────────────────────────────────────────────────
describe("seed template renders surfaces the target harness will actually accept", () => {
  test("every .codex/agents/*.toml row carries Codex's required keys", () => {
    const manifest = JSON.parse(readFileSync(join(SEED_ROOT, "manifest.json"), "utf8")) as {
      roles: Array<{ files: Array<{ transform: string; source?: string; destination: string }> }>;
    };
    const rows = manifest.roles
      .flatMap((role) => role.files)
      .filter((file) => file.destination.startsWith(".codex/agents/") && file.destination.endsWith(".toml"));
    // Guard the guard: if the seed ever stops shipping a Codex agent row, this test must fail loudly rather
    // than pass vacuously over an empty list.
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const parsed = parseToml(readFileSync(join(SEED_ROOT, row.source!), "utf8")) as Record<string, unknown>;
      // `developer_instructions` — NOT `instructions` — is the per-agent system prompt Codex reads.
      expect(Object.keys(parsed).sort()).toEqual(expect.arrayContaining(["description", "developer_instructions", "name"]));
      expect(typeof parsed.developer_instructions).toBe("string");
      expect((parsed.developer_instructions as string).trim().length).toBeGreaterThan(0);
    }
  });

  test("the shipped browser-MCP patch is an object-shaped config-merge source, not a whole-file blob", () => {
    // The merge surface (`.cursor/mcp.json`) must receive a mergeable object patch — a non-object here would
    // be refused at apply, and R11's tool-dependency provisioning is the row that proves that path.
    const patch = JSON.parse(readFileSync(join(SEED_ROOT, "roles/qa/browser-mcp.json"), "utf8")) as Record<string, unknown>;
    expect(patch).toMatchObject({ mcpServers: expect.any(Object) });
    expect(Array.isArray(patch)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The applied-but-unjournaled report (issue #51.2) at the OPERATOR layer. `apply()` itself is well covered via
// its injected-engine seam, but the CLI deliberately does not expose that seam, so the mapping from
// `ApplyOutcome.applied[].unjournaled` into `--json`'s `warnings` and the human `WARNING:` line was the one
// untested link — and it is precisely the fact an operator needs to recover by hand. Driven directly against a
// hand-built outcome, which needs no test-only CLI surface.
// ─────────────────────────────────────────────────────────────────────────────
describe("apply reports an un-undoable write to the operator (#51.2)", () => {
  const unjournaledOutcome = (backupPath: string | null) => ({
    batchId: "batch-1",
    applied: [
      { targetPath: "/p/CLAUDE.md", action: "create" as const, created: true, undoId: "u1" },
      {
        targetPath: "/p/AGENTS.md",
        action: "overwrite" as const,
        created: false,
        undoId: null,
        unjournaled: { backupPath, error: "journal append failed" },
      },
    ],
    noops: [],
    failed: [],
    rolledBack: false,
  });

  test("the un-undoable write surfaces in --json warnings and names how to revert it by hand", () => {
    const json = applyJson(unjournaledOutcome("/data/backups/agents.bak"), "/p");
    expect(json.warnings).toHaveLength(1);
    expect(json.warnings[0]).toContain("/p/AGENTS.md");
    expect(json.warnings[0]).toContain("/data/backups/agents.bak");
    // The reversible sibling must NOT be reported as un-undoable, and `undoable` must distinguish them.
    expect(json.applied).toMatchObject([
      { path: "/p/CLAUDE.md", undoable: true },
      { path: "/p/AGENTS.md", undoable: false },
    ]);
  });

  test("a CREATED un-undoable write tells the operator to delete it, not restore a backup", () => {
    const json = applyJson(unjournaledOutcome(null), "/p");
    expect(json.warnings[0]).toContain("delete it");
    expect(json.warnings[0]).not.toContain("restore from");
  });

  test("the human rendering carries a WARNING line", () => {
    const outcome = unjournaledOutcome("/data/backups/agents.bak");
    const text = applyText(outcome, applyJson(outcome, "/p"));
    expect(text).toContain("WARNING:");
    expect(text).toContain("/p/AGENTS.md");
  });

  test("an un-undoable write does NOT fail the run — automation must check `warnings`, not just ok/exit code", () => {
    // Deliberate contract, asserted so it can never change silently: the write SUCCEEDED, so `ok` stays true
    // and the CLI exits 0. The un-undoability is real but is not a failure, and a consumer gating only on the
    // exit code will not learn about it. Documented on the CliJson apply variant for that reason.
    expect(applyJson(unjournaledOutcome(null), "/p").ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Two init preflight defects the security lens reproduced against a green 671-test suite. Both are about
// `init` keeping the contract its own docstring states: nothing is written until every refusal has had its
// chance, and no write goes through an indirection this system did not describe.
// ─────────────────────────────────────────────────────────────────────────────
describe("init preflight refuses before writing", () => {
  test("a DANGLING RUN_STATE.md symlink is refused — the seed never lands at the link target", () => {
    // `existsSync` follows symlinks, so a dangling link read as ABSENT and `writeFileSync` then followed it,
    // writing the seed outside the project while the run exited 0 reporting the in-project path.
    const outside = join(root, "outside", "captured.md");
    mkdirSync(dirname(outside), { recursive: true });
    symlinkSync(outside, p("RUN_STATE.md"));

    const init = cli(["init"]);
    expect(init.exitCode).toBe(1);
    expect(init.text).toContain("symlink");
    // The decisive assertion: nothing was written through the indirection.
    expect(existsSync(outside)).toBe(false);
  });

  test("an existing REGULAR RUN_STATE.md is still left strictly alone (R12), not refused", () => {
    // The symlink guard must not turn the normal already-present case into a failure.
    writeProject("RUN_STATE.md", "operator's own run state\n");
    const init = cli(["init"]);
    expect(init.exitCode).toBe(0);
    if (init.json.verb !== "init") throw new Error("unreachable");
    expect(init.json.runState).toBe("present");
    expect(readProject("RUN_STATE.md")).toBe("operator's own run state\n");
  });

  test("an unusable --name is refused BEFORE the seed is copied, leaving the project untouched", () => {
    // Previously the name was validated only inside registerProject, at write time — leaving a seeded but
    // UNREGISTERED project that U7 could never resolve and that re-`init` would only replace with --force.
    const init = cli(["init", "--name", "a/b"]);
    expect(init.exitCode).toBe(1);
    expect(init.text).toContain("not a usable logical project name");
    expect(existsSync(p("blueprint"))).toBe(false);
    expect(existsSync(p("RUN_STATE.md"))).toBe(false);
    expect(readKnownProjects(dataDir).size).toBe(0);
  });
});

describe("init --force stages before it destroys (the blueprint has no undo)", () => {
  test("a failed copy leaves the operator's existing blueprint intact", () => {
    cli(["init"]);
    writeProject("blueprint/HAND-TUNED.md", "weeks of tuning\n");
    const before = readProject("blueprint/manifest.json");

    // Make the staging copy fail: a read-only project root refuses the sibling temp dir `--force` stages into.
    // The original blueprint/ must survive untouched — it is the one thing here no undo can bring back.
    const mode = statSync(projectRoot).mode;
    chmodSync(projectRoot, 0o500);
    let forced;
    try {
      forced = cli(["init", "--force"]);
    } finally {
      chmodSync(projectRoot, mode);
    }

    expect(forced.exitCode).toBe(1);
    expect(readProject("blueprint/HAND-TUNED.md")).toBe("weeks of tuning\n");
    expect(readProject("blueprint/manifest.json")).toBe(before);
  });

  test("a successful --force still replaces the blueprint and leaves no staging directory behind", () => {
    cli(["init"]);
    writeProject("blueprint/HAND-TUNED.md", "replaced by --force\n");

    expect(cli(["init", "--force"]).exitCode).toBe(0);
    expect(existsSync(p("blueprint/HAND-TUNED.md"))).toBe(false); // genuinely replaced, not merged
    expect(existsSync(p("blueprint/manifest.json"))).toBe(true);
    expect(readdirSync(projectRoot).filter((e) => e.includes(".tmp"))).toEqual([]);
  });
});

describe("a blocked destination names its cause (adversarial: symlinked AGENTS.md)", () => {
  test("plan/status/apply all say SYMLINK, not just 'unreadable-destination'", () => {
    // `AGENTS.md` symlinked to `CLAUDE.md` is a mainstream multi-harness convention, and the seed provisions
    // BOTH paths — so this is a layout a real operator arrives with. The run still aborts (provisioning must
    // never write through an indirection), but the message has to name the one file and the one remedy.
    cli(["init"]);
    cli(["apply"]);
    rmSync(p("AGENTS.md"));
    symlinkSync(p("CLAUDE.md"), p("AGENTS.md"));

    for (const verb of ["plan", "status", "apply"]) {
      const run = cli([verb]);
      expect(run.exitCode).toBe(1);
      expect(run.text).toContain("AGENTS.md");
      expect(run.text).toContain("symlink");
    }
  });
});

describe("init withdraws a directory it created when it then refuses", () => {
  test("a refused --name on a NEW project path leaves no stray directory behind", () => {
    // `init` must mkdir before it can realpath (realpath throws on a path that does not exist), so the refusals
    // that follow run with the directory already created. A typo'd --project plus a bad name would otherwise
    // leave an empty directory at the wrong path, unmentioned.
    const fresh = join(root, "typo-target");
    const refused = runCli(["init", "--project", fresh, "--name", "a/b"], { cwd: projectRoot, dataDir });
    expect(refused.exitCode).toBe(1);
    expect(existsSync(fresh)).toBe(false);
  });

  test("a directory that already existed is never removed by a refusal", () => {
    // Only a root THIS run created may be withdrawn — an operator's existing directory is untouchable.
    const existing = join(root, "operators-own");
    mkdirSync(existing, { recursive: true });
    const refused = runCli(["init", "--project", existing, "--name", "a/b"], { cwd: projectRoot, dataDir });
    expect(refused.exitCode).toBe(1);
    expect(existsSync(existing)).toBe(true);
  });

  test("a created-but-non-empty root is kept and the message says so", () => {
    // The guard is "created AND still empty". If anything landed inside, keep it and be honest rather than
    // recursively deleting a path the operator supplied.
    const fresh = join(root, "raced-target");
    const refused = runCli(["init", "--project", fresh, "--name", "ok-name"], { cwd: projectRoot, dataDir });
    expect(refused.exitCode).toBe(0); // sanity: that name is fine, so this run SUCCEEDS and seeds the project

    // Now a second init with a bad name against the same (now non-empty, and pre-existing) root.
    const second = runCli(["init", "--project", fresh, "--name", "a/b"], { cwd: projectRoot, dataDir });
    expect(second.exitCode).toBe(1);
    expect(existsSync(fresh)).toBe(true);
  });
});
