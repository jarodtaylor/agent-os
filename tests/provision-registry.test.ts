import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchStatusPath, readBatchStatuses, recordBatchStatus } from "../src/provision/batch-status";
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

    // Strengthened for the one-byte tail probe: assert the BYTES, not just the parse. The probe now decides
    // "does this file end in a newline" from a positional read of the final byte alone, so pin what that
    // decision produced — the torn fragment isolated on its own row, the new record whole on the next.
    const lines = readFileSync(knownProjectsPath(dataDir), "utf8").split("\n");
    expect(lines[0]).toBe('{"name":"torn","projectRo');
    expect(JSON.parse(lines[1] ?? "").name).toBe("clean");
  });

  test("an append onto a newline-terminated file adds no spurious blank line", () => {
    registerProject(dataDir, record("first", "/p/first"));
    registerProject(dataDir, record("second", "/p/second"));
    // Two records, one trailing newline, nothing between them: the probe read a 0x0a last byte and led with "".
    expect(readFileSync(knownProjectsPath(dataDir), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("an EMPTY sidecar gets no lead newline (there is no torn line to isolate)", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(knownProjectsPath(dataDir), "");
    registerProject(dataDir, record("first", "/p/first"));
    const raw = readFileSync(knownProjectsPath(dataDir), "utf8");
    expect(raw.startsWith("\n")).toBe(false);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
  });
});

/**
 * The bounded-read boundary (decision #45: attacker-owns-HOME is out of scope BEYOND bounded-read/no-hang, so
 * these two are IN scope). Both sidecar readers are total by contract and their callers depend on that, so every
 * hostile shape below must degrade to "no records" — never a throw, never a hang, never an unbounded load.
 */
describe("provision sidecars are read under bounds, never blocking", () => {
  test("a FIFO at the registry path reads as no known projects instead of blocking forever", () => {
    // A named pipe with no writer: a bare `readFileSync` blocks the process until a writer appears, which is
    // never. The reader's stat-before-read refuses it as a non-regular file WITHOUT opening the pipe — so this
    // test COMPLETING at all is the proof it cannot hang (the same proof shape as configwrite's FIFO test).
    // POSIX-only (mkfifo); this repo targets macOS/Linux. The bun timeout below is belt-and-braces: a truly
    // synchronous block cannot be preempted by a timer, so completion, not the timeout, is what proves it.
    const fifo = knownProjectsPath(dataDir);
    execFileSync("mkfifo", [fifo]);
    try {
      expect(readKnownProjects(dataDir).size).toBe(0);
      expect(lookupProject("anything", dataDir)).toEqual({ kind: "unknown", name: "anything" });
    } finally {
      rmSync(fifo, { force: true }); // unlink the pipe (never opened) so afterEach's recursive rm is clean
    }
  }, 5_000);

  test("a FIFO at the batch-status path reads as unknown-everywhere instead of blocking forever", () => {
    const fifo = batchStatusPath(dataDir);
    execFileSync("mkfifo", [fifo]);
    try {
      expect(readBatchStatuses(dataDir).size).toBe(0); // unknown ⇒ eligible: the fail-safe direction, preserved
    } finally {
      rmSync(fifo, { force: true });
    }
  }, 5_000);

  test("writing to a FIFO sidecar is refused, not blocked, and reported to the caller", () => {
    // The write half of the same hazard: `appendFileSync` on a FIFO blocks opening it for write until a reader
    // appears. The append refuses a non-regular target before any open-for-write, and `registerProject` surfaces
    // that as a typed `write-failed` — a load-bearing write must never fail silently.
    const fifo = knownProjectsPath(dataDir);
    execFileSync("mkfifo", [fifo]);
    try {
      const outcome = registerProject(dataDir, record("agent-os", "/p/agent-os"));
      expect(outcome.kind).toBe("write-failed");
      if (outcome.kind !== "write-failed") throw new Error("unreachable");
      expect(outcome.error).toMatch(/not a regular file/);
    } finally {
      rmSync(fifo, { force: true });
    }
  }, 5_000);

  test("an oversized registry file is refused rather than loaded into memory", () => {
    // Sparse: `truncateSync` sets the size without writing 16 MiB of blocks, so the cap is exercised against a
    // real oversized `stat().size` at no I/O cost. One byte over the shared 16 MiB ceiling.
    const path = knownProjectsPath(dataDir);
    registerProject(dataDir, record("agent-os", "/p/agent-os"));
    expect(readKnownProjects(dataDir).size).toBe(1); // the same file resolves fine while it is in bounds
    truncateSync(path, 16 * 1024 * 1024 + 1);
    expect(readKnownProjects(dataDir).size).toBe(0); // over the cap ⇒ refused ⇒ every lookup refuses
  });

  test("an oversized batch-status file is refused, leaving every batch eligible (the fail-safe direction)", () => {
    recordBatchStatus(dataDir, "batch-1", "/p/agent-os", "rolled-back");
    expect(readBatchStatuses(dataDir).size).toBe(1);
    truncateSync(batchStatusPath(dataDir), 16 * 1024 * 1024 + 1);
    // Refusing must land on "unknown everywhere" — which keeps every batch ELIGIBLE for default undo. An
    // oversized status file must never be able to hide a batch from `undo`.
    expect(readBatchStatuses(dataDir).size).toBe(0);
  });

  test("a directory at either sidecar path reads as empty, never a throw", () => {
    mkdirSync(knownProjectsPath(dataDir), { recursive: true });
    mkdirSync(batchStatusPath(dataDir), { recursive: true });
    expect(readKnownProjects(dataDir).size).toBe(0);
    expect(readBatchStatuses(dataDir).size).toBe(0);
  });
});
