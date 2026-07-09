import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { installCodex, uninstallCodex } from "../src/install/codex";
import { existingEntriesWithoutOurs } from "../src/install/shared";
import { codexTokenPath, resolveCodexToken, TOKEN_HEADER } from "../src/paths";

// Fixture-home ONLY — every path is under a temp dir, so these tests never touch the real ~/.codex.
//
// Unlike the CC installer (which only ever builds hook-command STRINGS from repoRoot, never dereferencing
// them), installCodex's AGENTS.md step genuinely READS `templates/agents-md-pointer.md` from repoRoot on
// disk. So `REPO` here is the REAL repo root (not a fake "/repo" placeholder) — reading our own checked-in,
// version-controlled template is not a live-data risk the way touching ~/.codex would be; only `home` and
// `dataDir` need isolation, and both stay fully temp-dir-injected below.
const REPO = join(import.meta.dir, "..");
const START_CMD = `bun run "${REPO}/hooks/codex-session-start.ts"`;

let root: string;
let home: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "install-codex-"));
  home = join(root, "home");
  dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const codexDir = () => join(home, ".codex");
const configPath = () => join(codexDir(), "config.toml");
const hooksPath = () => join(codexDir(), "hooks.json");
const agentsMdPath = () => join(codexDir(), "AGENTS.md");
// TOML/JSON configs are untyped fixtures; `any` navigation keeps the assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readToml = (p: string): any => parseToml(readFileSync(p, "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const install = () => installCodex({ home, dataDir, repoRoot: REPO, port: 4319 });
const token = () => resolveCodexToken(dataDir);

