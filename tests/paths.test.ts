import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, machineIdPath, resolveMachineId, resolvePort } from "../src/paths";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paths-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveMachineId", () => {
  test("mints an opaque UUID on first call, persists it, and is stable across calls", () => {
    const first = resolveMachineId(root);
    expect(first).toMatch(/^[0-9a-f-]{36}$/); // a UUID, not os.hostname()
    expect(readFileSync(machineIdPath(root), "utf8").trim()).toBe(first); // persisted to disk
    expect(resolveMachineId(root)).toBe(first); // stable — a later boot returns the same id
  });

  test("persists the machine-id file 0600", () => {
    resolveMachineId(root);
    expect(statSync(machineIdPath(root)).mode & 0o777).toBe(0o600);
  });

  test("re-mints over a MALFORMED file, and the rewrite is 0600 even over a looser prior mode", () => {
    writeFileSync(machineIdPath(root), "garbage-not-a-uuid", { mode: 0o644 });
    const id = resolveMachineId(root);
    expect(id).toMatch(/^[0-9a-f-]{36}$/); // a fresh UUID, not the garbage
    expect(readFileSync(machineIdPath(root), "utf8").trim()).toBe(id); // garbage overwritten
    expect(statSync(machineIdPath(root)).mode & 0o777).toBe(0o600); // atomic rename tightened it to 0600
  });

  test("re-mints when the persisted file is empty", () => {
    writeFileSync(machineIdPath(root), "", { mode: 0o600 });
    expect(resolveMachineId(root)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("resolvePort", () => {
  let prevPort: string | undefined;
  beforeEach(() => {
    prevPort = process.env.AGENT_OS_PORT;
    delete process.env.AGENT_OS_PORT;
  });
  afterEach(() => {
    if (prevPort === undefined) delete process.env.AGENT_OS_PORT;
    else process.env.AGENT_OS_PORT = prevPort;
  });

  test("unset -> DEFAULT_PORT", () => {
    expect(resolvePort()).toBe(DEFAULT_PORT);
  });

  test("a valid numeric string is used", () => {
    process.env.AGENT_OS_PORT = "3000";
    expect(resolvePort()).toBe(3000);
  });

  test.each(["abc", "0", "-1", "70000", "1.5", ""])("invalid shape %p falls back to DEFAULT_PORT", (value) => {
    process.env.AGENT_OS_PORT = value;
    expect(resolvePort()).toBe(DEFAULT_PORT);
  });
});
