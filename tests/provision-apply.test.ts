import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { apply, type ProvisionEngine } from "../src/provision/apply";
import { readBatches, newestBatchForProject, undoBatch } from "../src/provision/runs";
import { TARGETS } from "../src/provision/targets";
import { AppliedButUnjournaledError, mergeConfig, writeTextFile } from "../src/configwrite/index";
import type { Manifest } from "../src/contract/index";

// Fixture-only: blueprint + project + dataDir all under a temp root. The engine writes REAL paths (it is not
// injected), so `projectRoot`/`dataDir` are parameterized exactly like the installer tests.
let root: string;
let blueprintRoot: string;
let projectRoot: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "provision-apply-"));
  blueprintRoot = join(root, "blueprint");
  projectRoot = join(root, "project");
  dataDir = join(root, "data");
  mkdirSync(blueprintRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  // A test may chmod a project dir read-only to force a write fault; restore before rm so cleanup succeeds.
  for (const dir of [join(projectRoot, ".claude", "agents"), join(projectRoot, ".cursor", "skills")]) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* dir may not exist */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

// ── fixture helpers ──
const wBlueprint = (rel: string, content: string): void => wFile(blueprintRoot, rel, content);
const wProject = (rel: string, content: string): void => wFile(projectRoot, rel, content);
function wFile(base: string, rel: string, content: string): void {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const rProject = (rel: string): string => readFileSync(join(projectRoot, rel), "utf8");
const existsProject = (rel: string): boolean => existsSync(join(projectRoot, rel));
const parseJsonProject = (rel: string): Record<string, unknown> => JSON.parse(rProject(rel));
const parseTomlProject = (rel: string): Record<string, unknown> => parseToml(rProject(rel)) as Record<string, unknown>;
const backupCount = (): number => {
  const d = join(dataDir, "backups");
  return existsSync(d) ? readdirSync(d).length : 0;
};
const run = (opts?: Parameters<typeof apply>[1]) => apply({ manifest: ae1Manifest(), blueprintRoot, projectRoot, dataDir }, opts);

/**
 * The AE1 acceptance fixture: a faithful multi-role, multi-harness, mixed-transform blueprint (not the literal
 * run-1 repo). 3 roles across all three harnesses; copy + compose + scaffold + config-merge; json + toml +
 * text write paths. Per the advisor's rule: config surfaces → config-merge, text surfaces → copy/compose/scaffold.
 */
function ae1Manifest(): Manifest {
  return {
    schemaVersion: 1,
    roles: [
      {
        name: "architect",
        harness: "claude-code",
        files: [
          { transform: "compose", sources: ["src/architect-1.md", "src/architect-2.md"], destination: "CLAUDE.md" },
          { transform: "copy", source: "src/agents/architect.md", destination: ".claude/agents/architect.md" },
          { transform: "config-merge", source: "src/mcp/claude.json", destination: ".mcp.json" },
        ],
      },
      {
        name: "executor",
        harness: "codex",
        files: [
          { transform: "copy", source: "src/executor.md", destination: "AGENTS.md" },
          { transform: "copy", source: "src/agents/executor.toml", destination: ".codex/agents/executor.toml" },
          { transform: "config-merge", source: "src/config/codex.toml", destination: ".codex/config.toml" },
        ],
      },
      {
        name: "qa",
        harness: "cursor",
        files: [
          { transform: "config-merge", source: "src/mcp/cursor.json", destination: ".cursor/mcp.json" },
          { transform: "scaffold", source: "src/skills/qa-gate.md", destination: ".cursor/skills/qa-gate/SKILL.md" },
          { transform: "copy", source: "src/agents/qa.md", destination: ".cursor/agents/qa.md" },
        ],
      },
    ],
  };
}

function writeAe1Sources(): void {
  wBlueprint("src/architect-1.md", "# Architect\n");
  wBlueprint("src/architect-2.md", "extra guidance\n");
  wBlueprint("src/agents/architect.md", "architect agent role\n");
  wBlueprint("src/mcp/claude.json", JSON.stringify({ mcpServers: { "agent-os": { url: "http://x" } } }));
  wBlueprint("src/executor.md", "# Executor\n");
  wBlueprint("src/agents/executor.toml", 'name = "executor"\n');
  wBlueprint("src/config/codex.toml", '[mcp_servers.agent-os]\nurl = "http://x"\n');
  wBlueprint("src/mcp/cursor.json", JSON.stringify({ mcpServers: { "qa-browser": { command: "playwright" } } }));
  wBlueprint("src/skills/qa-gate.md", "# QA Gate\n");
  wBlueprint("src/agents/qa.md", "qa agent role\n");
}

// The nine destinations AE1 writes onto a fresh project (all created, so undo must delete every one).
const AE1_DESTS = [
  "CLAUDE.md",
  ".claude/agents/architect.md",
  ".mcp.json",
  "AGENTS.md",
  ".codex/agents/executor.toml",
  ".codex/config.toml",
  ".cursor/mcp.json",
  ".cursor/skills/qa-gate/SKILL.md",
  ".cursor/agents/qa.md",
];

describe("provision apply — AE1 happy path", () => {
  test("applies the fixture blueprint onto a fresh project; every write journaled; undo restores prior state", () => {
    writeAe1Sources();
    const outcome = run();

    expect(outcome.rolledBack).toBe(false);
    expect(outcome.failed).toEqual([]);
    expect(outcome.applied.filter((w) => w.unjournaled)).toEqual([]); // every write journaled
    expect(outcome.applied).toHaveLength(9);
    expect(outcome.applied.every((w) => w.created)).toBe(true);

    // text surfaces are BYTE-identical to their source (copy/scaffold); compose carries both ordered sources.
    expect(rProject(".claude/agents/architect.md")).toBe("architect agent role\n");
    expect(rProject("AGENTS.md")).toBe("# Executor\n");
    expect(rProject(".codex/agents/executor.toml")).toBe('name = "executor"\n');
    expect(rProject(".cursor/agents/qa.md")).toBe("qa agent role\n");
    expect(rProject(".cursor/skills/qa-gate/SKILL.md")).toBe("# QA Gate\n");
    const claudeMd = rProject("CLAUDE.md");
    expect(claudeMd).toContain("# Architect");
    expect(claudeMd).toContain("extra guidance");
    expect(claudeMd.indexOf("# Architect")).toBeLessThan(claudeMd.indexOf("extra guidance")); // ordered

    // config surfaces match SEMANTICALLY (config-merge canonicalizes layout, it is not byte-copy).
    expect((parseJsonProject(".mcp.json").mcpServers as Record<string, unknown>)["agent-os"]).toEqual({ url: "http://x" });
    expect((parseTomlProject(".codex/config.toml").mcp_servers as Record<string, unknown>)["agent-os"]).toEqual({ url: "http://x" });
    expect((parseJsonProject(".cursor/mcp.json").mcpServers as Record<string, unknown>)["qa-browser"]).toEqual({ command: "playwright" });

    // Every write is in the durable batch record, keyed by this run's batch id (KTD2).
    const batches = readBatches(dataDir);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.batchId).toBe(outcome.batchId);
    expect(batches[0]!.entries).toHaveLength(9);
    expect(batches[0]!.entries.every((e) => e.projectRoot === projectRoot)).toBe(true);

    // Full undo restores exact prior state — every created file deleted.
    const undoResult = undoBatch(projectRoot, dataDir);
    expect(undoResult.reversed).toHaveLength(9);
    expect(undoResult.superseded).toEqual([]);
    expect(undoResult.failed).toEqual([]);
    for (const dest of AE1_DESTS) expect(existsProject(dest)).toBe(false);
  });
});

describe("provision apply — AE7 generalization", () => {
  test("a structurally different blueprint (different roles/compose/harness mix) applies against fresh fixtures", () => {
    wBlueprint("a.md", "alpha\n");
    wBlueprint("b.md", "bravo\n");
    wBlueprint("c.md", "charlie\n");
    wBlueprint("cursor-agent.md", "cursor reviewer\n");
    wBlueprint("cursor-mcp.json", JSON.stringify({ mcpServers: { review: { command: "r" } } }));

    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        {
          name: "reviewer",
          harness: "claude-code",
          files: [{ transform: "compose", sources: ["a.md", "b.md", "c.md"], destination: "CLAUDE.md" }],
        },
        {
          name: "cursor-reviewer",
          harness: "cursor",
          files: [
            { transform: "copy", source: "cursor-agent.md", destination: ".cursor/agents/reviewer.md" },
            { transform: "config-merge", source: "cursor-mcp.json", destination: ".cursor/mcp.json" },
          ],
        },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.failed).toEqual([]);
    expect(outcome.applied).toHaveLength(3);
    const claudeMd = rProject("CLAUDE.md");
    for (const part of ["alpha", "bravo", "charlie"]) expect(claudeMd).toContain(part);
    expect(rProject(".cursor/agents/reviewer.md")).toBe("cursor reviewer\n");
    expect((parseJsonProject(".cursor/mcp.json").mcpServers as Record<string, unknown>).review).toEqual({ command: "r" });
  });
});

