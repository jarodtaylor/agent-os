import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { installCodex, uninstallCodex } from "../src/install/codex";
import { existingEntriesWithoutOurs, type UninstallOutcome } from "../src/install/shared";
import { journalPath } from "../src/configwrite/internal";
import { readCodexToken } from "../src/codex-credential";
import { TOKEN_HEADER } from "../src/paths";

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
/** The credential as the GATE would read it — same function `securityGate` calls, so these assertions test
 *  the property that matters ("what the gate accepts") rather than a test-local re-derivation. */
const token = () => readCodexToken(configPath());
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

  test("uninstall keeps config.toml at 0600 that install tightened from a pre-existing 0644 — never-loosen policy", () => {
    // Policy: a targeted uninstall NEVER loosens a mode Agent OS tightened. Install tightens a pre-existing 0644
    // config.toml to 0600 (the test above proves that half); the targeted removeConfigKeys preserves the CURRENT
    // mode, so the file STAYS 0600 after removal. Loosening back to 0644 could expose a secret added to the file
    // while it was held owner-only, so a tightening is never autonomously reversed (full mode-lifecycle: issue #33).
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);
    chmodSync(configPath(), 0o644);

    install();
    expect(statSync(configPath()).mode & 0o777).toBe(0o600); // install tightened it (see the test above)

    const { removed, warnings } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(statSync(configPath()).mode & 0o777).toBe(0o600); // STAYS 0600 — never loosened back to 0644
    const c = readToml(configPath());
    expect(c.mcp_servers?.["agent-os"]).toBeUndefined(); // our entry still removed…
    expect(c.model).toBe("gpt-5.5"); // …and the user's key otherwise intact
    expect(removed).toContain(configPath());
    expect(warnings).toEqual([]); // no mode-restore step → no warning
  });

  test("uninstall leaves a post-install user chmod untouched — a 0640 config.toml stays 0640", () => {
    // The user chmod'd config.toml to 0640 after install. Targeted removal preserves the file's current mode and
    // never rewrites it, so 0640 is untouched — the uninstall changes the mode in neither direction.
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);
    chmodSync(configPath(), 0o644);

    install();
    chmodSync(configPath(), 0o640); // user re-tightens post-install

    uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(statSync(configPath()).mode & 0o777).toBe(0o640); // untouched — not reset to 0644, not left at 0600
    expect(readToml(configPath()).mcp_servers?.["agent-os"]).toBeUndefined(); // removal still succeeded
  });

  test("uninstall leaves a config.toml install CREATED fresh at 0600 unchanged (no crash, no warning)", () => {
    // No pre-existing config.toml: install CREATES it at 0600. Targeted removal preserves the current mode, so it
    // stays 0600 — nothing to loosen, and the removal is a clean no-throw.
    install(); // fresh machine — install creates config.toml
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);

    const { warnings } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(existsSync(configPath())).toBe(true); // still there — only mcp_servers.agent-os was removed
    expect(statSync(configPath()).mode & 0o777).toBe(0o600); // unchanged — the file is ours, 0600 is correct
    expect(warnings).toEqual([]);
  });

  test("uninstall over a config.toml that was already 0600 pre-install leaves it 0600", () => {
    // A pre-existing config.toml ALREADY at 0600: install keeps 0600 and targeted removal preserves the current
    // mode, so it stays 0600. Nothing to loosen either way.
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);
    chmodSync(configPath(), 0o600);

    install();
    const { warnings } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(readToml(configPath()).mcp_servers?.["agent-os"]).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("uninstall targeted-removes our SessionStart hook even when hooks.json diverged since install", () => {
    install();
    // The user edits hooks.json after install (adds their own co-located-elsewhere hook) → the byte-exact undo
    // can no longer restore it (identity check refuses the diverged file), so uninstall must TARGETED-remove
    // just our entry and keep theirs. Revoking the credential alone would NOT disable a leftover hook (it reads
    // the per-boot token), so this targeted removal is what actually deactivates Codex consumption on uninstall.
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

  // ── Failed-install credential safety (ported from the codex.token era by #24) ───────────────────────────
  // U8 needed mint-provenance tracking to decide whether a failed install should delete codex.token. With the
  // credential living ONLY in the config entry, rolling back that entry IS the cleanup — but the properties
  // those tests protected are unchanged and must still hold, so they are re-proven in config.toml terms.

  test("a failed install on a fresh machine strands NO live credential (the rollback removes the entry that holds it)", () => {
    mkdirSync(codexDir(), { recursive: true });
    // Same trigger as "rolls back the config.toml write when the hooks.json write fails" above: hooks.json is
    // a symlink, so the U14 engine refuses to write it AFTER config.toml (carrying a freshly minted token) has
    // already committed.
    symlinkSync(join(root, "nonexistent-target.json"), hooksPath());
    expect(readCodexToken(configPath())).toBeNull(); // nothing minted yet — no pre-existing credential

    expect(() => install()).toThrow();

    // Nothing the gate would accept survives the failure — no unreferenced live credential left behind.
    expect(readCodexToken(configPath())).toBeNull();
  });

  test("a failed install strands no credential when it minted OVER an entry whose header was empty", () => {
    // The analogue of the retired "empty pre-existing codex.token doesn't count as provenance" case: an entry
    // carrying a BLANK header value is not a usable credential, so install mints fresh over it. The failure
    // must still leave nothing live — and because provenance is no longer tracked separately, this can't
    // regress the way an existsSync-based guard once could.
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `[mcp_servers.agent-os.http_headers]\n"${TOKEN_HEADER}" = ""\n`);
    symlinkSync(join(root, "nonexistent-target.json"), hooksPath());

    expect(() => install()).toThrow();

    expect(readCodexToken(configPath())).toBeNull();
  });

  test("a failed install PRESERVES a pre-existing credential — a failed reinstall never revokes a prior install's token", () => {
    // Establish a real prior install, then capture its credential.
    mkdirSync(codexDir(), { recursive: true });
    install();
    const priorToken = readCodexToken(configPath());
    expect(priorToken).not.toBeNull();

    // Force the THIRD write (AGENTS.md) to fail — the other rollback catch block than the test above — by
    // making the AGENTS.md path a directory, same technique as "rolls back BOTH config.toml and hooks.json
    // when the AGENTS.md write fails" above.
    rmSync(agentsMdPath(), { force: true });
    mkdirSync(agentsMdPath(), { recursive: true });

    expect(() => install()).toThrow();

    // The prior credential must survive untouched: the rollback restores the config that carried it, so a
    // failed reinstall never cuts off a working Codex session.
    expect(readCodexToken(configPath())).toBe(priorToken);
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

  test("re-install is a no-op at the engine level for all three targets — and REUSES the credential, never rotates it (#24 crux)", () => {
    install();
    const first = token();
    expect(first).not.toBeNull();

    const res2 = install();
    // config.noop can ONLY be true if the second install reproduced byte-identical config.toml — which
    // requires reusing the embedded token. Minting a fresh UUID on re-install (the tempting bug) would
    // rewrite http_headers, flip noop to false, and cut off a live Codex session mid-flight.
    expect(res2.config.noop).toBe(true);
    expect(res2.hooks.noop).toBe(true);
    expect(res2.agentsMd.changed).toBe(false);
    expect(readJson(hooksPath()).hooks.SessionStart).toHaveLength(1);
    // Stated directly as well, so the credential-stability property is legible on its own.
    expect(token()).toBe(first);
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

  test("uninstall revokes the stable Codex credential — removing our entry IS the revocation (#24)", () => {
    install();
    expect(token()).not.toBeNull(); // minted during install

    uninstallCodex({ home, dataDir, repoRoot: REPO });

    // Asked with the gate's own reader: nothing this file offers would authenticate any more.
    expect(token()).toBeNull();
  });

  test("uninstall revokes the credential AND targeted-removes our entry even when config.toml diverged since install", () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(configPath(), `model = "gpt-5.5"\n`);

    install();
    const minted = token();
    expect(minted).not.toBeNull();

    // Simulate Codex's own continuous rewrites — the scenario where the old byte-exact config.toml undo was
    // SKIPPED. The rewrite KEEPS our entry (credential and all), exactly as a real Codex rewrite would.
    writeFileSync(
      configPath(),
      `model = "gpt-6.0"\n\n[mcp_servers.agent-os]\nurl = "http://127.0.0.1:4319/mcp"\n\n[mcp_servers.agent-os.http_headers]\n"${TOKEN_HEADER}" = "${minted}"\n`,
    );
    expect(token()).toBe(minted); // still live before uninstall — the removal below is what cuts it

    const { removed } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(token()).toBeNull(); // credential revoked out of the DIVERGED file
    // …and the entry is now ACTUALLY removed, not merely left inert — so config.toml IS reported changed
    // (under whole-file undo this path left the entry behind and did NOT report config.toml).
    expect(readToml(configPath()).mcp_servers?.["agent-os"]).toBeUndefined();
    expect(removed).toContain(configPath());
  });

  test("uninstall THROWS when the credential-bearing entry cannot be removed, but still strips the other targets first", () => {
    // The #24 inversion: U8 threw when `codex.token` couldn't be deleted. There is no second file now, so the
    // loud path is a config.toml strip that FAILS — that leaves a LIVE credential, and must never be reported
    // as a successful uninstall. Trigger: replace config.toml with a DANGLING SYMLINK, which the U14 engine's
    // statTarget refuses (it is not a regular file), so the targeted removal fails.
    install();
    expect(token()).not.toBeNull();
    rmSync(configPath(), { force: true });
    symlinkSync(join(root, "nonexistent-config.toml"), configPath());

    expect(() => uninstallCodex({ home, dataDir, repoRoot: REPO })).toThrow(/revoke|remove/i);

    // But the (b)/(c) targeted removals that run BEFORE the verification still completed — the throw must not
    // abort the independent cleanups, only report that the credential outlived the uninstall.
    const hookCmds = sessionStartCommands(readJson(hooksPath()).hooks.SessionStart);
    expect(hookCmds).not.toContain(START_CMD);
    expect(existsSync(agentsMdPath())).toBe(false); // created fresh by install → strip empties it → deleted
  });

  test("the revoke-failure throw names the underlying cause but NEVER leaks the credential (corrupt config.toml)", () => {
    // A failed strip is most often an UNPARSEABLE config.toml — the exact path where a naive parser message
    // could echo a source frame carrying our (or an adjacent server's) bearer. Embed a KNOWN token, then break
    // the TOML while KEEPING that token in the bytes, so a leak would actually show. The thrown message must
    // carry the sanitized cause (location-only, via configwrite's parseLocation) yet not the credential.
    mkdirSync(codexDir(), { recursive: true });
    const secret = "leak-canary-do-not-echo-abc123";
    writeFileSync(
      configPath(),
      `[mcp_servers.agent-os.http_headers]\n"${TOKEN_HEADER}" = "${secret}"\n[[[ not valid toml\n`,
    );
    let msg = "";
    try {
      uninstallCodex({ home, dataDir, repoRoot: REPO });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/FAILED to revoke/i); // it threw the loud revocation-failure error…
    expect(msg).toMatch(/parse|toml/i); // …with the underlying cause interpolated (fix D)…
    expect(msg).not.toContain(secret); // …but the credential value never appears in it.
  });

  test("uninstall removes a legacy pre-#24 codex.token orphaned by the upgrade (a still-running old gate would honor it)", () => {
    // #24 deleted the code that WRITES codex.token, but an uninstall run after upgrading from U8 must still
    // CLEAN UP a leftover — a pre-#24 gate reads that file live per request, so leaving it behind means a
    // "successful" uninstall that hasn't actually revoked against the old process (codex adversarial gate).
    install(); // #24 install: writes config.toml, never codex.token
    const legacy = join(dataDir, "codex.token");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(legacy, "stale-u8-credential", { mode: 0o600 }); // simulate the pre-#24 leftover

    const { removed } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(existsSync(legacy)).toBe(false); // deleted → a pre-#24 gate reading it live stops accepting it
    expect(removed).toContain(legacy);
  });

  test("uninstall re-revokes a credential that reappeared after a previous uninstall (a later re-install, then uninstall)", () => {
    // Uninstall reads the file as it is NOW (cross-process by design), so a config that regained our entry —
    // a re-install, or Codex restoring a backup — is revoked again on the next uninstall rather than skipped
    // because some install-time journal says we already cleaned up.
    install();
    uninstallCodex({ home, dataDir, repoRoot: REPO });
    expect(token()).toBeNull();

    install();
    expect(token()).not.toBeNull();
    uninstallCodex({ home, dataDir, repoRoot: REPO });
    expect(token()).toBeNull();
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

  test("uninstall isolates MULTIPLE failing targets in one call — config.toml + hooks.json both fail, yet AGENTS.md is still stripped before the credential failure throws", () => {
    install();
    expect(token()).not.toBeNull(); // minted during install

    // Corrupt BOTH structured targets so their uninstall writes each throw and are caught independently:
    //   (a) config.toml → removeConfigKeys parses it → invalid TOML throws
    //   (b) hooks.json  → removeHooksIfPresent's mergeConfig parses it → invalid JSON throws
    writeFileSync(configPath(), "not = [valid toml");
    writeFileSync(hooksPath(), "{ not json");

    // Since #24 a failed (a) means the credential-bearing entry is still in the file, so the call FAILS LOUD
    // rather than reporting the failure and returning — but only AFTER (b) and (c) have each had their turn.
    expect(() => uninstallCodex({ home, dataDir, repoRoot: REPO })).toThrow(/revoke|remove/i);

    // Per-target isolation still holds: the corrupt (a)/(b) did not stop (c) from running to completion.
    expect(existsSync(agentsMdPath())).toBe(false); // (c) AGENTS.md block stripped (install created it fresh → deleted)
  });

  test("uninstall REPORTS (does not throw) when only non-credential targets fail — a corrupt hooks.json alone", () => {
    // The other side of the escalation: hooks.json holds no credential, so its failure stays a reported
    // `failed` entry and the caller still gets an outcome. Only the config.toml strip — the revocation —
    // is severe enough to throw. This keeps the UninstallOutcome contract meaningful for everything else.
    install();
    writeFileSync(hooksPath(), "{ not json");

    let outcome: UninstallOutcome = { removed: [], failed: [], warnings: [] };
    expect(() => {
      outcome = uninstallCodex({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();

    expect(token()).toBeNull(); // the credential WAS revoked — that path succeeded
    // hooks.json is NAMED in `failed` with a non-empty error — strictly stronger than mere omission from
    // `removed` (which a true no-op on that path would also satisfy).
    expect(outcome.failed.map((f) => f.path)).toEqual([hooksPath()]);
    expect(outcome.failed.every((f) => f.error.length > 0)).toBe(true);
    expect(outcome.removed).not.toContain(hooksPath());
    expect(outcome.removed).toContain(configPath());
    // A corrupt-parse failure lands in `failed`, NEVER `warnings` — the write never committed, so this is a
    // genuine failure, not the applied-but-unjournaled case a warning denotes.
    expect(outcome.warnings).toEqual([]);
  });

  test("uninstall classifies an applied-but-unjournaled removal as removed + warned, never failed (FIX C)", () => {
    install();
    // Sabotage journaling AFTER install: turn the undo journal into a DIRECTORY so recordUndo's appendFileSync
    // hits EISDIR right after each targeted removal has already atomically LANDED — the applied-but-unjournaled
    // window. The removals still succeed on disk; only their journal entries fail (backups land in a sibling dir).
    const jp = journalPath(dataDir);
    rmSync(jp, { force: true });
    mkdirSync(jp);

    let outcome: UninstallOutcome = { removed: [], failed: [], warnings: [] };
    expect(() => {
      outcome = uninstallCodex({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();

    // config.toml's delete LANDED — the agent-os entry is really gone…
    expect(readToml(configPath()).mcp_servers?.["agent-os"]).toBeUndefined();
    // …so it is classified removed + warned, NEVER failed: the entry IS gone, and `failed` would misreport it as
    // still stuck. This is the whole point of FIX C — an applied-but-unrecorded write is not an unapplied failure.
    expect(outcome.removed).toContain(configPath());
    const configWarning = outcome.warnings.find((w) => w.path === configPath());
    expect(configWarning).toBeDefined();
    expect(configWarning!.error.length).toBeGreaterThan(0);
    expect(outcome.failed.map((f) => f.path)).not.toContain(configPath());
  });

  test("uninstall on a never-installed home returns [], doesn't throw, and creates no files", () => {
    let outcome: UninstallOutcome = { removed: ["sentinel"], failed: [{ path: "sentinel", error: "sentinel" }], warnings: [{ path: "sentinel", error: "sentinel" }] };
    expect(() => {
      outcome = uninstallCodex({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();
    expect(outcome).toEqual({ removed: [], failed: [], warnings: [] }); // nothing removed, failed, OR warned — a true no-op
    expect(existsSync(configPath())).toBe(false); // uninstall must never CREATE a config
    expect(existsSync(hooksPath())).toBe(false);
    expect(existsSync(agentsMdPath())).toBe(false);
  });

  test("double-uninstall is idempotent — the second uninstall returns [] and doesn't throw (DECISIONS #30)", () => {
    install();
    const first = uninstallCodex({ home, dataDir, repoRoot: REPO });
    expect(first.removed.length).toBeGreaterThan(0); // the first uninstall removed real entries
    expect(first.failed).toEqual([]); // …and cleanly, with no per-target failures

    let second: UninstallOutcome = { removed: ["sentinel"], failed: [{ path: "sentinel", error: "sentinel" }], warnings: [{ path: "sentinel", error: "sentinel" }] };
    expect(() => {
      second = uninstallCodex({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();
    expect(second).toEqual({ removed: [], failed: [], warnings: [] }); // our keys already gone, credential already revoked → every step no-ops
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

  test("uninstall leaves a foreign-formatted commented config.toml BYTE-for-byte unchanged when it holds none of ours (no reformat)", () => {
    // The config.toml analogue of the hooks.json no-reformat guarantee above, on the removeConfigKeys path. A
    // config.toml Codex / a dotfile tool hand-wrote with comments and NONE of our mcp_servers.agent-os: uninstall's
    // targeted removeConfigKeys must NOT re-serialize it (smol-toml drops comments) for a delete that removes
    // nothing — else it reformats a live config, strips the owner's comments, and falsely reports it in `removed`.
    mkdirSync(codexDir(), { recursive: true });
    const foreign = '# my Codex config\nmodel = "gpt-5.5"  # inline note\n\n[tui]\ntheme = "dark"\n';
    writeFileSync(configPath(), foreign);

    const { removed, failed } = uninstallCodex({ home, dataDir, repoRoot: REPO });

    expect(readFileSync(configPath(), "utf8")).toBe(foreign); // comments + hand formatting untouched
    expect(removed).toEqual([]); // nothing of ours anywhere → nothing changed
    expect(failed).toEqual([]); // a skip is a clean no-op, not a failure
  });

  test("uninstall surfaces a DANGLING hooks.json symlink as a failure instead of silently skipping it (never throws; other targets still cleaned)", () => {
    install();
    // Replace hooks.json with a symlink to a now-missing target — a dangling link. existsSync FOLLOWS it and
    // reports false, so the old presence gate treated it as clean absence and left the live symlinked hook
    // registration behind (restoring the target would reactivate it). The lstat gate now surfaces it in `failed`,
    // while the rest of the uninstall still runs.
    rmSync(hooksPath());
    symlinkSync(join(root, "gone-hooks-target.json"), hooksPath());
    expect(existsSync(hooksPath())).toBe(false); // dangling: existsSync follows to the missing target

    let outcome: UninstallOutcome = { removed: [], failed: [], warnings: [] };
    expect(() => {
      outcome = uninstallCodex({ home, dataDir, repoRoot: REPO });
    }).not.toThrow();

    // The dangling hooks symlink is NAMED in `failed` with a non-empty error — not swallowed as a clean no-op…
    const hooksFailure = outcome.failed.find((f) => f.path === hooksPath());
    expect(hooksFailure).toBeDefined();
    expect(hooksFailure!.error.length).toBeGreaterThan(0);
    // …while the OTHER targets were still processed: our MCP entry removed and the credential revoked. hooks.json
    // carries no credential, so its failure does NOT escalate to a throw (contrast the config.toml twin below).
    expect(outcome.removed).toContain(configPath());
    expect(token()).toBeNull();
  });

  test("uninstall THROWS on a DANGLING config.toml symlink — the credential can't be revoked — but strips AGENTS.md first (#30 twin, #24 escalation)", () => {
    install();
    // The config.toml twin of the dangling hooks.json symlink test above, on the removeConfigKeys path. Replace
    // config.toml with a symlink to a now-missing target: existsSync FOLLOWS it and reports false, but statTarget
    // lstat-catches it as a symlink and throws the refusal, so removeConfigKeys(a) fails. Since #24 that means
    // the credential-bearing entry could not be removed, so the whole call throws — but only after (c) has run.
    rmSync(configPath());
    symlinkSync(join(root, "gone-config-target.toml"), configPath());
    expect(existsSync(configPath())).toBe(false); // dangling: existsSync follows to the missing target

    expect(() => uninstallCodex({ home, dataDir, repoRoot: REPO })).toThrow(/revoke|remove/i);

    // The AGENTS.md strip (c) still ran to completion before the credential-verification throw.
    expect(existsSync(agentsMdPath())).toBe(false);
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
