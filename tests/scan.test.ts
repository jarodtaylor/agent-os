import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InventoryItem, type ItemKind, type Runtime } from "../src/contract/index";
import {
  runScanners,
  scanAll,
  scanClaudeCode,
  scanCodex,
  scanCursor,
  type ScanContext,
  type SourceScanner,
} from "../src/scan/index";

// Fixture-HOME pattern (like tests/capture-*.test.ts): a temp dir per test standing in for `~`, torn down
// after. Scanners are pure disk reads, so no db/repo is needed — the disk IS the state under test.
const MACHINE = "machine-under-test";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scan-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function ctx(over: Partial<ScanContext> = {}): ScanContext {
  return { homeDir: home, machineId: MACHINE, ...over };
}

// ── fixture builders ──
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}
function writeRaw(path: string, raw: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
}
/** A skill = a dir under `skillsRoot` containing a SKILL.md (the CC/Codex convention). */
function makeSkill(skillsRoot: string, name: string): void {
  mkdirSync(join(skillsRoot, name), { recursive: true });
  writeFileSync(join(skillsRoot, name, "SKILL.md"), `# ${name}\n`);
}

// ── assertion helpers ──
const names = (items: InventoryItem[], runtime: Runtime, kind: ItemKind): string[] =>
  items.filter((i) => i.runtime === runtime && i.kind === kind).map((i) => i.name).sort();