describe("provision apply — AE3 edges", () => {
  test("(a) second apply with no edits is a true no-op: zero writes, no new batch, no backup accumulation", () => {
    writeAe1Sources();
    run();
    const backupsAfterFirst = backupCount();

    const second = run();
    expect(second.applied).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(second.noops).toHaveLength(9);
    expect(backupCount()).toBe(backupsAfterFirst); // no reformat churn ⇒ no new backups
    expect(readBatches(dataDir)).toHaveLength(1); // the second run wrote nothing, so no second batch

    // Per-format round-trip idempotency proven through real apply for json, toml, AND text simultaneously.
    expect(second.noops).toContain(join(projectRoot, ".mcp.json")); // json
    expect(second.noops).toContain(join(projectRoot, ".codex/config.toml")); // toml
    expect(second.noops).toContain(join(projectRoot, "CLAUDE.md")); // text
  });

  test("(b) a foreign-formatted but semantically-merged config-merge target is skipped: zero writes, no backup", () => {
    wBlueprint("src/mcp/claude.json", JSON.stringify({ mcpServers: { "agent-os": { url: "http://x" } } }));
    // Live file: DIFFERENT byte layout (4-space indent, reordered keys) but already-merged content.
    wProject(".mcp.json", '{\n    "extra": true,\n    "mcpServers": {\n        "agent-os": { "url": "http://x" }\n    }\n}\n');
    const before = rProject(".mcp.json");

    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "architect", harness: "claude-code", files: [{ transform: "config-merge", source: "src/mcp/claude.json", destination: ".mcp.json" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });

    expect(outcome.applied).toEqual([]);
    expect(outcome.noops).toEqual([join(projectRoot, ".mcp.json")]);
    expect(rProject(".mcp.json")).toBe(before); // bytes untouched — NOT reformatted to canonical layout
    expect(backupCount()).toBe(0);
  });

  test("(c) config-merge into an mcp.json holding a foreign server preserves that server", () => {
    wBlueprint("src/mcp/cursor.json", JSON.stringify({ mcpServers: { "qa-browser": { command: "playwright" } } }));
    wProject(".cursor/mcp.json", JSON.stringify({ mcpServers: { "user-server": { command: "keep-me" } } }, null, 2) + "\n");

    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "qa", harness: "cursor", files: [{ transform: "config-merge", source: "src/mcp/cursor.json", destination: ".cursor/mcp.json" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });

    expect(outcome.applied).toHaveLength(1);
    expect(outcome.applied[0]!.action).toBe("merge");
    const servers = parseJsonProject(".cursor/mcp.json").mcpServers as Record<string, unknown>;
    expect(servers["user-server"]).toEqual({ command: "keep-me" }); // foreign server preserved
    expect(servers["qa-browser"]).toEqual({ command: "playwright" }); // ours merged in
  });

  test("(d) undoing an OLDER batch whose target a later apply superseded reports it per-file, does not abort", () => {
    wBlueprint("a.json", JSON.stringify({ mcpServers: { a: { command: "1" } } }));
    wBlueprint("b.json", JSON.stringify({ mcpServers: { b: { command: "2" } } }));
    const mk = (source: string): Manifest => ({
      schemaVersion: 1,
      roles: [{ name: "qa", harness: "cursor", files: [{ transform: "config-merge", source, destination: ".cursor/mcp.json" }] }],
    });

    const first = apply({ manifest: mk("a.json"), blueprintRoot, projectRoot, dataDir }); // batch1 → .cursor/mcp.json = {a}
    apply({ manifest: mk("b.json"), blueprintRoot, projectRoot, dataDir }); // batch2 overwrites → {a,b}

    // Undo the OLDER batch1 while batch2 is still live: its entry's postHash no longer matches disk.
    const undoResult = undoBatch(projectRoot, dataDir, first.batchId);
    expect(undoResult.superseded).toHaveLength(1);
    expect(undoResult.superseded[0]!.path).toBe(join(projectRoot, ".cursor/mcp.json"));
    expect(undoResult.superseded[0]!.error).toContain("superseded");
    expect(undoResult.failed).toEqual([]);
    // The later batch's write is untouched — both servers still present.
    const servers = parseJsonProject(".cursor/mcp.json").mcpServers as Record<string, unknown>;
    expect(servers.a).toBeDefined();
    expect(servers.b).toBeDefined();
  });
});

