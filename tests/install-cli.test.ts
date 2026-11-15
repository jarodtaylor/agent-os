import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/install/cli";

// Fixture-home ONLY — `home` + `dataDir` are injected temp dirs, so no test here touches the real configs.
// The one spawn test exercises ONLY the usage path (exit 2 before any installer runs).
let root: string;
let ctx: { home: string; dataDir: string };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "install-cli-"));
  ctx = { home: join(root, "home"), dataDir: join(root, "data") };
  mkdirSync(ctx.home, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mcpServers = () => JSON.parse(readFileSync(join(ctx.home, ".claude.json"), "utf8")).mcpServers ?? {};

describe("integrate CLI", () => {
  test("install with no target installs both harnesses; re-run reports every target unchanged", () => {
    const first = runCli(["install"], ctx);
    expect(first.exitCode).toBe(0);
    expect(first.errors).toEqual([]);
    expect(first.lines.filter((l) => l.startsWith("[claude-code]"))).toHaveLength(2);
    expect(first.lines.filter((l) => l.startsWith("[codex]"))).toHaveLength(3);
    expect(first.lines.every((l) => l.endsWith(": written"))).toBe(true);
    expect(mcpServers()["agent-os"]).toBeDefined();

    const second = runCli(["install"], ctx);
    expect(second.exitCode).toBe(0);
    expect(second.lines.every((l) => l.endsWith(": unchanged"))).toBe(true);
  });

  test("a named target installs only that harness", () => {
    const r = runCli(["install", "claude-code"], ctx);
    expect(r.exitCode).toBe(0);
    expect(r.lines.every((l) => l.startsWith("[claude-code]"))).toBe(true);
    expect(() => readFileSync(join(ctx.home, ".codex", "config.toml"))).toThrow();
  });

  test("output never echoes config content (the Codex credential)", () => {
    const r = runCli(["install", "codex"], ctx);
    const toml = readFileSync(join(ctx.home, ".codex", "config.toml"), "utf8");
    const token = toml.match(/"([A-Za-z0-9_-]{24,})"/)?.[1];
    expect(token).toBeDefined();
    expect([...r.lines, ...r.errors].join("\n")).not.toContain(token!);
  });

  test("one harness failing still runs the other and exits 1", () => {
    writeFileSync(join(ctx.home, ".claude.json"), "{not json");
    const r = runCli(["install"], ctx);
    expect(r.exitCode).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toStartWith("[claude-code] install failed:");
    expect(r.lines.filter((l) => l.startsWith("[codex]"))).toHaveLength(3);
  });

  test("uninstall removes what install added and reports per harness", () => {
    runCli(["install"], ctx);
    const r = runCli(["uninstall"], ctx);
    expect(r.exitCode).toBe(0);
    expect(r.lines.some((l) => l.startsWith("[claude-code] removed:") && !l.endsWith("(nothing)"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("[codex] removed:") && !l.endsWith("(nothing)"))).toBe(true);
    expect(mcpServers()["agent-os"]).toBeUndefined();
  });

  test.each([[[]], [["status"]], [["install", "cursor"]], [["install", "codex", "extra"]]])("bad argv %p ⇒ usage, exit 2", (argv) => {
    const r = runCli(argv as string[], ctx);
    expect(r.exitCode).toBe(2);
    expect(r.errors[0]).toStartWith("usage:");
  });

  test("package.json wires `bun run integrate` (usage path only — never installs)", async () => {
    const proc = Bun.spawn(["bun", "run", "integrate"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("usage: bun run integrate");
  });
});
