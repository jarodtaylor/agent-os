import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeCode, uninstallClaudeCode } from "../src/install/claude-code";
import type { UninstallOutcome } from "../src/install/shared";

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

  test("uninstall strips only our hooks + MCP entry, preserving the user's config (targeted removal, not whole-file restore)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ permissions: { allow: ["X"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }] } }, null, 2) + "\n",
    );
    // claude.json PRE-EXISTS with CC's own live state + a foreign MCP server — the realistic case (CC owns it).
    writeFileSync(
      claudeJsonPath(),
      JSON.stringify({ numStartups: 7, mcpServers: { other: { type: "http", url: "http://127.0.0.1:9999/mcp" } } }, null, 2) + "\n",
    );

    install();
    expect(readJson(settingsPath()).hooks.SessionStart).toHaveLength(2); // user's + ours
    expect(readJson(claudeJsonPath()).mcpServers["agent-os"]).toBeDefined();

    const { removed } = uninstallClaudeCode({ home, dataDir, repoRoot: REPO });

    // settings.json: our hook entries are gone; the user's hook and non-hook keys survive.
    const s = readJson(settingsPath());
    const startCmds = s.hooks.SessionStart.flatMap((e: { hooks?: Array<{ command: string }> }) => (e.hooks ?? []).map((x) => x.command));
    expect(startCmds).not.toContain(START_CMD);
    expect(startCmds).toContain("echo user");
    expect(s.permissions).toEqual({ allow: ["X"] });
    // claude.json: only our server is removed; CC's live state and the foreign server are untouched.
    const j = readJson(claudeJsonPath());
    expect(j.mcpServers["agent-os"]).toBeUndefined();
    expect(j.mcpServers.other).toEqual({ type: "http", url: "http://127.0.0.1:9999/mcp" });
    expect(j.numStartups).toBe(7);
    expect(removed).toContain(settingsPath());
    expect(removed).toContain(claudeJsonPath());
  });

  test("uninstall on a DIVERGED claude.json now SUCCEEDS — targeted removal deletes our entry, keeps CC's newer state", () => {
    // This is the exact case the retired whole-file `undo` could NOT reverse: ~/.claude.json is CC's
    // continuously-rewritten live-state file, so it has diverged by uninstall time; the identity-checked undo
    // threw and left mcpServers.agent-os behind (the lived VS1 limitation). Targeted removal fixes it.
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }] } }, null, 2) + "\n",
    );
    writeFileSync(claudeJsonPath(), JSON.stringify({ numStartups: 3 }, null, 2) + "\n");

    install();

    // Simulate Claude Code's own continuous rewrites AFTER install — the file the old undo would refuse to touch.
    const j = readJson(claudeJsonPath());
    writeFileSync(claudeJsonPath(), JSON.stringify({ ...j, numStartups: 99, projects: { "/x": { allowedTools: [] } } }, null, 2) + "\n");

    expect(() => uninstallClaudeCode({ home, dataDir, repoRoot: REPO })).not.toThrow();

    const after = readJson(claudeJsonPath());
    expect(after.mcpServers?.["agent-os"]).toBeUndefined(); // our entry removed FROM the diverged file
    expect(after.numStartups).toBe(99); // CC's newer state preserved, never clobbered
    expect(after.projects).toEqual({ "/x": { allowedTools: [] } }); // its post-install additions survive
  });

  test("install wholesale-replaces our owned subtree — a stale foreign `headers` on a pre-existing agent-os entry is dropped", () => {
    // A hand-edited/foreign ~/.claude.json carrying a static `headers` (embedded token) under mcpServers.agent-os.
    // A plain deepMerge would keep that stale key; replaceSubtrees drops it (install-side stale-key cleanup).
    writeFileSync(
      claudeJsonPath(),
      JSON.stringify({ mcpServers: { "agent-os": { type: "http", url: "http://127.0.0.1:1/mcp", headers: { "x-token": "STALE" } } } }, null, 2) + "\n",
    );

    install();

    const entry = readJson(claudeJsonPath()).mcpServers["agent-os"];
    expect(entry.headers).toBeUndefined(); // the stale embedded-token key did not survive the replace
    expect(entry.headersHelper).toBe(MCP_CMD); // replaced with our current, token-free helper
    expect(entry.url).toBe("http://127.0.0.1:4319/mcp");
  });

  test("uninstall isolates a failing settings.json write — claude.json's agent-os is still removed (per-target try/catch)", () => {
    install();
    expect(readJson(claudeJsonPath()).mcpServers["agent-os"]).toBeDefined();

    // Force the settings.json uninstall write to throw: replace the file with a DIRECTORY, so the engine's
    // readFileSync(target) hits EISDIR. (existsSync is true for a dir, so the exists-guard doesn't skip it.)
    rmSync(settingsPath());
    mkdirSync(settingsPath());

    let outcome: UninstallOutcome = { removed: [], failed: [] };
    expect(() => {
      outcome = uninstallClaudeCode({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();

    // The settings failure was isolated: claude.json's agent-os entry is still removed, and only it is reported.
    expect(readJson(claudeJsonPath()).mcpServers?.["agent-os"]).toBeUndefined();
    expect(outcome.removed).toContain(claudeJsonPath());
    expect(outcome.removed).not.toContain(settingsPath());
    // FIX B: the settings failure is now NAMED in `failed` (with a non-empty error) — strictly stronger than
    // merely being omitted from `removed`, which a true no-op would also satisfy.
    expect(outcome.failed.map((f) => f.path)).toEqual([settingsPath()]);
    expect(outcome.failed[0].error.length).toBeGreaterThan(0);
  });

  test("uninstall does not throw even when BOTH targets fail to write (each isolated, nothing reported removed)", () => {
    install();
    // Sabotage both configs into directories so each uninstall write throws (and is caught per-target).
    rmSync(settingsPath());
    mkdirSync(settingsPath());
    rmSync(claudeJsonPath());
    mkdirSync(claudeJsonPath());

    let outcome: UninstallOutcome = { removed: ["sentinel"], failed: [] };
    expect(() => {
      outcome = uninstallClaudeCode({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();
    expect(outcome.removed).toEqual([]); // neither target could be processed, but uninstall completed cleanly
    // FIX B: BOTH failing targets are named in `failed` with non-empty errors (not collapsed into empty `removed`).
    expect(outcome.failed.map((f) => f.path).sort()).toEqual([claudeJsonPath(), settingsPath()].sort());
    expect(outcome.failed.every((f) => f.error.length > 0)).toBe(true);
  });

  test("uninstall never fabricates hooks.SessionEnd on a settings.json that lacked it (touches only present events)", () => {
    // Hand-write settings.json bypassing install(): SessionStart present (holding OUR command, so there's
    // something to strip), SessionEnd entirely ABSENT. Uninstall must strip our SessionStart entry but NOT
    // introduce SessionEnd: [].
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify(
        { hooks: { SessionStart: [{ matcher: "startup|resume|clear", hooks: [{ type: "command", command: START_CMD, timeout: 10 }] }] } },
        null,
        2,
      ) + "\n",
    );

    uninstallClaudeCode({ home, dataDir, repoRoot: REPO });

    // Our SessionStart entry was stripped (it was the only one → the array is now empty); SessionEnd was never invented.
    expect(readJson(settingsPath()).hooks).toEqual({ SessionStart: [] });
  });

  test("uninstall leaves a foreign-formatted settings.json BYTE-for-byte unchanged when it holds none of our hooks (no reformat)", () => {
    // A settings.json a dotfile tool wrote with 4-space indent, holding only FOREIGN hook entries (none of
    // ours). An uninstall with nothing of ours to strip must not touch it — the engine's no-op short-circuit is
    // BYTE-level, so an empty-patch mergeConfig would still RE-SERIALIZE it to our 2-space layout. The fix makes
    // hooksPatchWithoutOurs return {} here and removeHooksIfPresent skip the write outright, so the bytes survive.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const foreign =
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo foreign-start" }] }],
            SessionEnd: [{ hooks: [{ type: "command", command: "echo foreign-end" }] }],
          },
        },
        null,
        4, // deliberately NOT our 2-space serializer output
      ) + "\n";
    writeFileSync(settingsPath(), foreign);

    const { removed, failed } = uninstallClaudeCode({ home, dataDir, repoRoot: REPO });

    expect(readFileSync(settingsPath(), "utf8")).toBe(foreign); // byte-for-byte unchanged — never reformatted
    expect(removed).toEqual([]); // nothing of ours present → nothing changed (claude.json is absent too)
    expect(failed).toEqual([]); // a skip is a clean no-op, not a failure
  });

  test("uninstall on a never-installed home returns [], doesn't throw, and creates no files", () => {
    let outcome: UninstallOutcome = { removed: ["sentinel"], failed: [{ path: "sentinel", error: "sentinel" }] };
    expect(() => {
      outcome = uninstallClaudeCode({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();
    expect(outcome).toEqual({ removed: [], failed: [] }); // nothing removed AND nothing failed — a true no-op
    expect(existsSync(settingsPath())).toBe(false); // uninstall must never CREATE a config
    expect(existsSync(claudeJsonPath())).toBe(false);
  });

  test("double-uninstall is idempotent — the second uninstall returns [] and doesn't throw (DECISIONS #30)", () => {
    install();
    const first = uninstallClaudeCode({ home, dataDir, repoRoot: REPO });
    expect(first.removed.length).toBeGreaterThan(0); // the first uninstall removed real entries
    expect(first.failed).toEqual([]); // …and cleanly, with no per-target failures

    let second: UninstallOutcome = { removed: ["sentinel"], failed: [{ path: "sentinel", error: "sentinel" }] };
    expect(() => {
      second = uninstallClaudeCode({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();
    expect(second).toEqual({ removed: [], failed: [] }); // our keys already gone → every target no-ops
  });
});