describe("provision apply — same-target-twice LIFO (brief pt 3)", () => {
  test("two config-merge rows into ONE destination; full undo restores the ORIGINAL (absent) via LIFO", () => {
    wBlueprint("a.json", JSON.stringify({ mcpServers: { a: { command: "1" } } }));
    wBlueprint("b.json", JSON.stringify({ mcpServers: { b: { command: "2" } } }));
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        {
          name: "qa",
          harness: "cursor",
          files: [
            { transform: "config-merge", source: "a.json", destination: ".cursor/mcp.json" },
            { transform: "config-merge", source: "b.json", destination: ".cursor/mcp.json" },
          ],
        },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toEqual([]);
    const servers = parseJsonProject(".cursor/mcp.json").mcpServers as Record<string, unknown>;
    expect(servers.a).toBeDefined();
    expect(servers.b).toBeDefined();

    // The batch is a postHash chain X→v1→v2; LIFO reverses v2 before v1, so v1's postHash still matches when
    // it is undone and the created file is finally deleted. Naive forward iteration would strand the file at v1.
    const undoResult = undoBatch(projectRoot, dataDir);
    expect(undoResult.failed).toEqual([]);
    expect(undoResult.superseded).toEqual([]);
    expect(existsProject(".cursor/mcp.json")).toBe(false); // original state restored
  });
});