describe("installCodex", () => {
  test("fresh install writes all three files with the expected structure", () => {
    const res = install();
    expect(res.config.created).toBe(true);
    expect(res.hooks.created).toBe(true);
    expect(res.agentsMd.created).toBe(true);

    const c = readToml(configPath());
    expect(c.mcp_servers["agent-os"]).toEqual({
      url: "http://127.0.0.1:4319/mcp",
      http_headers: { [TOKEN_HEADER]: token() },
    });
    expect(c.mcp_servers["agent-os"].type).toBeUndefined(); // Codex url-based servers carry no `type`

    const h = readJson(hooksPath());
    expect(h.hooks.SessionStart).toHaveLength(1);
    expect(h.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
    expect(h.hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: START_CMD, timeout: 10 });

    const agents = readFileSync(agentsMdPath(), "utf8");
    expect(agents).toContain("<!-- agent-os:start -->");
    expect(agents).toContain("<!-- agent-os:end -->");
    expect(agents).toContain("read_work_state");
  });

  test("refuses to install over a corrupt config.toml", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), "not = [valid toml");
    expect(() => install()).toThrow(/not valid TOML/);
    expect(existsSync(hooksPath())).toBe(false);
  });

  test("refuses to install over a corrupt hooks.json, and never touches config.toml", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(hooksPath(), "{ not json");
    expect(() => install()).toThrow(/not valid JSON/);
    // The pre-flight parse of hooks.json fails before config.toml is ever written.
    expect(existsSync(configPath())).toBe(false);
  });

  test("rolls back the config.toml write when the hooks.json write fails (cross-file transactional)", () => {
    mkdirSync(codexDir(), { recursive: true });
    // hooks.json is a symlink → the U14 engine refuses to write it (fail-closed), but only AT WRITE time —
    // after config.toml has already committed. installCodex must undo the config.toml write.
    symlinkSync(join(root, "nonexistent-target.json"), hooksPath());
    expect(existsSync(configPath())).toBe(false);

    expect(() => install()).toThrow();
    // Rolled back: the config.toml the installer created is gone — no partial (MCP-only) install remains.
    expect(existsSync(configPath())).toBe(false);
  });

  test("rolls back BOTH config.toml and hooks.json when the AGENTS.md write fails (cross-file transactional, third write)", () => {
    // Force the THIRD write to fail AFTER config.toml + hooks.json have already committed: make the AGENTS.md
    // path a DIRECTORY, so upsertAgentsMdBlock's readFileSync(path) throws (EISDIR) before ever reaching the
    // atomic temp+rename write. installCodex must undo BOTH earlier structured writes, not just the immediately
    // preceding one.
    mkdirSync(agentsMdPath(), { recursive: true });
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(hooksPath())).toBe(false);

    expect(() => install()).toThrow();

    // Both earlier structured writes were rolled back — no partial (config+hooks-only) install remains.
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(hooksPath())).toBe(false);
  });

  test("a failed install on a fresh machine cleans up the newly-minted codex.token (FIX 2)", () => {
    mkdirSync(codexDir(), { recursive: true });
    // Same trigger as "rolls back the config.toml write when the hooks.json write fails" above: hooks.json is
    // a symlink, so the U14 engine refuses to write it AFTER config.toml — and, inside that patch, a FRESH
    // codex.token (no pre-existing token here) — has already committed.
    symlinkSync(join(root, "nonexistent-target.json"), hooksPath());
    expect(existsSync(codexTokenPath(dataDir))).toBe(false); // nothing minted yet — no pre-existing token

    expect(() => install()).toThrow();

    // The token minted during the failed config.toml write was cleaned up, not stranded as a live,
    // unreferenced credential the gate would still accept.
    expect(existsSync(codexTokenPath(dataDir))).toBe(false);
  });

  test("a failed install PRESERVES a pre-existing codex.token — a failed reinstall never revokes a prior install's credential (FIX 2)", () => {
    // Pre-create codex.token directly (not via a prior install()) with a known value.
    mkdirSync(dataDir, { recursive: true });
    const tokenPath = codexTokenPath(dataDir);
    writeFileSync(tokenPath, "pre-existing-known-token");

    // Force the THIRD write (AGENTS.md) to fail — the other rollback catch block than the test above — by
    // making the AGENTS.md path a directory, same technique as "rolls back BOTH config.toml and hooks.json
    // when the AGENTS.md write fails" above.
    mkdirSync(agentsMdPath(), { recursive: true });

    expect(() => install()).toThrow();

    // The pre-existing credential must survive untouched — this install didn't mint it, so it must not revoke it.
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, "utf8")).toBe("pre-existing-known-token");
  });

  test("merge preserves a pre-existing unrelated mcp_servers table in config.toml", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n\n[mcp_servers.foo]\nurl = "https://example.com/mcp"\n`);

    install();

    const c = readToml(configPath());
    expect(c.model).toBe("gpt-5.5");
    expect(c.mcp_servers.foo).toEqual({ url: "https://example.com/mcp" });
    expect(c.mcp_servers["agent-os"]).toBeDefined();
  });

  test("merge preserves the user's existing SessionStart entries (array read-modify-write, not clobber)", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(
      hooksPath(),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "bash '/Users/jarod/.codex/herdr-agent-state.sh' session", timeout: 10 }] },
              {
                matcher: "startup|resume|clear|compact",
                hooks: [{ type: "command", command: 'echo "codebase-memory reminder"' }],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );

    install();

    const h = readJson(hooksPath());
    expect(h.hooks.SessionStart).toHaveLength(3);
    expect(h.hooks.SessionStart[0].hooks[0].command).toBe("bash '/Users/jarod/.codex/herdr-agent-state.sh' session");
    expect(h.hooks.SessionStart[1].hooks[0].command).toBe('echo "codebase-memory reminder"');
    expect(h.hooks.SessionStart[2].hooks[0].command).toBe(START_CMD);
  });

  test("AGENTS.md upsert is idempotent and preserves a pre-existing unrelated line above the block", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(agentsMdPath(), "<!-- codebase-memory-mcp:start -->\nunrelated block\n<!-- codebase-memory-mcp:end -->\n");

    install();
    const once = readFileSync(agentsMdPath(), "utf8");
    expect(once.split("<!-- agent-os:start -->").length - 1).toBe(1);
    expect(once).toContain("<!-- codebase-memory-mcp:start -->");
    expect(once).toContain("unrelated block");

    const res2 = install(); // re-install
    const twice = readFileSync(agentsMdPath(), "utf8");
    expect(twice).toBe(once); // byte-identical — true no-op
    expect(twice.split("<!-- agent-os:start -->").length - 1).toBe(1);
    expect(res2.agentsMd.changed).toBe(false);
  });

  test("re-install is a no-op at the engine level for all three targets", () => {
    install();
    const res2 = install();
    expect(res2.config.noop).toBe(true);
    expect(res2.hooks.noop).toBe(true);
    expect(res2.agentsMd.changed).toBe(false);
    expect(readJson(hooksPath()).hooks.SessionStart).toHaveLength(1);
  });

  test("the two structured files do not cross-contaminate", () => {
    install();
    const c = readToml(configPath());
    const h = readJson(hooksPath());
    expect(c.mcp_servers).toBeDefined();
    expect(c.hooks).toBeUndefined(); // our patch never touches config.toml's [hooks.state]
    expect(h.hooks).toBeDefined();
    expect(h.mcp_servers).toBeUndefined();
  });

  test("uninstall restores config.toml + hooks.json and strips the AGENTS.md block", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);
    writeFileSync(agentsMdPath(), "# Existing notes\nsome content\n");
    const beforeConfig = readFileSync(configPath(), "utf8");
    const beforeAgents = readFileSync(agentsMdPath(), "utf8");
    expect(existsSync(hooksPath())).toBe(false);

    install();
    expect(readFileSync(configPath(), "utf8")).not.toBe(beforeConfig); // our entry was merged in
    expect(existsSync(hooksPath())).toBe(true); // created by install
    expect(readFileSync(agentsMdPath(), "utf8")).not.toBe(beforeAgents);

    const restored = uninstallCodex({ home, dataDir });

    expect(readFileSync(configPath(), "utf8")).toBe(beforeConfig);
    expect(existsSync(hooksPath())).toBe(false); // created file → deleted
    expect(readFileSync(agentsMdPath(), "utf8")).toBe(beforeAgents);
    expect(restored).toContain(configPath());
    expect(restored).toContain(hooksPath());
    expect(restored).toContain(agentsMdPath());
  });

  test("uninstall deletes AGENTS.md entirely when install created it fresh (not left as an empty husk)", () => {
    install();
    expect(existsSync(agentsMdPath())).toBe(true);

    const restored = uninstallCodex({ home, dataDir });

    expect(existsSync(agentsMdPath())).toBe(false);
    expect(restored).toContain(agentsMdPath());
  });

  test("uninstall tolerates a config.toml that diverged since install — hooks.json still restores", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);

    install();

    // Simulate Codex's own continuous rewrites of its live-state file between install and uninstall.
    const c = readToml(configPath());
    writeFileSync(configPath(), `model = "gpt-6.0"\n\n[mcp_servers.agent-os]\nurl = "${c.mcp_servers["agent-os"].url}"\n`);

    expect(() => uninstallCodex({ home, dataDir })).not.toThrow();
    // hooks.json never diverged → its undo still succeeds, byte-exact (created ⇒ deleted).
    expect(existsSync(hooksPath())).toBe(false);
    // config.toml diverged → its undo is skipped (identity check), left as the simulated rewrite.
    expect(readFileSync(configPath(), "utf8")).toContain("gpt-6.0");
  });

  test("uninstall revokes the stable Codex credential (codex.token deleted, so a leftover config entry can't authenticate)", () => {
    install();
    expect(existsSync(codexTokenPath(dataDir))).toBe(true); // minted during install

    uninstallCodex({ home, dataDir });

    expect(existsSync(codexTokenPath(dataDir))).toBe(false);
  });

  test("uninstall still revokes codex.token when config.toml diverged since install (the restore-skip path)", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);

    install();
    expect(existsSync(codexTokenPath(dataDir))).toBe(true);

    // Simulate Codex's own continuous rewrites of its live-state file between install and uninstall, exactly
    // as the test above — this is the scenario where config.toml's byte-exact undo is SKIPPED.
    const c = readToml(configPath());
    writeFileSync(configPath(), `model = "gpt-6.0"\n\n[mcp_servers.agent-os]\nurl = "${c.mcp_servers["agent-os"].url}"\n`);

    const restored = uninstallCodex({ home, dataDir });

    // Revoked regardless of the skip — the leftover mcp_servers.agent-os entry is now inert.
    expect(existsSync(codexTokenPath(dataDir))).toBe(false);
    // config.toml's undo was skipped (diverged) — it must not be reported as restored.
    expect(restored).not.toContain(configPath());
  });

  test("uninstall THROWS when codex.token cannot be revoked, but still restores config/hooks/AGENTS.md first (FIX 1)", () => {
    install();
    const tokenPath = codexTokenPath(dataDir);
    expect(existsSync(tokenPath)).toBe(true); // minted during install

    // Replace the minted token FILE with a NON-EMPTY DIRECTORY: rmSync({force:true}) (non-recursive) throws
    // on a directory, simulating a revocation that fails (e.g. a real-world EPERM/EACCES deleting the file).
    rmSync(tokenPath, { force: true });
    mkdirSync(tokenPath, { recursive: true });
    writeFileSync(join(tokenPath, "blocker.txt"), "x");

    expect(() => uninstallCodex({ home, dataDir })).toThrow(/revoke|remove/i);

    // Revocation failed LOUD — the "credential" (directory standing in for it) is still present, not silently
    // left in an unknown state while uninstall reports success.
    expect(existsSync(tokenPath)).toBe(true);
    // But the best-effort cleanups that run BEFORE revocation still completed, exactly as they would if
    // revocation had succeeded — config.toml/hooks.json were restored (both created fresh by install() here,
    // so undo deletes them) and the AGENTS.md block was stripped, even though the overall call now throws.
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(hooksPath())).toBe(false);
    expect(existsSync(agentsMdPath())).toBe(false);
  });

  test("co-located hook granularity: re-install preserves a user command living in the SAME hooks.json entry as ours (FIX B)", () => {
    install(); // seed a normal install first, so START_CMD is the real installed command

    // Hand-write hooks.json so the SessionStart entry co-locates a user's own command alongside ours in ONE
    // entry (same matcher, two nested hooks) — e.g. a user who appended a hook into our entry by hand.
    writeFileSync(
      hooksPath(),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "startup|resume|clear|compact",
                hooks: [
                  { type: "command", command: "echo user-colocated-hook" },
                  { type: "command", command: START_CMD, timeout: 10 },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );

    install(); // re-install

    // Locally typed view of the JSON fixture (readJson returns `any`) so the array-method callbacks below
    // type-check without implicit `any` params.
    type HookEntry = { matcher?: string; hooks: Array<{ command: string }> };
    const h = readJson(hooksPath()) as { hooks: { SessionStart: HookEntry[] } };
    const allCommands = h.hooks.SessionStart.flatMap((e) => e.hooks.map((x) => x.command));
    // The user's co-located command survives re-install (previously: the WHOLE entry would have been dropped).
    expect(allCommands).toContain("echo user-colocated-hook");
    // Ours is present exactly once — not duplicated, and not left stale inside the old co-located entry.
    expect(allCommands.filter((c) => c === START_CMD)).toHaveLength(1);
    // The entry that used to co-locate both now holds only the user's hook (ours was stripped out of it;
    // installCodex appends a fresh entry of its own for START_CMD).
    const userEntry = h.hooks.SessionStart.find((e) => e.hooks.some((x) => x.command === "echo user-colocated-hook"));
    expect(userEntry).toBeDefined();
    expect(userEntry?.matcher).toBe("startup|resume|clear|compact");
    expect(userEntry?.hooks).toHaveLength(1);
  });
});

describe("existingEntriesWithoutOurs (FIX B: nested-hook-level filtering, not whole-entry drop)", () => {
  const OUR_CMD = "bun run our-hook.ts";

  test("an entry containing ONLY our hook is dropped entirely", () => {
    const config = { hooks: { SessionStart: [{ matcher: "m", hooks: [{ type: "command", command: OUR_CMD }] }] } };
    expect(existingEntriesWithoutOurs(config, "SessionStart", OUR_CMD)).toEqual([]);
  });

  test("an entry containing only a user hook is untouched", () => {
    const userEntry = { matcher: "m", hooks: [{ type: "command", command: "echo user" }] };
    const config = { hooks: { SessionStart: [userEntry] } };
    expect(existingEntriesWithoutOurs(config, "SessionStart", OUR_CMD)).toEqual([userEntry]);
  });

  test("an entry co-locating both keeps the entry with only the user's hook remaining", () => {
    const config = {
      hooks: {
        SessionStart: [
          {
            matcher: "m",
            hooks: [
              { type: "command", command: "echo user" },
              { type: "command", command: OUR_CMD },
            ],
          },
        ],
      },
    };
    expect(existingEntriesWithoutOurs(config, "SessionStart", OUR_CMD)).toEqual([
      { matcher: "m", hooks: [{ type: "command", command: "echo user" }] },
    ]);
  });

  test("missing/non-array hooks.<event> → []", () => {
    expect(existingEntriesWithoutOurs(undefined, "SessionStart", OUR_CMD)).toEqual([]);
    expect(existingEntriesWithoutOurs({ hooks: {} }, "SessionStart", OUR_CMD)).toEqual([]);
  });
});