// ─────────────────────────────────────────────────────────────────────────────
describe("scanClaudeCode", () => {
  test("enumerates MCP servers, skills, and ENABLED plugins from the real surfaces", () => {
    writeJson(join(home, ".claude.json"), { mcpServers: { "srv-a": { url: "http://a" }, "srv-b": {} } });
    makeSkill(join(home, ".claude", "skills"), "skill-one");
    makeSkill(join(home, ".claude", "skills"), "skill-two");
    // Decoys under skills/: a dir with no SKILL.md and a plain file — neither is a skill (no phantom, AE5).
    mkdirSync(join(home, ".claude", "skills", "not-a-skill"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "README.md"), "not a skill");
    writeJson(join(home, ".claude", "settings.json"), {
      enabledPlugins: { "p-on@mkt": true, "p-off@mkt": false }, // disabled plugin must be excluded (R8)
    });

    const items = scanClaudeCode(ctx());

    expect(names(items, "claude-code", "mcp")).toEqual(["srv-a", "srv-b"]);
    expect(names(items, "claude-code", "skill")).toEqual(["skill-one", "skill-two"]);
    expect(names(items, "claude-code", "plugin")).toEqual(["p-on@mkt"]); // p-off excluded
  });

  test("reads MCP from ~/.claude.json, NOT settings.json (the documented trap)", () => {
    writeJson(join(home, ".claude.json"), { mcpServers: { "real-mcp": {} } });
    // A decoy mcpServers block in settings.json must be ignored — settings.json is a plugin source only.
    writeJson(join(home, ".claude", "settings.json"), { mcpServers: { decoy: {} }, enabledPlugins: {} });

    const mcp = names(scanClaudeCode(ctx()), "claude-code", "mcp");

    expect(mcp).toEqual(["real-mcp"]);
    expect(mcp).not.toContain("decoy");
  });

  test("follows a symlinked skill dir and skips a broken symlink (no phantom)", () => {
    const realSkill = join(home, "external", "linked-skill");
    makeSkill(join(home, "external"), "linked-skill");
    const skillsRoot = join(home, ".claude", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    symlinkSync(realSkill, join(skillsRoot, "linked-skill")); // → a real dir with SKILL.md
    symlinkSync(join(home, "nowhere"), join(skillsRoot, "broken")); // → nonexistent

    const skills = names(scanClaudeCode(ctx()), "claude-code", "skill");

    expect(skills).toContain("linked-skill");
    expect(skills).not.toContain("broken");
  });

  // Per-project scope (projectDir surfaces + user-vs-project plugin precedence) is deferred to U11 — issue #35.

  test("a malformed config never throws and never emits junk", () => {
    writeJson(join(home, ".claude.json"), { mcpServers: "oops" }); // not an object
    makeSkill(join(home, ".claude", "skills"), "still-here");

    const items = scanClaudeCode(ctx());

    expect(names(items, "claude-code", "mcp")).toEqual([]); // no junk keys from a string
    expect(names(items, "claude-code", "skill")).toEqual(["still-here"]); // other surfaces unaffected
  });

  test("a missing HOME yields an empty inventory, not a throw", () => {
    expect(scanClaudeCode(ctx())).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("scanCodex", () => {
  test("enumerates MCP servers + plugins from config.toml (skills deferred — issue #36)", () => {
    writeRaw(
      join(home, ".codex", "config.toml"),
      [
        `[mcp_servers.srv-x]`,
        `url = "http://x"`,
        `[mcp_servers.srv-x.env]`, // a sub-table nests UNDER the server — must NOT become its own item
        `KEY = "v"`,
        `[mcp_servers.srv-y]`,
        `command = "y"`,
        `[plugins."plug-a@mkt"]`,
        `[plugins."plug-b@mkt2"]`,
      ].join("\n"),
    );

    const items = scanCodex(ctx());

    expect(names(items, "codex", "mcp")).toEqual(["srv-x", "srv-y"]); // no `env` sub-table leak
    expect(names(items, "codex", "plugin")).toEqual(["plug-a@mkt", "plug-b@mkt2"]);
    expect(names(items, "codex", "skill")).toEqual([]); // Codex skill scanning deferred (issue #36)
  });

  test("a corrupt config.toml yields no config items instead of throwing", () => {
    writeRaw(join(home, ".codex", "config.toml"), "this is = [not valid toml ===");
    expect(scanCodex(ctx())).toEqual([]);
  });

  test("a missing HOME yields an empty inventory, not a throw", () => {
    expect(scanCodex(ctx())).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("scanCursor", () => {
  test("enumerates user-scoped custom agents, skills, and MCP servers from ~/.cursor", () => {
    writeRaw(join(home, ".cursor", "agents", "qa-smoke.md"), "---\nname: qa-smoke\n---\n");
    writeRaw(join(home, ".cursor", "agents", "qa-browser-e2e.md"), "---\nname: qa-browser-e2e\n---\n");
    writeRaw(join(home, ".cursor", "agents", "README.txt"), "not an agent");
    makeSkill(join(home, ".cursor", "skills"), "qa-gate");
    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp"] } },
    });

    const items = scanCursor(ctx());

    // InventoryItem has no agent kind; Cursor custom agents occupy the existing extension/plugin slot.
    expect(names(items, "cursor", "plugin")).toEqual(["qa-browser-e2e", "qa-smoke"]);
    expect(names(items, "cursor", "skill")).toEqual(["qa-gate"]);
    expect(names(items, "cursor", "mcp")).toEqual(["playwright"]);
  });

  test("a malformed mcp.json degrades that surface without hiding valid agents and skills", () => {
    writeRaw(join(home, ".cursor", "agents", "qa.md"), "# QA\n");
    makeSkill(join(home, ".cursor", "skills"), "qa-gate");
    writeRaw(join(home, ".cursor", "mcp.json"), "{ definitely not json");

    const items = scanCursor(ctx());

    expect(names(items, "cursor", "mcp")).toEqual([]);
    expect(names(items, "cursor", "plugin")).toEqual(["qa"]);
    expect(names(items, "cursor", "skill")).toEqual(["qa-gate"]);
  });

  test("follows a valid agent symlink and skips a broken agent symlink", () => {
    const agentsRoot = join(home, ".cursor", "agents");
    const realAgent = join(home, "external", "linked-agent.md");
    writeRaw(realAgent, "# Linked agent\n");
    mkdirSync(agentsRoot, { recursive: true });
    symlinkSync(realAgent, join(agentsRoot, "linked-agent.md"));
    symlinkSync(join(home, "nowhere.md"), join(agentsRoot, "broken-agent.md"));

    const agents = names(scanCursor(ctx()), "cursor", "plugin");

    expect(agents).toContain("linked-agent");
    expect(agents).not.toContain("broken-agent");
  });

  test("an absent ~/.cursor yields an empty inventory, not a throw", () => {
    expect(scanCursor(ctx())).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("scanAll — composition, crash-safety, contract conformance", () => {
  function richFixture(): void {
    writeJson(join(home, ".claude.json"), { mcpServers: { "cc-mcp": {} } });
    makeSkill(join(home, ".claude", "skills"), "cc-skill");
    writeJson(join(home, ".claude", "settings.json"), { enabledPlugins: { "cc-plug@mkt": true } });
    writeRaw(join(home, ".codex", "config.toml"), `[mcp_servers.cx-mcp]\nurl = "http://z"\n`);
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { "cursor-mcp": {} } });
  }

  test("AE4: a corrupt runtime degrades ONLY itself — the other stays complete, scan succeeds", async () => {
    richFixture();
    writeRaw(join(home, ".codex", "config.toml"), "== broken toml [[["); // corrupt Codex only

    const all = await scanAll(ctx());

    // Claude Code is complete...
    expect(names(all, "claude-code", "mcp")).toEqual(["cc-mcp"]);
    expect(names(all, "claude-code", "skill")).toEqual(["cc-skill"]);
    expect(names(all, "claude-code", "plugin")).toEqual(["cc-plug@mkt"]);
    // ...and Codex degraded to empty, without aborting the sweep.
    expect(all.filter((i) => i.runtime === "codex")).toEqual([]);
  });

  test("a corrupt Cursor config degrades only Cursor while Claude Code and Codex remain complete", async () => {
    richFixture();
    writeRaw(join(home, ".cursor", "mcp.json"), "{ broken cursor json");

    const all = await scanAll(ctx());

    expect(names(all, "claude-code", "mcp")).toEqual(["cc-mcp"]);
    expect(names(all, "codex", "mcp")).toEqual(["cx-mcp"]);
    expect(all.filter((item) => item.runtime === "cursor")).toEqual([]);
  });

  test("AE5: a rescan reflects disk both ways — new items appear, removed items vanish (no phantoms)", async () => {
    const skillsRoot = join(home, ".claude", "skills");
    makeSkill(skillsRoot, "first");

    const before = names(await scanAll(ctx()), "claude-code", "skill");
    expect(before).toEqual(["first"]);

    makeSkill(skillsRoot, "second"); // add
    rmSync(join(skillsRoot, "first"), { recursive: true, force: true }); // remove

    const after = names(await scanAll(ctx()), "claude-code", "skill");
    expect(after).toEqual(["second"]); // `first` gone (no phantom), `second` picked up
  });

  test("every emitted item is contract-valid, produced by agent-os, stamped with this machine's id", async () => {
    richFixture();
    const all = await scanAll(ctx());

    expect(all.length).toBeGreaterThan(0);
    for (const item of all) {
      expect(() => InventoryItem.parse(item)).not.toThrow(); // exact contract shape (strictObject)
      expect(item.source).toBe("agent-os"); // the OS is the producer, not the observed runtime
      expect(item.machineId).toBe(MACHINE);
    }
  });

  test("only roster runtimes are emitted (claude-code, codex, cursor) — no off-roster sources", async () => {
    richFixture();
    const runtimes = new Set((await scanAll(ctx())).map((i) => i.runtime));
    expect([...runtimes].sort()).toEqual(["claude-code", "codex", "cursor"]);
  });

  test("an empty HOME yields an empty inventory, not a throw", async () => {
    expect(await scanAll(ctx())).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review-hardening (ce-code-review): the enabled-flag honesty, the phantom-skill and empty-key contract
// edges, the scanAll throw-backstop, and the no-secret-escape guard.
describe("scan — review-hardening", () => {
  // R8 honesty: Codex writes `enabled = true/false` into each [mcp_servers.x] / [plugins."y"] table.
  test("scanCodex skips entries explicitly `enabled = false` (mcp + plugins); keeps enabled + unflagged", () => {
    writeRaw(
      join(home, ".codex", "config.toml"),
      [
        `[mcp_servers.on]`,
        `enabled = true`,
        `[mcp_servers.off]`,
        `enabled = false`, // disabled → excluded
        `[mcp_servers.unflagged]`, // no enabled key → present counts as enabled
        `url = "http://u"`,
        `[plugins."p-on@mkt"]`,
        `enabled = true`,
        `[plugins."p-off@mkt"]`,
        `enabled = false`, // disabled → excluded
      ].join("\n"),
    );
    const items = scanCodex(ctx());
    expect(names(items, "codex", "mcp")).toEqual(["on", "unflagged"]); // `off` excluded
    expect(names(items, "codex", "plugin")).toEqual(["p-on@mkt"]); // `p-off` excluded
  });

  // Phantom guard (AE5): a `SKILL.md` that is a DIRECTORY (not a file) must NOT count as a skill.
  test("a `SKILL.md` that is a directory does not fake a skill (regular-file check)", () => {
    const skillsRoot = join(home, ".claude", "skills");
    makeSkill(skillsRoot, "real"); // SKILL.md is a file → a skill
    mkdirSync(join(skillsRoot, "fake", "SKILL.md"), { recursive: true }); // SKILL.md is a DIR → not a skill
    expect(names(scanClaudeCode(ctx()), "claude-code", "skill")).toEqual(["real"]);
  });

  // objectKeys' array guard: an array-valued surface must not emit phantom index-named ("0","1") items.
  test("an array-valued surface emits nothing, not phantom index names", () => {
    writeJson(join(home, ".claude.json"), { mcpServers: [{ a: 1 }, { b: 2 }] }); // hostile: an array
    makeSkill(join(home, ".claude", "skills"), "kept");
    const items = scanClaudeCode(ctx());
    expect(names(items, "claude-code", "mcp")).toEqual([]); // no "0"/"1"
    expect(names(items, "claude-code", "skill")).toEqual(["kept"]); // other surfaces unaffected
  });

  // Contract `name.min(1)`: an empty-string config key must never emit an unparseable `name: ""` item.
  test("an empty-string config key is skipped (never emits an empty name)", () => {
    writeJson(join(home, ".claude.json"), { mcpServers: { "": {}, real: {} } });
    const items = scanClaudeCode(ctx());
    expect(names(items, "claude-code", "mcp")).toEqual(["real"]); // "" skipped
    for (const item of items) expect(() => InventoryItem.parse(item)).not.toThrow();
  });

  // The R9 backstop: a scanner that THROWS past fail-soft degrades ONLY its runtime; scanAll never rejects.
  test("runScanners: a throwing scanner degrades only its own source, others complete", async () => {
    const boom: SourceScanner = () => {
      throw new Error("scanner blew up");
    };
    const ok: SourceScanner = (c) => [
      { runtime: "codex", kind: "mcp", name: "survivor", machineId: c.machineId, source: "agent-os" },
    ];
    const out = await runScanners(ctx(), [
      { runtime: "claude-code", scan: boom },
      { runtime: "codex", scan: ok },
    ]);
    expect(out.map((i) => i.name)).toEqual(["survivor"]); // codex survived; the throw was contained
    for (const item of out) expect(() => InventoryItem.parse(item)).not.toThrow();
  });

  // Substrate invariant (no secret escapes any read path): `name` must only ever be a config KEY, never a
  // secret VALUE — InventoryItem.name is not sensitivity-marked, so a value leaking into it is unredacted.
  test("secret config VALUES never surface in an item name (only keys are emitted)", async () => {
    const SECRET = "sk-live-DEADBEEF-do-not-leak";
    writeJson(join(home, ".claude.json"), {
      mcpServers: { "srv-1": { url: "http://x", headers: { Authorization: `Bearer ${SECRET}` } } },
    });
    writeJson(join(home, ".claude", "settings.json"), { enabledPlugins: { "plug@mkt": true } });
    writeRaw(join(home, ".codex", "config.toml"), `[mcp_servers.cx]\n[mcp_servers.cx.env]\nAPI_KEY = "${SECRET}"\n`);

    const all = await scanAll(ctx());

    expect(all.length).toBeGreaterThan(0);
    expect(names(all, "claude-code", "mcp")).toEqual(["srv-1"]); // the key, not the header value
    expect(names(all, "codex", "mcp")).toEqual(["cx"]); // the server name, not the env secret
    for (const item of all) {
      for (const field of Object.values(item)) {
        expect(String(field)).not.toContain(SECRET); // no field carries the secret substring
      }
    }
  });

  // Codex gate: a malformed config must NOT log the file content — smol-toml's error quotes the offending
  // source line, and a config.toml legitimately holds secrets. The degraded warn is PATH-ONLY.
  test("a malformed config's degraded warn never leaks the file content/secret", () => {
    const SECRET = "sk-secret-on-a-broken-line";
    writeRaw(join(home, ".codex", "config.toml"), `[mcp_servers.x]\napi_key = "${SECRET}\n`); // unterminated string
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      expect(scanCodex(ctx())).toEqual([]); // degrades to empty, no throw
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => w.includes("config.toml"))).toBe(true); // it DID surface the degraded file...
    for (const w of warnings) expect(w).not.toContain(SECRET); // ...but never the secret it contained
  });

  // Codex gate: readFileSync on a FIFO/character-device blocks forever; a directory is the same non-regular
  // branch (easy to create). A non-regular config path is skipped WITHOUT reading — never hangs the scan.
  test("a config path that is a directory (non-regular) is skipped, never read", () => {
    mkdirSync(join(home, ".claude.json"), { recursive: true }); // .claude.json is a DIRECTORY, not a file
    makeSkill(join(home, ".claude", "skills"), "kept");
    const items = scanClaudeCode(ctx()); // must return, not hang or throw
    expect(names(items, "claude-code", "mcp")).toEqual([]); // the dir is skipped
    expect(names(items, "claude-code", "skill")).toEqual(["kept"]); // other surfaces unaffected
  });

  // Codex gate: a scalar/array/null child is malformed, not a config table — emitting it would fabricate a
  // phantom active server/plugin (e.g. `[mcp_servers]` with a stray `ghost = false`).
  test("a scalar / array / null child value is not emitted as a phantom active entry", () => {
    writeJson(join(home, ".claude.json"), {
      mcpServers: { real: { url: "http://x" }, ghost: false, arr: [1], nul: null },
    });
    expect(names(scanClaudeCode(ctx()), "claude-code", "mcp")).toEqual(["real"]); // non-table children skipped
  });

  // Codex gate: a TOML datetime scalar parses to a TomlDate OBJECT — the plain-object prototype check must
  // reject it, or a bare typeof-object test would emit it as a phantom server.
  test("a TOML datetime-valued child is not a config table (no phantom from a TomlDate)", () => {
    writeRaw(
      join(home, ".codex", "config.toml"),
      [`[mcp_servers]`, `ghost = 2020-01-01T00:00:00Z`, `[mcp_servers.real]`, `url = "http://x"`].join("\n"),
    );
    expect(names(scanCodex(ctx()), "codex", "mcp")).toEqual(["real"]); // datetime `ghost` skipped, not phantom
  });

  // Codex gate: the source-level backstop must not log a raw error either — an unexpected throw could carry
  // config content. runScanners logs a FIXED runtime-only line, never anything derived from the throw.
  test("runScanners never logs a thrown error's message", async () => {
    const SECRET = "sk-secret-inside-a-thrown-error";
    const leaky: SourceScanner = () => {
      throw new Error(`boom ${SECRET}`);
    };
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    try {
      await runScanners(ctx(), [{ runtime: "codex", scan: leaky }]);
    } finally {
      console.error = original;
    }
    expect(errors.length).toBeGreaterThan(0); // it DID log the degradation...
    for (const e of errors) expect(e).not.toContain(SECRET); // ...but never the error message/secret
  });

  // Codex gate round 4: `name` is mutable JS data like any other property — a thrown error can carry a
  // secret there too. The fix is structural (the catch reads NOTHING off the throw), and this test pins it.
  test("runScanners never logs a thrown error's NAME (a name can carry a secret too)", async () => {
    const SECRET = "sk-secret-smuggled-via-error-name";
    const hostileName: SourceScanner = () => {
      const err = new Error("boom");
      err.name = SECRET;
      throw err;
    };
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    try {
      await runScanners(ctx(), [{ runtime: "codex", scan: hostileName }]);
    } finally {
      console.error = original;
    }
    expect(errors.length).toBeGreaterThan(0); // it DID log the degradation...
    for (const e of errors) expect(e).not.toContain(SECRET); // ...but nothing derived from the throw
  });

  // Codex gate round 4: a property GETTER on the thrown value can itself throw. If the catch inspected the
  // value at all, that second throw would escape the catch and abort the whole sweep — voiding AE4/R9's
  // degrade-one-runtime guarantee. The zero-inspection catch makes the backstop itself throw-proof.
  test("runScanners survives a thrown value whose `name` getter throws (backstop never re-throws)", async () => {
    const boobyTrapped: SourceScanner = () => {
      throw Object.defineProperty(new Error("boom"), "name", {
        get(): string {
          throw new Error("getter bomb");
        },
      });
    };
    const ok: SourceScanner = (c) => [
      { runtime: "codex", kind: "mcp", name: "survivor", machineId: c.machineId, source: "agent-os" },
    ];
    const out = await runScanners(ctx(), [
      { runtime: "claude-code", scan: boobyTrapped },
      { runtime: "codex", scan: ok },
    ]);
    expect(out.map((i) => i.name)).toEqual(["survivor"]); // the other runtime completed; nothing escaped
  });

  // Codex gate: composing scanner output must not RangeError on a large array — `push(...arr)` (a function-
  // call spread of an untrusted-length array) does; `concat` does not.
  test("runScanners composes a very large scanner output without a spread RangeError", async () => {
    const N = 100_000;
    const many: SourceScanner = (c) =>
      Array.from({ length: N }, (_, i) => ({
        runtime: "codex" as const,
        kind: "mcp" as const,
        name: `s${i}`,
        machineId: c.machineId,
        source: "agent-os" as const,
      }));
    const out = await runScanners(ctx(), [{ runtime: "codex", scan: many }]);
    expect(out.length).toBe(N); // all composed, no crash
  });
});