describe("provision apply — error regimes", () => {
  test("a genuine mid-batch write fault rolls back earlier writes LIFO and aborts", () => {
    // An earlier role writes AGENTS.md successfully; a later role writes into a read-only dir → EACCES.
    wBlueprint("executor.md", "# Executor\n");
    wBlueprint("victim.md", "should never land\n");
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    chmodSync(join(projectRoot, ".claude", "agents"), 0o500); // owner r-x: cannot create the temp file

    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        { name: "executor", harness: "codex", files: [{ transform: "copy", source: "executor.md", destination: "AGENTS.md" }] },
        { name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "victim.md", destination: ".claude/agents/victim.md" }] },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".claude/agents/victim.md"));
    expect(outcome.applied).toEqual([]); // the earlier AGENTS.md write was rolled back
    expect(existsProject("AGENTS.md")).toBe(false); // rollback deleted the created file
    expect(existsProject(".claude/agents/victim.md")).toBe(false); // never landed
  });

  test("an applied-but-unjournaled write surfaces as a warning, is marked un-undoable, and the batch continues", () => {
    writeAe1Sources();
    // Honest injection: wrap the real engine — the write LANDS, then throw the real error type as the engine
    // would when journaling fails. apply must warn-and-continue, never abort.
    const flaky: ProvisionEngine = {
      mergeConfig: (t, p, o) => mergeConfig(t, p, o),
      writeTextFile: (t, c, o) => {
        const res = writeTextFile(t, c, o);
        if (t.endsWith("AGENTS.md")) throw new AppliedButUnjournaledError(t, res.backupPath, new Error("injected journal failure"));
        return res;
      },
    };

    const outcome = run({ engine: flaky });
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.failed).toEqual([]);
    const unjournaled = outcome.applied.filter((w) => w.unjournaled);
    expect(unjournaled).toHaveLength(1);
    expect(unjournaled[0]!.targetPath).toBe(join(projectRoot, "AGENTS.md"));
    const agentsWrite = outcome.applied.find((w) => w.targetPath.endsWith("AGENTS.md"));
    expect(agentsWrite).toBeDefined();
    expect(agentsWrite!.undoId).toBeNull(); // un-undoable
    expect(agentsWrite!.unjournaled!.error).toContain("journaling failed"); // annotation carries the cause
    expect(existsProject(".cursor/agents/qa.md")).toBe(true); // later writes still happened
  });

  test("an applied-but-unjournaled write SURVIVES a later mid-batch rollback (brief pt4 interaction)", () => {
    // write1 succeeds (journaled), write2 is applied-but-unjournaled (un-undoable), write3 faults genuinely.
    // The abort rolls back write1 LIFO but must NEVER reverse write2 — it was never in the rollback list.
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("second.md", "unjournaled survivor\n");
    wBlueprint("third.md", "never lands\n");
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    chmodSync(join(projectRoot, ".claude", "agents"), 0o500);

    const flaky: ProvisionEngine = {
      mergeConfig: (t, p, o) => mergeConfig(t, p, o),
      writeTextFile: (t, c, o) => {
        const res = writeTextFile(t, c, o); // the write LANDS
        if (t.endsWith(".cursor/agents/reviewer.md")) throw new AppliedButUnjournaledError(t, res.backupPath, new Error("injected"));
        return res;
      },
    };
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
        { name: "reviewer", harness: "cursor", files: [{ transform: "copy", source: "second.md", destination: ".cursor/agents/reviewer.md" }] },
        { name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "third.md", destination: ".claude/agents/victim.md" }] },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir }, { engine: flaky });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".claude/agents/victim.md"));
    // The un-undoable write SURVIVES in `applied` after the abort (it was never in the rollback list), so a
    // consumer can see what is still stuck on disk despite rolledBack:true.
    const survivors = outcome.applied.filter((w) => w.unjournaled);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.targetPath).toBe(join(projectRoot, ".cursor/agents/reviewer.md"));
    expect(outcome.applied).toEqual(survivors); // the journaled write1 was reversed ⇒ dropped from applied
    expect(existsProject("AGENTS.md")).toBe(false); // write1 rolled back
    expect(existsProject(".cursor/agents/reviewer.md")).toBe(true); // write2 un-undoable ⇒ SURVIVES the rollback
    expect(rProject(".cursor/agents/reviewer.md")).toBe("unjournaled survivor\n");
    expect(existsProject(".claude/agents/victim.md")).toBe(false); // write3 never landed
  });

  test("applying onto a DRIFTED copy target backs up then overwrites (blueprint wins, R8); undo restores the hand-edit", () => {
    wBlueprint("src/agents/architect.md", "architect agent role\n");
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    wProject(".claude/agents/architect.md", "HAND EDIT — drifted out of band\n");

    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "src/agents/architect.md", destination: ".claude/agents/architect.md" }] }],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.applied[0]!.action).toBe("overwrite");
    expect(rProject(".claude/agents/architect.md")).toBe("architect agent role\n"); // blueprint won

    undoBatch(projectRoot, dataDir);
    expect(rProject(".claude/agents/architect.md")).toBe("HAND EDIT — drifted out of band\n"); // hand-edit restored
  });

  test("an unresolvable destination aborts in preflight before any file is written", () => {
    wBlueprint("stray.md", "nowhere\n");
    wBlueprint("ok.md", "# Executor\n");
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        { name: "executor", harness: "codex", files: [{ transform: "copy", source: "ok.md", destination: "AGENTS.md" }] },
        { name: "stray", harness: "claude-code", files: [{ transform: "copy", source: "stray.md", destination: "docs/not-a-surface.md" }] },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.error).toContain("does not resolve");
    expect(outcome.applied).toEqual([]);
    expect(existsProject("AGENTS.md")).toBe(false); // nothing written — preflight aborted before the write pass
  });

  test("a mkdirSync fault (new subdir under a chmod-0500 ancestor) is caught by apply's own try and rolls back", () => {
    // The existing fault test chmods an already-existing LEAF dir, so the write faults INSIDE the engine. Here
    // the fault must be in apply's OWN mkdirSync: `.cursor/skills` exists but is 0o500, and the scaffold's
    // destination needs a NEW `qa-gate/` subdir under it — so mkdirSync itself throws EACCES. Placed AFTER an
    // earlier successful write to prove the mkdir throw routes through rollback, not out of apply uncaught.
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("skill.md", "# QA Gate\n");
    mkdirSync(join(projectRoot, ".cursor", "skills"), { recursive: true });
    chmodSync(join(projectRoot, ".cursor", "skills"), 0o500); // owner r-x: cannot create the qa-gate/ subdir

    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
        { name: "qa", harness: "cursor", files: [{ transform: "scaffold", source: "skill.md", destination: ".cursor/skills/qa-gate/SKILL.md" }] },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".cursor/skills/qa-gate/SKILL.md")); // the mkdir faulted here
    expect(outcome.applied).toEqual([]); // the earlier AGENTS.md write was reversed
    expect(outcome.rollbackFailures ?? []).toEqual([]); // the reversal itself succeeded
    expect(existsProject("AGENTS.md")).toBe(false); // rollback deleted the created file
  });

  test("an applied-but-unjournaled write that CREATED its target: created:true, backupPath:null, survives a later rollback", () => {
    // A CREATE has no backup, so the engine's AppliedButUnjournaledError carries backupPath=null. apply must
    // derive created:true from that contract (backupPath===null ⇒ created), and the survivor stays in `applied`
    // when a later row faults genuinely (it was never in the rollback list).
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("victim.md", "never lands\n");
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    chmodSync(join(projectRoot, ".claude", "agents"), 0o500);

    const flaky: ProvisionEngine = {
      mergeConfig: (t, p, o) => mergeConfig(t, p, o),
      writeTextFile: (t, c, o) => {
        const res = writeTextFile(t, c, o); // the CREATE lands (res.backupPath is null for a created file)
        if (t.endsWith("AGENTS.md")) throw new AppliedButUnjournaledError(t, res.backupPath, new Error("injected"));
        return res;
      },
    };
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
        { name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "victim.md", destination: ".claude/agents/victim.md" }] },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir }, { engine: flaky });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.failed).toHaveLength(1);
    const survivors = outcome.applied.filter((w) => w.unjournaled);
    expect(survivors).toHaveLength(1);
    expect(outcome.applied).toEqual(survivors); // no journaled survivor — the create is the only applied write left
    expect(survivors[0]!.targetPath).toBe(join(projectRoot, "AGENTS.md"));
    expect(survivors[0]!.created).toBe(true); // derived from backupPath===null, NOT hardcoded
    expect(survivors[0]!.undoId).toBeNull();
    expect(survivors[0]!.unjournaled!.backupPath).toBeNull(); // a created file ⇒ delete to revert
    expect(existsProject("AGENTS.md")).toBe(true); // un-undoable ⇒ SURVIVES the rollback
  });

  test("a rollback undo() that itself fails is surfaced in rollbackFailures (rolledBack stays honest)", () => {
    // write1 creates AGENTS.md (journaled). write2 faults genuinely, but FIRST diverges AGENTS.md on disk, so its
    // rollback undo() refuses ("changed since it was created") — that refusal must surface in rollbackFailures,
    // and the still-on-disk file must NOT be silently claimed reversed.
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("second.md", "never lands\n");

    const flaky: ProvisionEngine = {
      mergeConfig: (t, p, o) => mergeConfig(t, p, o),
      writeTextFile: (t, c, o) => {
        if (t.endsWith(".cursor/agents/reviewer.md")) {
          appendFileSync(join(projectRoot, "AGENTS.md"), "external drift\n"); // diverge the earlier target
          throw new Error("genuine mid-write fault"); // write2 never lands
        }
        return writeTextFile(t, c, o);
      },
    };
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
        { name: "reviewer", harness: "cursor", files: [{ transform: "copy", source: "second.md", destination: ".cursor/agents/reviewer.md" }] },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir }, { engine: flaky });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".cursor/agents/reviewer.md"));
    expect(outcome.rollbackFailures).toBeDefined();
    expect(outcome.rollbackFailures!).toHaveLength(1);
    expect(outcome.rollbackFailures![0]!.path).toBe(join(projectRoot, "AGENTS.md"));
    expect(outcome.applied).toEqual([]); // AGENTS.md has an undoId ⇒ dropped from applied; rollbackFailures carries it
    expect(existsProject("AGENTS.md")).toBe(true); // reversal failed ⇒ still on disk, honestly reported
  });

  test("a render error (missing source) aborts in preflight: failed, zero writes, no journal entries", () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "missing.md", destination: "AGENTS.md" }] }],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.error).toContain("render");
    expect(outcome.applied).toEqual([]);
    expect(existsProject("AGENTS.md")).toBe(false);
    expect(readBatches(dataDir)).toEqual([]); // preflight aborted before the write pass
  });

  test("a diff error (unreadable destination) aborts in preflight: failed, zero writes", () => {
    wBlueprint("ok.md", "# Executor\n");
    mkdirSync(join(projectRoot, "AGENTS.md")); // a directory where a regular file is expected ⇒ diff read blocked
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "ok.md", destination: "AGENTS.md" }] }],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.error).toContain("unreadable-destination");
    expect(outcome.applied).toEqual([]);
    expect(readBatches(dataDir)).toEqual([]);
  });

  test("a role targeting a valid-but-non-provisionable harness (hermes) aborts in preflight, zero writes", () => {
    wBlueprint("h.md", "hermes role\n");
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "hermes-role", harness: "hermes", files: [{ transform: "copy", source: "h.md", destination: "AGENTS.md" }] }],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.error).toContain("non-provisionable harness 'hermes'");
    expect(outcome.applied).toEqual([]);
    expect(existsProject("AGENTS.md")).toBe(false);
    expect(readBatches(dataDir)).toEqual([]);
  });

  test("two non-mergeable rows resolving to ONE destination are refused loudly in preflight (duplicate-destination guard)", () => {
    // Two whole-file copies into the same destination is an ambiguous, last-writer-wins blueprint — refuse it.
    // (Contrast the LEGAL all-config-merge same-destination case, exercised by AE3(c) and same-target-twice.)
    wBlueprint("a.md", "alpha\n");
    wBlueprint("b.md", "bravo\n");
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        {
          name: "architect",
          harness: "claude-code",
          files: [
            { transform: "copy", source: "a.md", destination: ".claude/agents/dup.md" },
            { transform: "copy", source: "b.md", destination: ".claude/agents/dup.md" },
          ],
        },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".claude/agents/dup.md"));
    expect(outcome.failed[0]!.error).toContain("non-mergeable");
    expect(outcome.applied).toEqual([]);
    expect(existsProject(".claude/agents/dup.md")).toBe(false);
    expect(readBatches(dataDir)).toEqual([]);
  });
});

