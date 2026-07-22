import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCli } from "../src/provision/cli";
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
