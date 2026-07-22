import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isLogicalProjectName,
  knownProjectsPath,
  lookupProject,
  readKnownProjects,
  registerProject,
} from "../src/provision/registry";

// Fixture-only: the registry file lives under an injected temp dataDir, never the real one.
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "provision-registry-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const record = (name: string, root: string) => ({
  name,
  projectRoot: root,
  blueprintRoot: join(root, "blueprint"),
});

describe("known-projects registry", () => {
  test("registers a project and resolves it back by its logical name", () => {
    const outcome = registerProject(dataDir, record("agent-os", "/p/agent-os"));
    expect(outcome.kind).toBe("registered");

    const found = lookupProject("agent-os", dataDir);
    expect(found.kind).toBe("found");
    if (found.kind !== "found") throw new Error("unreachable");
    expect(found.record.projectRoot).toBe("/p/agent-os");
    expect(found.record.blueprintRoot).toBe("/p/agent-os/blueprint");
  });

  test("an unknown name is a typed refusal, not a path", () => {
    registerProject(dataDir, record("agent-os", "/p/agent-os"));
    const missing = lookupProject("not-registered", dataDir);
    expect(missing).toEqual({ kind: "unknown", name: "not-registered" });
  });

  test("re-registering the same project root is idempotent (re-init)", () => {
    registerProject(dataDir, record("agent-os", "/p/agent-os"));
    const again = registerProject(dataDir, record("agent-os", "/p/agent-os"));
    expect(again.kind).toBe("registered");
    expect(readKnownProjects(dataDir).size).toBe(1);
  });

  test("a name already bound to a DIFFERENT root is refused, never silently rebound", () => {
    registerProject(dataDir, record("api", "/p/one/api"));
    const clash = registerProject(dataDir, record("api", "/p/two/api"));
    expect(clash.kind).toBe("conflict");
    if (clash.kind !== "conflict") throw new Error("unreachable");
    expect(clash.existing.projectRoot).toBe("/p/one/api");

    // The original binding survives the refusal.
    const found = lookupProject("api", dataDir);
    expect(found.kind === "found" && found.record.projectRoot).toBe("/p/one/api");
  });

  test("names that could become path segments are refused at ingress", () => {
    for (const bad of ["", " ", ".", "..", "a/b", "a\\b", "a\0b", "x".repeat(200)]) {
      expect(isLogicalProjectName(bad)).toBe(false);
      expect(registerProject(dataDir, record(bad, "/p/x")).kind).toBe("invalid-name");
    }
    for (const good of ["agent-os", "my_project", "Proj.2", "a"]) {
      expect(isLogicalProjectName(good)).toBe(true);
    }
  });

  test("malformed and torn lines are skipped; good records around them survive", () => {
    registerProject(dataDir, record("first", "/p/first"));
    appendFileSync(knownProjectsPath(dataDir), '{"name":"broken"\n{not json at all\n');
    appendFileSync(knownProjectsPath(dataDir), `${JSON.stringify({ name: "bad", projectRoot: 7 })}\n`);
    registerProject(dataDir, record("second", "/p/second"));

    const all = readKnownProjects(dataDir);
    expect([...all.keys()].sort()).toEqual(["first", "second"]);
  });

  test("an absent registry file reads as empty, never a throw", () => {
    expect(readKnownProjects(join(dataDir, "nope")).size).toBe(0);
    expect(lookupProject("anything", join(dataDir, "nope"))).toEqual({ kind: "unknown", name: "anything" });
  });

  test("a later record for the same name wins (rebind after a hand edit)", () => {
    registerProject(dataDir, record("api", "/p/one/api"));
    // Simulate a hand-repaired registry: append a newer record directly.
    appendFileSync(
      knownProjectsPath(dataDir),
      `${JSON.stringify({ name: "api", projectRoot: "/p/two/api", blueprintRoot: "/p/two/api/blueprint", ts: Date.now() + 1 })}\n`,
    );
    const found = lookupProject("api", dataDir);
    expect(found.kind === "found" && found.record.projectRoot).toBe("/p/two/api");
  });

  test("the registry file is owner-only and lands beside the other data-dir files", () => {
    registerProject(dataDir, record("agent-os", "/p/agent-os"));
    expect(knownProjectsPath(dataDir)).toBe(join(dataDir, "known-projects.jsonl"));
    expect(readFileSync(knownProjectsPath(dataDir), "utf8").trim().split("\n")).toHaveLength(1);
    // The "owner-only" half of this test's own name: assert the modes rather than implying them, so a refactor
    // that drops the `mode` options is caught. 0600 file in a 0700 dir — the undo journal's discipline, and
    // these records name the operator's real project paths.
    expect(statSync(knownProjectsPath(dataDir)).mode & 0o777).toBe(0o600);

    // The DIRECTORY mode must be proven on a dir `registerProject` itself creates: asserting it on `dataDir`
    // would be tautological, since `mkdtempSync` already makes 0700 and the assertion would hold even if the
    // writer dropped its `mode` option entirely.
    const nested = join(dataDir, "fresh", "data");
    registerProject(nested, record("nested", "/p/nested"));
    expect(statSync(nested).mode & 0o777).toBe(0o700);
    expect(statSync(knownProjectsPath(nested)).mode & 0o777).toBe(0o600);
  });

  test("a torn final line does not corrupt the next append", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(knownProjectsPath(dataDir), '{"name":"torn","projectRo');
    registerProject(dataDir, record("clean", "/p/clean"));
    const all = readKnownProjects(dataDir);
    expect([...all.keys()]).toEqual(["clean"]);
  });
});