describe("provision runs — KTD2 fresh-process batch view", () => {
  test("batch undo works purely from the journal, with no in-memory apply state", () => {
    writeAe1Sources();
    const outcome = run();

    // Reconstruct the batch view ONLY from the journal (a fresh readBatches call), never from the apply return.
    const batches = readBatches(dataDir);
    const newest = newestBatchForProject(projectRoot, dataDir);
    expect(newest).not.toBeNull();
    expect(newest!.batchId).toBe(outcome.batchId);
    expect(batches[0]!.entries).toHaveLength(9);

    const undoResult = undoBatch(projectRoot, dataDir); // reads the journal, not the apply outcome
    expect(undoResult.reversed).toHaveLength(9);
    for (const dest of AE1_DESTS) expect(existsProject(dest)).toBe(false);
  });

  test("newestBatchForProject / undoBatch return empty for a project with no batch", () => {
    expect(newestBatchForProject(projectRoot, dataDir)).toBeNull();
    expect(undoBatch(projectRoot, dataDir)).toEqual({ batchId: null, reversed: [], alreadyReversed: [], superseded: [], failed: [] });
  });
});

describe("provision apply — FOLD1 effective-form secret scan (issue #43)", () => {
  // The whole-file (copy/scaffold) cases target `.codex/agents/*.toml` — the ONLY create-shaped config-format
  // surface in the registry — so the effective-form scan (#1) is the gate. A copy of a `.json` source can only
  // resolve to a merge-shaped surface (`.mcp.json`/`.cursor/mcp.json`) and is refused by the shape guard (#3)
  // first, so it could never isolate #1. The config-merge case keeps JSON — the truest #43 repro.
  test("a copy whose DECODED config value hides a secret behind a TOML \\u escape is refused; zero writes", () => {
    // On disk the source holds `sk-ant-…` (double backslash → literal escape), so a raw byte-scan misses
    // it; apply must decode via parseConfigValue and scan the effective value. Key `x` is not a secret keyword,
    // so the RAW bytes contain no secret at all — only the decoded form does. That isolates the #43 gap.
    wBlueprint("evil.toml", 'x = "\\u0073k-ant-api03-AAAAAAAAAAAAAAAAAAAA"\n');
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "evil.toml", destination: ".codex/agents/evil.toml" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".codex/agents/evil.toml"));
    expect(outcome.failed[0]!.error).toContain("effective/decoded form contains a secret");
    expect(outcome.failed[0]!.error).not.toContain("sk-ant"); // content-free: NO secret bytes in the message
    expect(outcome.applied).toEqual([]);
    expect(existsProject(".codex/agents/evil.toml")).toBe(false);
    expect(readBatches(dataDir)).toEqual([]);
  });

  test("a config-merge whose patch decodes to a secret (JSON \\u escape) is refused; zero writes", () => {
    wBlueprint("mcp.json", '{"mcpServers":{"x":{"headers":{"Authorization":"Bearer \\u0073k-ant-api03-AAAAAAAAAAAAAAAAAAAA"}}}}');
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "qa", harness: "cursor", files: [{ transform: "config-merge", source: "mcp.json", destination: ".cursor/mcp.json" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".cursor/mcp.json"));
    expect(outcome.failed[0]!.error).toContain("effective/decoded form contains a secret");
    expect(outcome.failed[0]!.error).not.toContain("sk-ant"); // content-free
    expect(outcome.applied).toEqual([]);
    expect(existsProject(".cursor/mcp.json")).toBe(false);
  });

  test("an UNPARSEABLE config-format copy source fails closed in preflight; zero writes", () => {
    wBlueprint("broken.toml", "this is = = not valid toml [[[\n");
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "broken.toml", destination: ".codex/agents/broken.toml" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.error).toContain("unparseable toml config source");
    expect(outcome.applied).toEqual([]);
    expect(existsProject(".codex/agents/broken.toml")).toBe(false);
  });

  test("a CLEAN config source still applies normally (the scan does not over-fire)", () => {
    wBlueprint("clean.json", JSON.stringify({ mcpServers: { ok: { command: "run" } } }));
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "qa", harness: "cursor", files: [{ transform: "config-merge", source: "clean.json", destination: ".cursor/mcp.json" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toEqual([]);
    expect(outcome.applied).toHaveLength(1);
    expect((parseJsonProject(".cursor/mcp.json").mcpServers as Record<string, unknown>).ok).toEqual({ command: "run" });
  });
});

