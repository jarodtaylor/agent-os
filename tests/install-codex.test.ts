import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { installCodex, uninstallCodex } from "../src/install/codex";
import { existingEntriesWithoutOurs, type UninstallOutcome } from "../src/install/shared";
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
/** Flatten a `hooks.SessionStart`-shaped array down to its nested `command` strings — shared by the
 *  uninstall assertions below that check which hook commands survived. */
const sessionStartCommands = (entries: Array<{ hooks?: Array<{ command: string }> }> | undefined): string[] =>
  (entries ?? []).flatMap((e) => (e.hooks ?? []).map((x) => x.command));

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

  test("enforces 0600 on a pre-existing loose-mode config.toml (the embedded token must not be group/world-readable)", () => {
    // A config.toml Codex / a dotfile tool created 0644, pre-existing our install. chmod (not writeFileSync's
    // mode arg) forces the loose mode regardless of the runner's umask, so the starting state is deterministic.
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);
    chmodSync(configPath(), 0o644);
    expect(statSync(configPath()).mode & 0o777).toBe(0o644);

    install();

    // The token is embedded AND the file was tightened to owner-only — the secret is not world-readable.
    const c = readToml(configPath());
    expect(c.mcp_servers["agent-os"].http_headers[TOKEN_HEADER]).toBe(token());
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  test("uninstall targeted-removes our SessionStart hook even when hooks.json diverged since install", () => {
    install();
    // The user edits hooks.json after install (adds their own co-located-elsewhere hook) → the byte-exact undo
    // can no longer restore it (identity check refuses the diverged file), so uninstall must TARGETED-remove
    // just our entry and keep theirs. Revoking codex.token alone would NOT disable a leftover hook (it reads the
    // per-boot token), so this targeted removal is what actually deactivates Codex consumption on uninstall.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h: any = readJson(hooksPath());
    h.hooks.SessionStart.push({ matcher: "startup", hooks: [{ type: "command", command: "echo mine", timeout: 5 }] });
    writeFileSync(hooksPath(), JSON.stringify(h, null, 2));

    uninstallCodex({ home, dataDir, repoRoot: REPO });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after: any = readJson(hooksPath());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmds = after.hooks.SessionStart.flatMap((e: any) => (e.hooks ?? []).map((x: any) => x.command));
    expect(cmds).not.toContain(START_CMD); // our hook is gone…
    expect(cmds).toContain("echo mine"); // …the user's survives.
  });

  test("uninstall strips our hook out of a CO-LOCATED entry, keeping the user's — the same-length case a bare length check would miss (FIX A)", () => {
    install(); // seed a real install so START_CMD is the installed command

    // Hand-write hooks.json so ONE SessionStart entry co-locates a user's command alongside ours (same matcher,
    // two nested hooks). existingEntriesWithoutOurs returns a SAME-LENGTH array here (the entry stays, minus our
    // nested hook), so a "did anything change?" check by array length alone would wrongly see no change, skip the
    // write, and leave our hook behind — the reference-aware check in hooksPatchWithoutOurs catches it.
    writeFileSync(
      hooksPath(),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "startup|resume|clear|compact",
                hooks: [
                  { type: "command", command: "echo user-colocated" },
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

    const { removed } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    const cmds = sessionStartCommands(readJson(hooksPath()).hooks.SessionStart);
    expect(cmds).not.toContain(START_CMD); // our hook stripped out of the co-located entry…
    expect(cmds).toContain("echo user-colocated"); // …the user's co-located command survives
    expect(removed).toContain(hooksPath()); // the file WAS written — not skipped as a false no-op
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

  test("a failed install cleans up a token minted over an empty pre-existing token file (empty pre-existing token doesn't count)", () => {
    // An EMPTY codex.token file is not a valid token — resolveCodexToken (paths.ts) treats it as absent and
    // mints a fresh one OVER it. Provenance for rollback must be SEMANTIC (readCodexToken: a valid non-empty
    // token pre-existed), not path-existence (existsSync) — existsSync would see the empty file and wrongly
    // report "preexisted", so rollback would skip cleanup and strand the token this install minted.
    mkdirSync(codexDir(), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(codexTokenPath(dataDir), "");

    // Same trigger as "a failed install on a fresh machine cleans up the newly-minted codex.token" above:
    // hooks.json is a symlink, so the U14 engine refuses to write it AFTER config.toml has already committed
    // — and, inside that patch, resolveCodexToken has already minted a fresh token over the empty file.
    symlinkSync(join(root, "nonexistent-target.json"), hooksPath());

    expect(() => install()).toThrow();

    // The token minted over the empty file was cleaned up — not stranded as a live credential the gate
    // (which reads codex.token fresh per request) would keep accepting after a failed install.
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

  test("install wholesale-replaces our owned subtree — a stale key on a pre-existing agent-os entry is dropped", () => {
    // A hand-edited/foreign config.toml carrying stale keys under [mcp_servers.agent-os] (an old `type` and a
    // leftover header). A plain deepMerge would keep them; replaceSubtrees drops them (install-side stale-key cleanup).
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(
      configPath(),
      `[mcp_servers.agent-os]\ntype = "stdio"\nurl = "http://127.0.0.1:1/mcp"\n\n[mcp_servers.agent-os.http_headers]\nx-stale = "OLD"\n`,
    );

    install();

    const entry = readToml(configPath()).mcp_servers["agent-os"];
    expect(entry.type).toBeUndefined(); // the stale `type` did not survive the replace
    expect(entry.http_headers).toEqual({ [TOKEN_HEADER]: token() }); // only OUR fresh header — the stale x-stale is gone
    expect(entry.url).toBe("http://127.0.0.1:4319/mcp"); // replaced with our current url
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

  test("uninstall strips only our entries — config.toml keeps the user's keys, our MCP + hook + AGENTS.md block go", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);
    writeFileSync(agentsMdPath(), "# Existing notes\nsome content\n");
    const beforeAgents = readFileSync(agentsMdPath(), "utf8");
    expect(existsSync(hooksPath())).toBe(false);

    install();
    expect(readToml(configPath()).mcp_servers["agent-os"]).toBeDefined();
    expect(existsSync(hooksPath())).toBe(true); // created by install
    expect(readFileSync(agentsMdPath(), "utf8")).not.toBe(beforeAgents);

    const { removed } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    // config.toml: our entry is gone; the user's key survives (targeted removal, not a byte-exact whole-file restore).
    const c = readToml(configPath());
    expect(c.mcp_servers?.["agent-os"]).toBeUndefined();
    expect(c.model).toBe("gpt-5.5");
    // hooks.json: our SessionStart hook is gone.
    const hookCmds = sessionStartCommands(readJson(hooksPath()).hooks.SessionStart);
    expect(hookCmds).not.toContain(START_CMD);
    // AGENTS.md: our block stripped, the prior notes restored intact.
    expect(readFileSync(agentsMdPath(), "utf8")).toBe(beforeAgents);
    expect(removed).toContain(configPath());
    expect(removed).toContain(hooksPath());
    expect(removed).toContain(agentsMdPath());
  });

  test("uninstall deletes AGENTS.md entirely when install created it fresh (not left as an empty husk)", () => {
    install();
    expect(existsSync(agentsMdPath())).toBe(true);

    const { removed } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(existsSync(agentsMdPath())).toBe(false);
    expect(removed).toContain(agentsMdPath());
  });

  test("uninstall on a DIVERGED config.toml now SUCCEEDS — targeted removal deletes our entry, keeps Codex's newer state", () => {
    // The case the retired whole-file `undo` could NOT reverse: config.toml is Codex's continuously-rewritten
    // live-state file, so it has diverged by uninstall time; the identity-checked undo threw and left
    // mcp_servers.agent-os behind. Targeted removal deletes our key from the live file whatever else changed.
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);

    install();

    // Simulate Codex's own continuous rewrites AFTER install.
    const c = readToml(configPath());
    writeFileSync(
      configPath(),
      `model = "gpt-6.0"\napproval = "on-request"\n\n[mcp_servers.agent-os]\nurl = "${c.mcp_servers["agent-os"].url}"\n`,
    );

    expect(() => uninstallCodex({ home, dataDir, repoRoot: REPO })).not.toThrow();

    const after = readToml(configPath());
    expect(after.mcp_servers?.["agent-os"]).toBeUndefined(); // our entry removed FROM the diverged file
    expect(after.model).toBe("gpt-6.0"); // Codex's newer state preserved
    expect(after.approval).toBe("on-request"); // its post-install additions survive
  });

  test("uninstall revokes the stable Codex credential (codex.token deleted, so a leftover config entry can't authenticate)", () => {
    install();
    expect(existsSync(codexTokenPath(dataDir))).toBe(true); // minted during install

    uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(existsSync(codexTokenPath(dataDir))).toBe(false);
  });

  test("uninstall revokes codex.token AND targeted-removes our entry even when config.toml diverged since install", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);

    install();
    expect(existsSync(codexTokenPath(dataDir))).toBe(true);

    // Simulate Codex's own continuous rewrites — the scenario where the old byte-exact config.toml undo was SKIPPED.
    const c = readToml(configPath());
    writeFileSync(configPath(), `model = "gpt-6.0"\n\n[mcp_servers.agent-os]\nurl = "${c.mcp_servers["agent-os"].url}"\n`);

    const { removed } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(existsSync(codexTokenPath(dataDir))).toBe(false); // credential revoked (defence in depth)
    // …and the entry is now ACTUALLY removed, not merely left inert — so config.toml IS reported changed
    // (under whole-file undo this path left the entry behind and did NOT report config.toml).
    expect(readToml(configPath()).mcp_servers?.["agent-os"]).toBeUndefined();
    expect(removed).toContain(configPath());
  });

  test("uninstall THROWS when codex.token cannot be revoked, but still targeted-removes our entries first (FIX 1)", () => {
    install();
    const tokenPath = codexTokenPath(dataDir);
    expect(existsSync(tokenPath)).toBe(true); // minted during install

    // Replace the minted token FILE with a NON-EMPTY DIRECTORY: rmSync({force:true}) (non-recursive) throws
    // on a directory, simulating a revocation that fails (e.g. a real-world EPERM/EACCES deleting the file).
    rmSync(tokenPath, { force: true });
    mkdirSync(tokenPath, { recursive: true });
    writeFileSync(join(tokenPath, "blocker.txt"), "x");

    expect(() => uninstallCodex({ home, dataDir, repoRoot: REPO })).toThrow(/revoke|remove/i);

    // Revocation failed LOUD — the "credential" (directory standing in for it) is still present, not silently
    // left in an unknown state while uninstall reports success.
    expect(existsSync(tokenPath)).toBe(true);
    // But the (a)/(b)/(c) targeted removals that run BEFORE revocation still completed: our entries are gone.
    expect(readToml(configPath()).mcp_servers?.["agent-os"]).toBeUndefined();
    const hookCmds = sessionStartCommands(readJson(hooksPath()).hooks.SessionStart);
    expect(hookCmds).not.toContain(START_CMD);
    expect(existsSync(agentsMdPath())).toBe(false); // created fresh by install → strip empties it → deleted
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

  test("uninstall isolates MULTIPLE failing targets in one call — config.toml + hooks.json both fail, yet AGENTS.md is stripped and codex.token revoked", () => {
    install();
    expect(existsSync(codexTokenPath(dataDir))).toBe(true); // minted during install

    // Corrupt BOTH structured targets so their uninstall writes each throw and are caught independently:
    //   (a) config.toml → removeConfigKeys parses it → invalid TOML throws
    //   (b) hooks.json  → removeHooksIfPresent's mergeConfig parses it → invalid JSON throws
    // (A dangling symlink would instead make existsSync false and SKIP hooks.json without exercising its catch,
    // so corrupt content is used here to force a genuine caught failure on BOTH targets.)
    writeFileSync(configPath(), "not = [valid toml");
    writeFileSync(hooksPath(), "{ not json");

    let outcome: UninstallOutcome = { removed: [], failed: [] };
    expect(() => {
      outcome = uninstallCodex({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();

    // Both failures were isolated — the later steps still ran:
    expect(existsSync(agentsMdPath())).toBe(false); // (c) AGENTS.md block stripped (install created it fresh → deleted)
    expect(outcome.removed).toContain(agentsMdPath());
    expect(existsSync(codexTokenPath(dataDir))).toBe(false); // (d) the credential was still revoked
    // …and the two failed targets are omitted from `removed`.
    expect(outcome.removed).not.toContain(configPath());
    expect(outcome.removed).not.toContain(hooksPath());
    // FIX B: both failing targets are NAMED in `failed` with non-empty errors — a strictly stronger check than
    // mere omission from `removed` (which a true no-op on those paths would also satisfy).
    expect(outcome.failed.map((f) => f.path).sort()).toEqual([configPath(), hooksPath()].sort());
    expect(outcome.failed.every((f) => f.error.length > 0)).toBe(true);
  });

  test("uninstall on a never-installed home returns [], doesn't throw, and creates no files", () => {
    let outcome: UninstallOutcome = { removed: ["sentinel"], failed: [{ path: "sentinel", error: "sentinel" }] };
    expect(() => {
      outcome = uninstallCodex({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();
    expect(outcome).toEqual({ removed: [], failed: [] }); // nothing removed AND nothing failed — a true no-op
    expect(existsSync(configPath())).toBe(false); // uninstall must never CREATE a config
    expect(existsSync(hooksPath())).toBe(false);
    expect(existsSync(agentsMdPath())).toBe(false);
  });

  test("double-uninstall is idempotent — the second uninstall returns [] and doesn't throw (DECISIONS #30)", () => {
    install();
    const first = uninstallCodex({ home, dataDir, repoRoot: REPO });
    expect(first.removed.length).toBeGreaterThan(0); // the first uninstall removed real entries
    expect(first.failed).toEqual([]); // …and cleanly, with no per-target failures

    let second: UninstallOutcome = { removed: ["sentinel"], failed: [{ path: "sentinel", error: "sentinel" }] };
    expect(() => {
      second = uninstallCodex({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();
    expect(second).toEqual({ removed: [], failed: [] }); // our keys already gone, credential already revoked → every step no-ops
  });

  test("uninstall leaves a foreign-formatted hooks.json BYTE-for-byte unchanged when it holds none of our hooks (no reformat)", () => {
    // A hooks.json a dotfile tool wrote with 4-space indent, holding only a FOREIGN SessionStart entry (none of
    // ours). An uninstall with nothing of ours to strip must not touch it — the engine's no-op short-circuit is
    // BYTE-level, so an empty-patch mergeConfig would still RE-SERIALIZE it to our 2-space layout. The fix makes
    // hooksPatchWithoutOurs return {} here and removeHooksIfPresent skip the write outright, so the bytes survive.
    mkdirSync(codexDir(), { recursive: true });
    const foreign =
      JSON.stringify(
        { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo foreign" }] }] } },
        null,
        4, // deliberately NOT our 2-space serializer output
      ) + "\n";
    writeFileSync(hooksPath(), foreign);

    const { removed, failed } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(readFileSync(hooksPath(), "utf8")).toBe(foreign); // byte-for-byte unchanged — never reformatted
    expect(removed).toEqual([]); // nothing of ours anywhere (config.toml + AGENTS.md absent too) → nothing changed
    expect(failed).toEqual([]); // a skip is a clean no-op, not a failure
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
