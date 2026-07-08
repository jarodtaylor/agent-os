import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeCode, uninstallClaudeCode } from "../src/install/claude-code";

// Fixture-home ONLY — every path is under a temp dir, so these tests never touch the real ~/.claude.
const REPO = "/repo"; // injected repoRoot ⇒ deterministic command strings
const START_CMD = `bun run "${REPO}/hooks/session-start.ts"`;
const END_CMD = `bun run "${REPO}/hooks/session-end.ts"`;
const MCP_CMD = `bun run "${REPO}/hooks/mcp-headers.ts"`;

let root: string;
let home: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "install-"));
  home = join(root, "home");
  dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const settingsPath = () => join(home, ".claude", "settings.json");
const claudeJsonPath = () => join(home, ".claude.json");
// JSON configs are untyped fixtures; `any` navigation keeps the assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const install = () => installClaudeCode({ home, dataDir, repoRoot: REPO, port: 4319 });

describe("installClaudeCode", () => {
  test("fresh install writes both files with the expected structure", () => {
    const res = install();
    expect(res.settings.created).toBe(true);
    expect(res.mcp.created).toBe(true);

    const s = readJson(settingsPath());
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].matcher).toBe("startup|resume|clear");
    expect(s.hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: START_CMD, timeout: 10 });
    expect(s.hooks.SessionEnd).toHaveLength(1);
    expect(s.hooks.SessionEnd[0].matcher).toBeUndefined(); // fires on every end reason
    expect(s.hooks.SessionEnd[0].hooks[0].command).toBe(END_CMD);

    const j = readJson(claudeJsonPath());
    expect(j.mcpServers["agent-os"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:4319/mcp",
      headersHelper: MCP_CMD,
    });
  });

  test("refuses to install over a corrupt settings.json, and never touches claude.json", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{ not json");
    expect(() => install()).toThrow(/not valid JSON/);
    // The pre-flight parse of settings.json fails FIRST — claude.json is never even reached.
    expect(existsSync(claudeJsonPath())).toBe(false);
  });

  test("rolls back the settings write when the MCP-config write fails (cross-file transactional)", () => {
    // ~/.claude.json is a symlink → the U14 engine refuses to write it (fail-closed), but only AT WRITE time
    // — after settings.json has already committed. The installer must undo the settings write so a failed
    // install never leaves the hooks live without the MCP server.
    symlinkSync(join(root, "nonexistent-target.json"), claudeJsonPath());
    expect(existsSync(settingsPath())).toBe(false);

    expect(() => install()).toThrow();
    // Rolled back: the settings.json the installer created is gone — no partial (hooks-only) install remains.
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("merge preserves the user's existing hooks and unrelated keys (array read-modify-write)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify(
        {
          permissions: { allow: ["Bash(ls:*)"] },
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo existing-user-hook" }] }],
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
          },
        },
        null,
        2,
      ) + "\n",
    );

    install();
    const s = readJson(settingsPath());
    // The user's SessionStart entry survives; ours is appended (not clobbered — the whole array is rewritten).
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("echo existing-user-hook");
    expect(s.hooks.SessionStart[1].hooks[0].command).toBe(START_CMD);
    // A different hook event and non-hook keys are untouched.
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("guard.sh");
    expect(s.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  test("the two files do not cross-contaminate", () => {
    install();
    const s = readJson(settingsPath());
    const j = readJson(claudeJsonPath());
    expect(s.hooks).toBeDefined();
    expect(s.mcpServers).toBeUndefined();
    expect(j.mcpServers).toBeDefined();
    expect(j.hooks).toBeUndefined();
  });

  test("preserves an existing sibling mcpServers entry in ~/.claude.json", () => {
    writeFileSync(
      claudeJsonPath(),
      JSON.stringify({ mcpServers: { "other-server": { type: "http", url: "http://127.0.0.1:9999/mcp" } } }, null, 2) + "\n",
    );

    install();

    const j = readJson(claudeJsonPath());
    expect(j.mcpServers["other-server"]).toEqual({ type: "http", url: "http://127.0.0.1:9999/mcp" });
    expect(j.mcpServers["agent-os"]).toBeDefined();
  });

  test("re-install is idempotent — no duplicate entries, engine no-ops", () => {
    install();
    const res2 = install();
    expect(res2.settings.noop).toBe(true);
    expect(res2.mcp.noop).toBe(true);
    expect(readJson(settingsPath()).hooks.SessionStart).toHaveLength(1);
  });

  test("uninstall restores both files from backup (byte-exact restore, created file deleted)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ permissions: { allow: ["X"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }] } }, null, 2) + "\n",
    );
    const before = readFileSync(settingsPath(), "utf8");
    expect(existsSync(claudeJsonPath())).toBe(false);

    install();
    expect(readFileSync(settingsPath(), "utf8")).not.toBe(before); // our entry was merged in
    expect(existsSync(claudeJsonPath())).toBe(true); // created by install

    const restored = uninstallClaudeCode({ home, dataDir });
    // Pre-existing file → restored byte-for-byte; created file → deleted (back to absent).
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
    expect(existsSync(claudeJsonPath())).toBe(false);
    expect(restored).toContain(settingsPath());
    expect(restored).toContain(claudeJsonPath());
  });

  test("uninstall tolerates a claude.json that diverged since install — settings.json still restores", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ permissions: { allow: ["X"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }] } }, null, 2) + "\n",
    );
    const before = readFileSync(settingsPath(), "utf8");

    install();

    // Simulate Claude Code's own continuous rewrites of its live-state file between install and uninstall.
    const j = readJson(claudeJsonPath());
    writeFileSync(claudeJsonPath(), JSON.stringify({ ...j, numStartups: 99 }, null, 2) + "\n");

    expect(() => uninstallClaudeCode({ home, dataDir })).not.toThrow();
    // settings.json never diverged → its undo still succeeds, byte-exact.
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
    // claude.json diverged → its undo is skipped (identity check), not deleted.
    expect(existsSync(claudeJsonPath())).toBe(true);
  });
});