describe("provision apply — FOLD2 duplicate-destination (group ALL rows + config-merge leaf conflict)", () => {
  test("two whole-file copies to ONE destination, one already matching disk (diffs noop), are STILL refused", () => {
    // The noop row is invisible if grouping skips noops — this proves the group-ALL-rows fix: two whole-file
    // writers to one destination must be caught even when one currently oscillates to a no-op.
    wBlueprint("same.md", "shared\n");
    wBlueprint("other.md", "different\n");
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    wProject(".claude/agents/dup.md", "shared\n"); // makes the first copy diff to noop
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        {
          name: "architect",
          harness: "claude-code",
          files: [
            { transform: "copy", source: "same.md", destination: ".claude/agents/dup.md" },
            { transform: "copy", source: "other.md", destination: ".claude/agents/dup.md" },
          ],
        },
      ],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".claude/agents/dup.md"));
    expect(outcome.failed[0]!.error).toContain("non-mergeable");
    expect(outcome.applied).toEqual([]);
    expect(rProject(".claude/agents/dup.md")).toBe("shared\n"); // untouched
    expect(readBatches(dataDir)).toEqual([]);
  });

  test("two config-merge rows to one destination that CONFLICT on a leaf are refused; zero writes", () => {
    wBlueprint("c1.json", JSON.stringify({ mcpServers: { shared: { command: "one" } } }));
    wBlueprint("c2.json", JSON.stringify({ mcpServers: { shared: { command: "two" } } }));
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        {
          name: "qa",
          harness: "cursor",
          files: [
            { transform: "config-merge", source: "c1.json", destination: ".cursor/mcp.json" },
            { transform: "config-merge", source: "c2.json", destination: ".cursor/mcp.json" },
          ],
        },
      ],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".cursor/mcp.json"));
    expect(outcome.failed[0]!.error).toContain("conflicting config-merge");
    expect(outcome.applied).toEqual([]);
    expect(existsProject(".cursor/mcp.json")).toBe(false);
  });

  test("two config-merge rows to one destination with DISJOINT keys still apply (legal multi-role registration)", () => {
    wBlueprint("d1.json", JSON.stringify({ mcpServers: { alpha: { command: "1" } } }));
    wBlueprint("d2.json", JSON.stringify({ mcpServers: { beta: { command: "2" } } }));
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        {
          name: "qa",
          harness: "cursor",
          files: [
            { transform: "config-merge", source: "d1.json", destination: ".cursor/mcp.json" },
            { transform: "config-merge", source: "d2.json", destination: ".cursor/mcp.json" },
          ],
        },
      ],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toEqual([]);
    const servers = parseJsonProject(".cursor/mcp.json").mcpServers as Record<string, unknown>;
    expect(servers.alpha).toEqual({ command: "1" });
    expect(servers.beta).toEqual({ command: "2" });
  });
});

describe("provision apply — FOLD3 transform-vs-surface-shape clobber guard", () => {
  test("a whole-file copy targeting a merge-shaped surface (.cursor/mcp.json) is refused; zero writes", () => {
    wBlueprint("whole.json", JSON.stringify({ mcpServers: { y: { command: "z" } } }));
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "qa", harness: "cursor", files: [{ transform: "copy", source: "whole.json", destination: ".cursor/mcp.json" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".cursor/mcp.json"));
    expect(outcome.failed[0]!.error).toContain("merge surface");
    expect(outcome.failed[0]!.error).toContain("copy"); // names the offending transform
    expect(outcome.applied).toEqual([]);
    expect(existsProject(".cursor/mcp.json")).toBe(false);
  });

  test("a config-merge targeting the same merge-shaped surface is allowed", () => {
    wBlueprint("merge.json", JSON.stringify({ mcpServers: { y: { command: "z" } } }));
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "qa", harness: "cursor", files: [{ transform: "config-merge", source: "merge.json", destination: ".cursor/mcp.json" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toEqual([]);
    expect(outcome.applied).toHaveLength(1);
  });
});

describe("provision apply — FOLD1+4 blueprint-validity runs for ALL rows (disk-independent)", () => {
  test("a whole-file COPY of a TEXT source containing a secret is refused; zero writes (raw text scan closes the text gap)", () => {
    // The secret lives in RAW bytes of a `.md` role file — no config decode involved. Pre-FOLD1 the secret
    // scan only ran on json/toml/yaml, so a CLAUDE.md/AGENTS.md/.md copy carrying a secret sailed through.
    wBlueprint("evil.md", "# Role\nAPI key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAA\n");
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "evil.md", destination: ".claude/agents/evil.md" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".claude/agents/evil.md"));
    expect(outcome.failed[0]!.error).toContain("contains a secret");
    expect(outcome.failed[0]!.error).not.toContain("sk-ant"); // content-free
    expect(outcome.applied).toEqual([]);
    expect(existsProject(".claude/agents/evil.md")).toBe(false);
    expect(readBatches(dataDir)).toEqual([]);
  });

  test("a whole-file copy to a merge surface that currently NO-OPs (disk already matches) is STILL refused by the shape guard", () => {
    // Disk-independence of the shape guard: pre-write .cursor/mcp.json with the copy's exact bytes so the row
    // diffs to `noop` — the guard must still fire, because validity is a property of the blueprint, not disk.
    const bytes = JSON.stringify({ mcpServers: { y: { command: "z" } } });
    wBlueprint("whole.json", bytes);
    wProject(".cursor/mcp.json", bytes); // makes the copy diff to noop
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "qa", harness: "cursor", files: [{ transform: "copy", source: "whole.json", destination: ".cursor/mcp.json" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.error).toContain("merge surface");
    expect(outcome.applied).toEqual([]);
    expect(outcome.noops).toEqual([]); // refused in preflight, never reached the write pass
    expect(rProject(".cursor/mcp.json")).toBe(bytes); // untouched
    expect(readBatches(dataDir)).toEqual([]);
  });

  test("a secret-bearing copy that currently NO-OPs (disk already matches) is STILL refused by the secret scan", () => {
    // Disk-independence of the secret scan: the destination already holds the identical secret bytes, so the
    // copy diffs to `noop`. Pre-FOLD1 the scan ran only after the skip-continue, so this escaped on this machine
    // yet failed on a fresh clone. The scan must run for the noop row too.
    const secret = "# Role\ntoken sk-ant-api03-AAAAAAAAAAAAAAAAAAAA\n";
    wBlueprint("evil.md", secret);
    wProject(".claude/agents/evil.md", secret); // identical bytes ⇒ the copy diffs to noop
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "evil.md", destination: ".claude/agents/evil.md" }] }],
    };
    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.error).toContain("contains a secret");
    expect(outcome.failed[0]!.error).not.toContain("sk-ant"); // content-free
    expect(outcome.applied).toEqual([]);
    expect(outcome.noops).toEqual([]); // refused in preflight
    expect(rProject(".claude/agents/evil.md")).toBe(secret); // untouched
  });
});

describe("provision apply — FOLD2 honest no-op (undo disposition → alreadyReversed)", () => {
  test("a failed+rolled-back batch, undone again, reports its entries in alreadyReversed — never falsely in reversed", () => {
    // Force a mid-write fault so apply rolls back its one journaled write (AGENTS.md); its journal entry lingers
    // in the append-only journal. A bare undoBatch then selects that rolled-back batch (newest journaled) and
    // finds every entry ALREADY reversed on disk — the honest-no-op #50 claim made TRUE by the disposition.
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("victim.md", "never lands\n");
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    chmodSync(join(projectRoot, ".claude", "agents"), 0o500); // owner r-x: the later write faults
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
        { name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "victim.md", destination: ".claude/agents/victim.md" }] },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(outcome.rolledBack).toBe(true);
    expect(existsProject("AGENTS.md")).toBe(false); // the journaled write was reversed by rollback

    const undoResult = undoBatch(projectRoot, dataDir); // selects the rolled-back batch (newest journaled)
    expect(undoResult.batchId).toBe(outcome.batchId);
    expect(undoResult.alreadyReversed).toEqual([join(projectRoot, "AGENTS.md")]); // honest no-op
    expect(undoResult.reversed).toEqual([]); // NOT falsely reported as a real reversal
    expect(undoResult.superseded).toEqual([]);
    expect(undoResult.failed).toEqual([]);
  });
});

describe("provision apply — FOLD3 journal-ordering supersession (ABA content cycle)", () => {
  test("three batches write A→B→A to one target; explicit undo of the OLDEST is superseded (refused), newest state preserved", () => {
    // The classic byte-hash defeat: after A→B→A, batch1's postHash (hash A) reappears on disk, so a byte-hash
    // supersession check would MISS it and undo would DELETE the file — clobbering batch3's identical-looking A.
    // Journal-ordering keys on batch position, not bytes, so batch1 is correctly superseded by batches 2 & 3.
    const dest = ".claude/agents/cycle.md";
    const mk = (): Manifest => ({
      schemaVersion: 1,
      roles: [{ name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "cycle.md", destination: dest }] }],
    });

    wBlueprint("cycle.md", "A\n");
    const batch1 = apply({ manifest: mk(), blueprintRoot, projectRoot, dataDir }); // creates dest = A
    wBlueprint("cycle.md", "B\n");
    apply({ manifest: mk(), blueprintRoot, projectRoot, dataDir }); // overwrite → B
    wBlueprint("cycle.md", "A\n");
    apply({ manifest: mk(), blueprintRoot, projectRoot, dataDir }); // overwrite → A again (content cycle closed)
    expect(rProject(dest)).toBe("A\n");

    // Explicitly undo the OLDEST batch while the newest state is live. Fail CLOSED: refuse, never clobber.
    const undoResult = undoBatch(projectRoot, dataDir, batch1.batchId);
    expect(undoResult.superseded).toHaveLength(1);
    expect(undoResult.superseded[0]!.path).toBe(join(projectRoot, dest));
    expect(undoResult.superseded[0]!.error).toContain("superseded");
    expect(undoResult.reversed).toEqual([]); // NOT reversed — that would have clobbered batch3's state
    expect(undoResult.failed).toEqual([]);
    expect(existsProject(dest)).toBe(true); // the newest batch's file survives untouched
    expect(rProject(dest)).toBe("A\n");
  });
});

describe("provision apply — YAML round-trip reachability (documented)", () => {
  test("no registry surface is YAML, so YAML apply→apply is unreachable at the apply seam (covered at the U2 engine layer)", () => {
    // KTD1's `text` format and U2 prove the yaml write/undo path at the engine; U5's apply can only write
    // registry surfaces, and none is yaml (R10 verified-knowledge — no yaml surface was encoded). This asserts
    // that structural fact rather than faking a yaml apply round-trip.
    const formats = Object.values(TARGETS).flatMap((d) => d.surfaces.map((s) => s.format));
    expect(formats).not.toContain("yaml");
    expect(new Set(formats)).toEqual(new Set(["text", "json", "toml"]));
  });
});

describe("gate round-3 folds — disk-independent validity + alias-proof supersession", () => {
  // FOLD 4: an invalid row (non-provisionable harness OR unresolvable destination) must fail preflight for EVERY
  // row, including a noop whose bytes already match disk — validity is a property of the blueprint, not of disk.
  test("a non-provisionable-harness row that currently NO-OPs is STILL refused (disk-independent validity)", () => {
    wBlueprint("src/role.md", "hermes role body\n");
    wProject("HERMES.md", "hermes role body\n"); // destination already matches → this row would diff to noop
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "r", harness: "hermes" as Manifest["roles"][number]["harness"], files: [{ transform: "copy", source: "src/role.md", destination: "HERMES.md" }] }],
    };
    const before = readFileSync(join(projectRoot, "HERMES.md"), "utf8");
    const out = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(out.failed.some((f) => f.error.includes("non-provisionable harness 'hermes'"))).toBe(true);
    expect(out.applied).toHaveLength(0);
    expect(readBatches(dataDir)).toHaveLength(0); // zero writes journaled
    expect(readFileSync(join(projectRoot, "HERMES.md"), "utf8")).toBe(before);
  });

  test("an unresolvable-destination row that currently NO-OPs is STILL refused", () => {
    wBlueprint("src/role.md", "body\n");
    wProject("not-a-surface.md", "body\n"); // matches → would diff noop
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [{ name: "r", harness: "claude-code", files: [{ transform: "copy", source: "src/role.md", destination: "not-a-surface.md" }] }],
    };
    const out = apply({ manifest, blueprintRoot, projectRoot, dataDir });
    expect(out.failed.some((f) => f.error.includes("does not resolve to a known"))).toBe(true);
    expect(out.applied).toHaveLength(0);
    expect(readBatches(dataDir)).toHaveLength(0);
  });

  // FOLD 1a: supersession keys on the posix-normalized absolute targetPath alone, so equivalent root spellings
  // ("/p" vs "/p/") collapse to one key — a later batch under a different spelling still supersedes, so an
  // A→B→A cycle cannot clobber via an alias miss. (Old key embedded the raw projectRoot → distinct keys → miss.)
  test("equivalent project-root spellings still supersede — no alias clobber", () => {
    wBlueprint("src/a.json", JSON.stringify({ shared: { k: "A" } }));
    wBlueprint("src/b.json", JSON.stringify({ shared: { k: "B" } }));
    const mk = (src: string): Manifest => ({
      schemaVersion: 1,
      roles: [{ name: "r", harness: "claude-code", files: [{ transform: "config-merge", source: src, destination: ".mcp.json" }] }],
    });
    // batch1 writes {k:"A"} under the bare root; batch2 writes {k:"B"} under the trailing-slash spelling.
    const b1 = apply({ manifest: mk("src/a.json"), blueprintRoot, projectRoot, dataDir });
    const b2 = apply({ manifest: mk("src/b.json"), blueprintRoot, projectRoot: `${projectRoot}/`, dataDir });
    expect((parseJsonProject(".mcp.json").shared as Record<string, unknown>).k).toBe("B");
    // Explicitly undo the OLDEST batch (b1). Its entry's path was written later by b2 (a different spelling) →
    // superseded → refused, so b2's "B" is preserved (no clobber back to pre-A).
    const undone = undoBatch(projectRoot, dataDir, b1.batchId);
    expect(undone.superseded.length).toBeGreaterThan(0);
    expect(undone.reversed).toHaveLength(0);
    expect((parseJsonProject(".mcp.json").shared as Record<string, unknown>).k).toBe("B");
    void b2;
  });
});

describe("gate round-4 fold — equivalent project-root spellings select the right undo batch", () => {
  test("apply under '/p/' then default undo under '/p' reverses THAT batch, not an older one", () => {
    wBlueprint("src/one.md", "one\n");
    wBlueprint("src/two.md", "two\n");
    const mk = (src: string, dest: string): Manifest => ({
      schemaVersion: 1,
      roles: [{ name: "r", harness: "claude-code", files: [{ transform: "copy", source: src, destination: dest }] }],
    });
    // Older batch under the bare root writes CLAUDE.md; newer batch under the TRAILING-SLASH root writes AGENTS.md
    // (a codex surface — use its own role). Distinct destinations so supersession never enters.
    apply({ manifest: mk("src/one.md", "CLAUDE.md"), blueprintRoot, projectRoot, dataDir });
    const newer = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "r2", harness: "codex", files: [{ transform: "copy", source: "src/two.md", destination: "AGENTS.md" }] }] },
      blueprintRoot,
      projectRoot: `${projectRoot}/`,
      dataDir,
    });
    expect(existsProject("CLAUDE.md")).toBe(true);
    expect(existsProject("AGENTS.md")).toBe(true);
    // Default undo under the BARE root must select the NEWEST batch (applied under '/p/') and reverse it —
    // pre-fold it missed on strict-equality and reversed the older CLAUDE.md batch instead.
    const out = undoBatch(projectRoot, dataDir);
    expect(out.batchId).toBe(newer.batchId);
    expect(existsProject("AGENTS.md")).toBe(false); // the newest batch's created file was removed
    expect(existsProject("CLAUDE.md")).toBe(true); // the older batch stays applied
  });
});

describe("bot review (PR #52) — corrupt-journal fail-closed batch grouping", () => {
  test("an entry reusing a batchId under a DIFFERENT project root is dropped, not mixed into the batch", () => {
    // The journal is untrusted (module header): craft one with two entries sharing a batchId but two roots.
    mkdirSync(dataDir, { recursive: true });
    const base = { backupPath: null, created: true, mode: null, format: "text", ts: 1 };
    const mine = { ...base, id: "e1", targetPath: `${projectRoot}/CLAUDE.md`, postHash: "h1", batchId: "shared", projectRoot };
    const foreign = { ...base, id: "e2", targetPath: "/other/project/CLAUDE.md", postHash: "h2", batchId: "shared", projectRoot: "/other/project" };
    writeFileSync(join(dataDir, "undo-journal.jsonl"), `${JSON.stringify(mine)}\n${JSON.stringify(foreign)}\n`);
    const batches = readBatches(dataDir);
    expect(batches).toHaveLength(1);
    // Only the first-seen root's entry survives; the foreign-root entry is fail-closed out.
    expect(batches[0]!.entries.map((e) => e.targetPath)).toEqual([`${projectRoot}/CLAUDE.md`]);
    expect(batches[0]!.entries.some((e) => e.targetPath.startsWith("/other/project"))).toBe(false);
  });
});
