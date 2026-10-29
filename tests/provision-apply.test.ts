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
import { batchStatusPath, readBatchStatuses } from "../src/provision/batch-status";
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
    expect(batches[0]!.batchId).toBe(outcome.batchId!);
    expect(batches[0]!.entries).toHaveLength(9);
    expect(batches[0]!.entries.every((e) => e.projectRoot === projectRoot)).toBe(true);

    // An explicit EMPTY id matches nothing — it must never fall back to the default (newest) selection.
    expect(undoBatch(projectRoot, dataDir, "")).toMatchObject({ batchId: "", reversed: [], alreadyReversed: [] });
    for (const dest of AE1_DESTS) expect(existsProject(dest)).toBe(true);

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
    const undoResult = undoBatch(projectRoot, dataDir, first.batchId!);
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

    // …and the DURABLE record must not claim otherwise. The status file is the only account of this batch that
    // outlives the process, so recording "rolled-back" here would assert the batch left nothing while
    // `.cursor/agents/reviewer.md` is demonstrably still on disk. An unjournaled survivor is live state exactly
    // like a failed rollback, so the batch records `partial` with the stranded flag (PR #61) — never fully
    // reversed, hence still default-selectable, and stranded, hence never retirable by a later undo.
    expect(readBatchStatuses(dataDir).get(outcome.batchId!)).toMatchObject({ status: "partial", stranded: true });
    expect(newestBatchForProject(projectRoot, dataDir)?.batchId).toBe(outcome.batchId!);
  });

  test("a later same-path write in the batch is REFUSED after an applied-but-unjournaled write (#51.2 poisoned path)", () => {
    // The only legal way two rows share a destination is all-config-merge (whole-file same-dest is refused by the
    // duplicate-destination guard). If row2's write LANDS but cannot be journaled, row3's byte-exact backup would
    // capture row2's unjournaled RESULT rather than the pre-batch bytes — so a fresh-process undo would reverse
    // only row3's entry, restore that intermediate state, and report `reversed` while the pre-batch state was
    // never restored. apply must poison the path instead: refuse row3, abort, and roll the batch back.
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("mcp-a.json", JSON.stringify({ mcpServers: { alpha: { command: "1" } } }));
    wBlueprint("mcp-b.json", JSON.stringify({ mcpServers: { beta: { command: "2" } } }));

    let mcpWrites = 0;
    const flaky: ProvisionEngine = {
      mergeConfig: (t, p, o) => {
        const res = mergeConfig(t, p, o); // the write LANDS
        if (t.endsWith(".cursor/mcp.json") && ++mcpWrites === 1) {
          throw new AppliedButUnjournaledError(t, res.backupPath, new Error("injected journal failure"));
        }
        return res;
      },
      writeTextFile: (t, c, o) => writeTextFile(t, c, o),
    };
    const manifest: Manifest = {
      schemaVersion: 1,
      roles: [
        { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
        { name: "qa", harness: "cursor", files: [{ transform: "config-merge", source: "mcp-a.json", destination: ".cursor/mcp.json" }] },
        { name: "reviewer", harness: "cursor", files: [{ transform: "config-merge", source: "mcp-b.json", destination: ".cursor/mcp.json" }] },
      ],
    };

    const outcome = apply({ manifest, blueprintRoot, projectRoot, dataDir }, { engine: flaky });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.path).toBe(join(projectRoot, ".cursor/mcp.json"));
    expect(outcome.failed[0]!.error).toContain("could not be journaled");
    expect(outcome.rolledBack).toBe(true);
    expect(existsProject("AGENTS.md")).toBe(false); // the journaled write was reversed
    // The un-undoable write is still on disk and still the ONLY thing `applied` claims — never a second entry
    // whose backup would misrepresent the pre-batch bytes.
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.applied[0]!.unjournaled).toBeDefined();
    expect(outcome.applied[0]!.targetPath).toBe(join(projectRoot, ".cursor/mcp.json"));
    const servers = parseJsonProject(".cursor/mcp.json").mcpServers as Record<string, unknown>;
    expect(servers.alpha).toEqual({ command: "1" }); // row2's unjournaled state, honestly reported as stuck
    expect(servers.beta).toBeUndefined(); // row3 was refused — it never wrote, so no misleading backup exists
    // The core invariant: row3's write never reached the engine at all, so no backup of the unjournaled state
    // was ever taken. (The journal is NOT asserted here: this fixture wraps the REAL engine, so row2's entry
    // journaled successfully before the injected throw — in production the error means that journal write is
    // exactly what failed. The engine call count is the part of this the injection models faithfully.)
    expect(mcpWrites).toBe(1);
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

  test("PR #61: a partial rollback is RECORDED, so a recovery undo retires it and history walks back to the older batch", () => {
    // Pre-fix a failed rollback recorded nothing, so its cleanliness stayed `unknown`: a recovery undo that
    // reversed everything could never mark it `undone`, bare undo re-selected it forever, and A stayed unreachable.
    wBlueprint("first.md", "# A\n");
    const a = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] }] },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    expect(rProject("AGENTS.md")).toBe("# A\n");

    wBlueprint("first.md", "# B\n");
    wBlueprint("second.md", "never lands\n");
    const flaky: ProvisionEngine = {
      mergeConfig: (t, p, o) => mergeConfig(t, p, o),
      writeTextFile: (t, c, o) => {
        if (t.endsWith(".cursor/agents/reviewer.md")) {
          appendFileSync(join(projectRoot, "AGENTS.md"), "external drift\n"); // B's rollback of AGENTS.md will refuse
          throw new Error("genuine mid-write fault");
        }
        return writeTextFile(t, c, o);
      },
    };
    const b = apply(
      {
        manifest: {
          schemaVersion: 1,
          roles: [
            { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
            { name: "reviewer", harness: "cursor", files: [{ transform: "copy", source: "second.md", destination: ".cursor/agents/reviewer.md" }] },
          ],
        },
        blueprintRoot,
        projectRoot,
        dataDir,
      },
      { engine: flaky },
    );
    expect(b.rollbackFailures).toHaveLength(1);
    expect(readBatchStatuses(dataDir).get(b.batchId!)?.status).toBe("partial");

    // The operator clears the drift, so B's entry matches its postHash again; a bare undo recovers B…
    wProject("AGENTS.md", "# B\n");
    const recovery = undoBatch(projectRoot, dataDir);
    expect(recovery.batchId).toBe(b.batchId);
    expect(recovery.reversed).toEqual([join(projectRoot, "AGENTS.md")]);
    expect(rProject("AGENTS.md")).toBe("# A\n");
    expect(readBatchStatuses(dataDir).get(b.batchId!)?.status).toBe("undone");

    // …and the next bare undo walks back to A instead of re-selecting the spent B.
    const older = undoBatch(projectRoot, dataDir);
    expect(older.batchId).toBe(a.batchId);
    expect(existsProject("AGENTS.md")).toBe(false);
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
    expect(newest!.batchId).toBe(outcome.batchId!);
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
  test("an EXPLICITLY undone failed+rolled-back batch reports its entries in alreadyReversed — never falsely in reversed", () => {
    // Force a mid-write fault so apply rolls back its one journaled write (AGENTS.md); its journal entry lingers
    // in the append-only journal. An EXPLICIT undo of that batch finds every entry ALREADY reversed on disk —
    // the honest-no-op claim made TRUE by the disposition. (The batch is no longer the DEFAULT target: #50's
    // terminal state now skips a fully rolled-back batch there — asserted at the end.)
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

    const undoResult = undoBatch(projectRoot, dataDir, outcome.batchId!); // explicitly, by id
    expect(undoResult.batchId).toBe(outcome.batchId);
    expect(undoResult.alreadyReversed).toEqual([join(projectRoot, "AGENTS.md")]); // honest no-op
    expect(undoResult.reversed).toEqual([]); // NOT falsely reported as a real reversal
    expect(undoResult.superseded).toEqual([]);
    expect(undoResult.failed).toEqual([]);
    expect(undoBatch(projectRoot, dataDir).batchId).toBeNull(); // …and it is NOT the default target (#50)
  });
});

// Issue #50: a failed apply rolls back in-process, but its (already-reversed) entries STAY in the append-only
// journal — so before the durable batch terminal state, that rolled-back batch was the newest JOURNALED batch and
// captured the DEFAULT undo target, leaving the operator's last successful run un-undone unless they knew its
// batch id. Default selection now skips a batch recorded `rolled-back`; explicit selection still reaches it.
describe("issue #50 — default undo targets the newest COMMITTED batch", () => {
  /** Batch A (committed, creates AGENTS.md) then batch B (writes CLAUDE.md, then faults and fully rolls back). */
  function committedThenRolledBack(): { a: ReturnType<typeof apply>; b: ReturnType<typeof apply> } {
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("second.md", "# Architect\n");
    wBlueprint("victim.md", "never lands\n");
    const a = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] }] },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    chmodSync(join(projectRoot, ".claude", "agents"), 0o500); // owner r-x: the second row of batch B faults
    const b = apply({
      manifest: {
        schemaVersion: 1,
        roles: [
          { name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "second.md", destination: "CLAUDE.md" }] },
          { name: "stray", harness: "claude-code", files: [{ transform: "copy", source: "victim.md", destination: ".claude/agents/victim.md" }] },
        ],
      },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    expect(b.rolledBack).toBe(true);
    expect(b.rollbackFailures ?? []).toEqual([]); // a COMPLETE rollback — the precondition for the durable status
    expect(existsProject("CLAUDE.md")).toBe(false); // batch B left nothing on disk
    return { a, b };
  }

  test("a failed + fully rolled-back batch is skipped by DEFAULT selection; the last committed batch is undone", () => {
    const { a } = committedThenRolledBack();
    expect(existsProject("AGENTS.md")).toBe(true);

    const out = undoBatch(projectRoot, dataDir); // no batch id — the operator's plain `undo`
    expect(out.batchId).toBe(a.batchId); // NOT the rolled-back batch B
    expect(out.reversed).toEqual([join(projectRoot, "AGENTS.md")]);
    expect(existsProject("AGENTS.md")).toBe(false); // the last SUCCESSFUL apply is what got undone
  });

  test("an EXPLICIT batch id still reaches a rolled-back batch (honest no-op, unchanged contract)", () => {
    const { b } = committedThenRolledBack();

    const out = undoBatch(projectRoot, dataDir, b.batchId!);
    expect(out.batchId).toBe(b.batchId);
    expect(out.alreadyReversed).toEqual([join(projectRoot, "CLAUDE.md")]); // reversed by the abort, honestly reported
    expect(out.reversed).toEqual([]);
    expect(existsProject("AGENTS.md")).toBe(true); // batch A untouched by an explicit undo of B
  });

  test("a PARTIALLY rolled-back batch (a rollback undo that itself failed) stays eligible — fail-safe", () => {
    // Terminal state is recorded `rolled-back` ONLY when every reversal succeeded. Here one file is still on
    // disk despite `rolledBack: true`, so the batch must remain the DEFAULT undo target — recording it
    // rolled-back would strand that file, undoable only by someone who knew the batch id.
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("second.md", "never lands\n");
    const flaky: ProvisionEngine = {
      mergeConfig: (t, p, o) => mergeConfig(t, p, o),
      writeTextFile: (t, c, o) => {
        if (t.endsWith(".cursor/agents/reviewer.md")) {
          appendFileSync(join(projectRoot, "AGENTS.md"), "external drift\n"); // diverge → its rollback undo refuses
          throw new Error("genuine mid-write fault");
        }
        return writeTextFile(t, c, o);
      },
    };
    const outcome = apply(
      {
        manifest: {
          schemaVersion: 1,
          roles: [
            { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
            { name: "reviewer", harness: "cursor", files: [{ transform: "copy", source: "second.md", destination: ".cursor/agents/reviewer.md" }] },
          ],
        },
        blueprintRoot,
        projectRoot,
        dataDir,
      },
      { engine: flaky },
    );
    expect(outcome.rollbackFailures).toHaveLength(1);
    expect(existsProject("AGENTS.md")).toBe(true); // still applied despite rolledBack:true

    expect(newestBatchForProject(projectRoot, dataDir)?.batchId).toBe(outcome.batchId!); // still the default target
  });

  test("an UNKNOWN terminal state (no status record — a pre-U6 journal) leaves the batch eligible", () => {
    // The non-negotiable degrade path: a missing/erased status file must reproduce exactly the pre-#50 behavior,
    // never make `undo` find nothing. Simulated by deleting the status record after a successful apply.
    wBlueprint("first.md", "# Executor\n");
    const a = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] }] },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    rmSync(batchStatusPath(dataDir), { force: true });

    const out = undoBatch(projectRoot, dataDir);
    expect(out.batchId).toBe(a.batchId);
    expect(out.reversed).toEqual([join(projectRoot, "AGENTS.md")]);
  });

  test("a torn / malformed status line is skipped like a torn journal line (untrusted input, validated on read)", () => {
    wBlueprint("first.md", "# Executor\n");
    const a = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] }] },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    // A half-written line + a schema-invalid line + a line claiming an unknown status: none may disturb selection.
    appendFileSync(batchStatusPath(dataDir), `{"batchId":"${a.batchId}","status":"rolled-b\n`);
    appendFileSync(batchStatusPath(dataDir), `${JSON.stringify({ batchId: a.batchId, projectRoot, status: "vaporized", ts: 1 })}\n`);

    expect(newestBatchForProject(projectRoot, dataDir)?.batchId).toBe(a.batchId!);
  });

  test("a lifecycle transition resolves by APPEND ORDER even when its clock went backwards", () => {
    // Gate round 2: `ts` was the tiebreak, so a backward clock between the `apply` and the `undo` that spent
    // the batch left the older `committed` record outranking the newer `undone` one FOREVER — the batch was
    // never skipped, bare `undo` re-selected the spent batch every run, and older history stayed unreachable
    // behind it. Append order is the causal order the transitions happened in, and is clock-independent.
    wBlueprint("first.md", "# Executor\n");
    const a = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] }] },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    expect(readBatchStatuses(dataDir).get(a.batchId!)?.status).toBe("committed");

    // The `undone` transition lands LATER in the file but carries an EARLIER wall clock (ts: 1).
    appendFileSync(batchStatusPath(dataDir), `${JSON.stringify({ batchId: a.batchId, projectRoot, status: "undone", ts: 1 })}\n`);

    expect(readBatchStatuses(dataDir).get(a.batchId!)?.status).toBe("undone");
    // …and the consumer agrees: a spent batch is skipped by default selection despite the older timestamp.
    expect(newestBatchForProject(projectRoot, dataDir)).toBeNull();
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
    const undoResult = undoBatch(projectRoot, dataDir, batch1.batchId!);
    expect(undoResult.superseded).toHaveLength(1);
    expect(undoResult.superseded[0]!.path).toBe(join(projectRoot, dest));
    expect(undoResult.superseded[0]!.error).toContain("superseded");
    expect(undoResult.reversed).toEqual([]); // NOT reversed — that would have clobbered batch3's state
    expect(undoResult.failed).toEqual([]);
    expect(existsProject(dest)).toBe(true); // the newest batch's file survives untouched
    expect(rProject(dest)).toBe("A\n");
  });
});

describe("issue #50 follow-on — a fully rolled-back later batch no longer supersedes", () => {
  test("explicit undo of an older batch succeeds when the later same-path batch was rolled back (was: over-refused)", () => {
    // Supersession refuses an entry whose path a LATER batch also wrote — fail closed, so an old undo can never
    // clobber newer state. But a later batch that FULLY rolled back holds no live state to clobber: every one of
    // its journaled writes was reversed. Pre-fix that batch still counted as a writer, so the older batch's undo
    // was refused with an honest-but-wrong "superseded" and the operator could not unwind it at all.
    wBlueprint("a.json", JSON.stringify({ shared: { k: "A" } }));
    wBlueprint("b.json", JSON.stringify({ shared: { k: "B" } }));
    wBlueprint("victim.md", "never lands\n");
    const a = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "r", harness: "claude-code", files: [{ transform: "config-merge", source: "a.json", destination: ".mcp.json" }] }] },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    chmodSync(join(projectRoot, ".claude", "agents"), 0o500);
    const b = apply({
      manifest: {
        schemaVersion: 1,
        roles: [
          { name: "r2", harness: "claude-code", files: [{ transform: "config-merge", source: "b.json", destination: ".mcp.json" }] },
          { name: "stray", harness: "claude-code", files: [{ transform: "copy", source: "victim.md", destination: ".claude/agents/victim.md" }] },
        ],
      },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    expect(b.rolledBack).toBe(true);
    expect(b.rollbackFailures ?? []).toEqual([]);
    expect((parseJsonProject(".mcp.json").shared as Record<string, unknown>).k).toBe("A"); // B's write was reversed

    const undone = undoBatch(projectRoot, dataDir, a.batchId!);
    expect(undone.superseded).toEqual([]); // B is rolled back ⇒ not a live writer of this path
    expect(undone.reversed).toEqual([join(projectRoot, ".mcp.json")]);
    expect(existsProject(".mcp.json")).toBe(false); // A created it ⇒ undo deletes it
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
    const undone = undoBatch(projectRoot, dataDir, b1.batchId!);
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

// Best-effort defense-in-depth against a CORRUPTED journal (bot review PR #52), NOT a security guarantee: a
// legitimate journal can never produce a cross-root batchId (unique randomUUID + one canonical root per apply),
// so these craft the journal directly — which in reality is attacker-owns-HOME, out of decision #45's threat
// model. The quarantine is documented as such; deeper crafted-journal integrity is a deferred, out-of-scope unit.
describe("bot review + post-PR gate (PR #52) — corrupt-journal quarantine (best-effort defense-in-depth)", () => {
  test("newest batch is the LAST journal entry's batch, not the last first-appearance group (A1,B1,A2 → A)", () => {
    // Recency must follow the last journal ENTRY (CodeRabbit PR #54). Interleaved batch entries A1,B1,A2 (one
    // root) end at A2, so A is newest — but first-appearance order ends at B. (Interleaving needs concurrency or
    // a crafted journal; the invariant must still hold.)
    mkdirSync(dataDir, { recursive: true });
    const base = { backupPath: null, created: true, mode: null, format: "text", projectRoot };
    const rows = [
      { ...base, id: "a1", targetPath: `${projectRoot}/A1.md`, postHash: "ha1", batchId: "A", ts: 1 },
      { ...base, id: "b1", targetPath: `${projectRoot}/B1.md`, postHash: "hb1", batchId: "B", ts: 2 },
      { ...base, id: "a2", targetPath: `${projectRoot}/A2.md`, postHash: "ha2", batchId: "A", ts: 3 },
    ];
    writeFileSync(join(dataDir, "undo-journal.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    expect(newestBatchForProject(projectRoot, dataDir)?.batchId).toBe("A");
  });

  test("a batchId appearing under two roots is quarantined out of readBatches entirely", () => {
    // Craft an untrusted journal with two entries sharing a batchId but two roots (impossible without direct writes).
    mkdirSync(dataDir, { recursive: true });
    const base = { backupPath: null, created: true, mode: null, format: "text", ts: 1 };
    const mine = { ...base, id: "e1", targetPath: `${projectRoot}/CLAUDE.md`, postHash: "h1", batchId: "shared", projectRoot };
    const foreign = { ...base, id: "e2", targetPath: "/other/project/CLAUDE.md", postHash: "h2", batchId: "shared", projectRoot: "/other/project" };
    writeFileSync(join(dataDir, "undo-journal.jsonl"), `${JSON.stringify(mine)}\n${JSON.stringify(foreign)}\n`);
    // A cross-root batchId is corruption/tampering → the WHOLE batch is dropped, reachable by neither project.
    expect(readBatches(dataDir)).toHaveLength(0);
  });

  test("default undo of project A does NOT reverse A's real files when a corrupt B-row reuses A's batchId", () => {
    // A genuine apply for project A: creates a real file + a valid journal entry carrying A's true postHash.
    wBlueprint("src/a.md", "project A instructions\n");
    const a = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "r", harness: "claude-code", files: [{ transform: "copy", source: "src/a.md", destination: "CLAUDE.md" }] }] },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    expect(existsProject("CLAUDE.md")).toBe(true);
    // Corrupt the journal: append a foreign project-B row that REUSES A's real batchId (the exact tamper the
    // post-PR gate flagged — pre-fix, default undo(B or A) resolved to A's batch and deleted A's real file).
    const base = { backupPath: null, created: true, mode: null, format: "text", ts: 9 };
    const foreign = { ...base, id: "b1", targetPath: "/other/project/CLAUDE.md", postHash: "hB", batchId: a.batchId, projectRoot: "/other/project" };
    appendFileSync(join(dataDir, "undo-journal.jsonl"), `${JSON.stringify(foreign)}\n`);
    // The batchId is now cross-root → quarantined. Default undo for EITHER project selects nothing…
    expect(undoBatch(projectRoot, dataDir).reversed).toHaveLength(0);
    expect(undoBatch("/other/project", dataDir).reversed).toHaveLength(0);
    // …and an explicit undo of the poisoned id likewise reverses nothing. A's REAL file is untouched.
    expect(undoBatch(projectRoot, dataDir, a.batchId!).reversed).toHaveLength(0);
    expect(existsProject("CLAUDE.md")).toBe(true);
    expect(rProject("CLAUDE.md")).toBe("project A instructions\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-model gate, finding 3: a SUCCESSFUL undo left no durable trace, so the journal's newest committed batch
// stayed the newest committed batch forever. After A and B write one path, undoing B restores A's bytes — but B
// remained a live writer, so the next bare `undo` re-selected B (a no-op) and an explicit undo of A was refused
// as superseded. The operator could not walk back through otherwise reversible history. `undone` is the third
// terminal state that closes it, recorded ONLY when the undo left nothing live (see `undoBatch`).
// ─────────────────────────────────────────────────────────────────────────────
describe("gate finding 3 — a fully successful undo records `undone`, so history walks back", () => {
  const SHARED_DEST = ".claude/agents/shared.md";

  /** Two COMMITTED batches writing the SAME destination: A creates it ("A"), B overwrites it ("B"). */
  function twoBatchesOneDest(): { a: ReturnType<typeof apply>; b: ReturnType<typeof apply> } {
    const mk = (): Manifest => ({
      schemaVersion: 1,
      roles: [{ name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "shared.md", destination: SHARED_DEST }] }],
    });
    wBlueprint("shared.md", "A\n");
    const a = apply({ manifest: mk(), blueprintRoot, projectRoot, dataDir });
    wBlueprint("shared.md", "B\n");
    const b = apply({ manifest: mk(), blueprintRoot, projectRoot, dataDir });
    expect(rProject(SHARED_DEST)).toBe("B\n");
    return { a, b };
  }

  test("a fully successful undo records the `undone` terminal state", () => {
    const { b } = twoBatchesOneDest();
    const out = undoBatch(projectRoot, dataDir);
    expect(out.batchId).toBe(b.batchId);
    expect(out.reversed).toEqual([join(projectRoot, SHARED_DEST)]);
    expect(readBatchStatuses(dataDir).get(b.batchId!)?.status).toBe("undone");
  });

  test("two successive BARE undos walk back through B then A", () => {
    const { a, b } = twoBatchesOneDest();

    const first = undoBatch(projectRoot, dataDir);
    expect(first.batchId).toBe(b.batchId);
    expect(rProject(SHARED_DEST)).toBe("A\n"); // B's undo restored A's bytes — A's own undo would now succeed

    const second = undoBatch(projectRoot, dataDir);
    expect(second.batchId).toBe(a.batchId); // pre-fix: B again, because B was still the newest COMMITTED batch
    expect(second.reversed).toEqual([join(projectRoot, SHARED_DEST)]);
    expect(existsProject(SHARED_DEST)).toBe(false); // A created it ⇒ its undo deletes it
  });

  test("after undoing B, an EXPLICIT undo of A is no longer refused as superseded", () => {
    const { a } = twoBatchesOneDest();
    expect(undoBatch(projectRoot, dataDir).reversed).toHaveLength(1); // bare undo reverses B

    const out = undoBatch(projectRoot, dataDir, a.batchId!);
    expect(out.superseded).toEqual([]); // pre-fix: refused — B still counted as a live writer of this path
    expect(out.reversed).toEqual([join(projectRoot, SHARED_DEST)]);
    expect(out.failed).toEqual([]);
    expect(existsProject(SHARED_DEST)).toBe(false);
  });

  test("a PARTIAL undo (one entry fails) records NOTHING — the batch stays default-selectable (fail-safe)", () => {
    // The same discipline apply's abort path already keeps for a partial rollback: a batch that still holds live
    // state must stay UNKNOWN, so a plain `undo` can still reach it. Recording `undone` here would strand the
    // un-reversed file behind an explicit `--batch` id.
    wBlueprint("one.md", "one\n");
    wBlueprint("two.md", "two\n");
    const a = apply({
      manifest: {
        schemaVersion: 1,
        roles: [
          {
            name: "architect",
            harness: "claude-code",
            files: [
              { transform: "copy", source: "one.md", destination: ".claude/agents/one.md" },
              { transform: "copy", source: "two.md", destination: ".claude/agents/two.md" },
            ],
          },
        ],
      },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    wProject(".claude/agents/two.md", "hand-edited\n"); // diverged from its postHash ⇒ `undo` refuses it

    const out = undoBatch(projectRoot, dataDir);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]!.path).toBe(join(projectRoot, ".claude/agents/two.md"));
    expect(out.reversed).toEqual([join(projectRoot, ".claude/agents/one.md")]);

    expect(readBatchStatuses(dataDir).get(a.batchId!)?.status).toBe("committed"); // NOT `undone`
    expect(newestBatchForProject(projectRoot, dataDir)?.batchId).toBe(a.batchId!); // still the default target
  });

  test("an undo whose every entry is SUPERSEDED records NOTHING — nothing was actually reversed", () => {
    // Explicitly undoing A while B's state is live: every entry is refused fail-closed, so A still holds the
    // journaled writes it always did. A `undone` record here would drop A from the live-writer index on the
    // strength of an undo that touched no file at all.
    const { a } = twoBatchesOneDest();

    const out = undoBatch(projectRoot, dataDir, a.batchId!);
    expect(out.superseded).toHaveLength(1);
    expect(out.reversed).toEqual([]);

    expect(readBatchStatuses(dataDir).get(a.batchId!)?.status).toBe("committed"); // NOT `undone`
    expect(rProject(SHARED_DEST)).toBe("B\n"); // B's state untouched
  });

  test("an `undone` batch is skipped by DEFAULT selection, and an explicit undo of it under newer state is a no-op", () => {
    // Under newer live state, an explicit undo of a spent batch must never clobber that state. Since gate round 4
    // a fully-reversed batch short-circuits BEFORE supersession is even consulted: its entries report in
    // `alreadyReversed` and `undo` never runs (the stronger guarantee — see the round-4 resurrection test).
    const { a, b } = twoBatchesOneDest();
    expect(undoBatch(projectRoot, dataDir).batchId).toBe(b.batchId); // B → `undone`

    // A third batch re-writes the shared path, so B's (undone) entries are now under newer live state.
    wBlueprint("shared.md", "C\n");
    const c = apply({
      manifest: {
        schemaVersion: 1,
        roles: [{ name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "shared.md", destination: SHARED_DEST }] }],
      },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    expect(newestBatchForProject(projectRoot, dataDir)?.batchId).toBe(c.batchId!); // B is skipped, C selected

    const out = undoBatch(projectRoot, dataDir, b.batchId!);
    expect(out.reversed).toEqual([]);
    expect(out.superseded).toEqual([]);
    expect(out.alreadyReversed).toEqual([join(projectRoot, SHARED_DEST)]); // B spent — reported, not attempted
    expect(rProject(SHARED_DEST)).toBe("C\n");
    expect(a.batchId).not.toBeNull();
  });

  test("gate round 4: re-running an explicit undo of a retired batch never resurrects its change", () => {
    // X exists (x0) → A sets y → B sets x0 back. Undo B (disk y), undo A (disk x0): both retired `undone`. Disk
    // now matches B's postHash again, so pre-fix an explicit retry of B re-applied B's backup (y) — a resurrected
    // change that no bare `undo` could ever find again, since every batch still claimed `undone`.
    const mk = (): Manifest => ({
      schemaVersion: 1,
      roles: [{ name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "shared.md", destination: SHARED_DEST }] }],
    });
    wProject(SHARED_DEST, "x0\n");
    wBlueprint("shared.md", "y\n");
    const a = apply({ manifest: mk(), blueprintRoot, projectRoot, dataDir });
    wBlueprint("shared.md", "x0\n");
    const b = apply({ manifest: mk(), blueprintRoot, projectRoot, dataDir });

    expect(undoBatch(projectRoot, dataDir, b.batchId!).reversed).toHaveLength(1);
    expect(rProject(SHARED_DEST)).toBe("y\n");
    expect(undoBatch(projectRoot, dataDir, a.batchId!).reversed).toHaveLength(1);
    expect(rProject(SHARED_DEST)).toBe("x0\n");

    const retry = undoBatch(projectRoot, dataDir, b.batchId!);
    expect(retry.batchId).toBe(b.batchId);
    expect(retry.reversed).toEqual([]);
    expect(retry.superseded).toEqual([]);
    expect(retry.failed).toEqual([]);
    expect(retry.alreadyReversed).toEqual([join(projectRoot, SHARED_DEST)]);
    expect(rProject(SHARED_DEST)).toBe("x0\n"); // pre-fix: "y\n"
    expect(readBatchStatuses(dataDir).get(b.batchId!)?.status).toBe("undone");
  });

  test("gate round 7: terminal-state history that EXISTS but cannot be read refuses undo — never resurrects", () => {
    // Same walk-back as above, then the history becomes unreadable (here: a directory, which hits the same
    // non-regular guard an oversized file does). Pre-fix that read as "no records", so a bare `undo` re-selected
    // the spent B, matched its postHash on disk, and re-applied y while reporting success.
    const mk = (): Manifest => ({
      schemaVersion: 1,
      roles: [{ name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "shared.md", destination: SHARED_DEST }] }],
    });
    wProject(SHARED_DEST, "x0\n");
    wBlueprint("shared.md", "y\n");
    const a = apply({ manifest: mk(), blueprintRoot, projectRoot, dataDir });
    wBlueprint("shared.md", "x0\n");
    const b = apply({ manifest: mk(), blueprintRoot, projectRoot, dataDir });
    undoBatch(projectRoot, dataDir, b.batchId!);
    undoBatch(projectRoot, dataDir, a.batchId!);
    expect(rProject(SHARED_DEST)).toBe("x0\n");

    rmSync(batchStatusPath(dataDir));
    mkdirSync(batchStatusPath(dataDir));

    const bare = undoBatch(projectRoot, dataDir);
    expect(bare.reversed).toEqual([]);
    expect(bare.failed).toHaveLength(1);
    expect(bare.failed[0]!.error).toContain("cannot be read");
    expect(rProject(SHARED_DEST)).toBe("x0\n"); // pre-fix: "y\n"
    expect(undoBatch(projectRoot, dataDir, b.batchId!).failed).toHaveLength(1); // explicit is refused too
    expect(rProject(SHARED_DEST)).toBe("x0\n");

    // An ABSENT history is the per-batch-unknown case, not lost history: undo proceeds (legacy journals).
    rmSync(batchStatusPath(dataDir), { recursive: true });
    expect(undoBatch(projectRoot, dataDir).failed.every((f) => !f.error.includes("cannot be read"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-model gate, finding 4: an all-noop apply (the common case — the fine-tune loop makes re-apply routine)
// reported a fresh batch UUID and told the operator to `undo` it, but journaled nothing, so no such batch exists.
// The displayed id could not be undone, while a bare `undo` — invited by that very line — reversed an OLDER real
// batch instead. `batchId` is now non-null IFF the run journaled at least one reversible write.
// ─────────────────────────────────────────────────────────────────────────────
describe("gate finding 4 — a run that journals nothing advertises no batch", () => {
  test("a repeat apply that changes nothing reports batchId null and records no terminal state", () => {
    writeAe1Sources();
    const first = run();
    expect(first.batchId).not.toBeNull();
    expect(readBatchStatuses(dataDir).get(first.batchId!)?.status).toBe("committed");

    const second = run();
    expect(second.applied).toEqual([]);
    expect(second.noops).toHaveLength(9);
    expect(second.failed).toEqual([]);
    expect(second.batchId).toBeNull(); // pre-fix: a fresh UUID naming a batch with no journal entries

    // The no-op run added NOTHING durable: no journal batch and no orphan status record.
    expect(readBatches(dataDir)).toHaveLength(1);
    expect(readBatches(dataDir)[0]!.batchId).toBe(first.batchId!);
    expect(readBatchStatuses(dataDir).size).toBe(1);
    // …so the set of undoable batches is exactly what it was before the re-apply.
    expect(newestBatchForProject(projectRoot, dataDir)?.batchId).toBe(first.batchId!);
  });

  test("a PREFLIGHT failure (nothing written, nothing journaled) also advertises no batch", () => {
    wBlueprint("a.md", "alpha\n");
    const outcome = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "r", harness: "claude-code", files: [{ transform: "copy", source: "a.md", destination: "nowhere/at/all.md" }] }] },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.batchId).toBeNull();
    expect(readBatchStatuses(dataDir).size).toBe(0);
  });

  test("a run whose EVERY write was applied-but-unjournaled also advertises no batch — and says so honestly", () => {
    // The other route to a null id, and the one that must NOT read as "nothing changed": every write LANDED (the
    // project is writable) but none could be journaled (the journal is not), so files really did change and only
    // the reversibility is missing. Reachable for real when the data dir is unwritable while the project is not.
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("second.md", "# Architect\n");
    const neverJournals: ProvisionEngine = {
      mergeConfig: (t, p, o) => mergeConfig(t, p, o),
      writeTextFile: (t, c, o) => {
        const res = writeTextFile(t, c, o); // the write LANDS
        throw new AppliedButUnjournaledError(t, res.backupPath, new Error("injected journal failure"));
      },
    };
    const outcome = apply(
      {
        manifest: {
          schemaVersion: 1,
          roles: [
            { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
            { name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "second.md", destination: "CLAUDE.md" }] },
          ],
        },
        blueprintRoot,
        projectRoot,
        dataDir,
      },
      { engine: neverJournals },
    );
    expect(outcome.rolledBack).toBe(false); // an unjournaled write is warn-and-continue, not an abort
    expect(outcome.applied).toHaveLength(2);
    expect(outcome.applied.every((w) => w.unjournaled)).toBe(true);
    expect(existsProject("AGENTS.md")).toBe(true); // the bytes ARE on disk
    expect(existsProject("CLAUDE.md")).toBe(true);

    expect(outcome.batchId).toBeNull(); // nothing journaled ⇒ nothing `undo` can find
    expect(readBatchStatuses(dataDir).size).toBe(0); // …and no orphan `committed` row
    // (The fixture calls the REAL engine and then throws the error, so a journal entry does exist here that a
    // production AppliedButUnjournaledError would not have left. `apply` decides off its own rollback list —
    // an undoId it never received — which is the production signal, so the outcome above is the honest one.)
  });

  test("an ABORTED apply that DID journal keeps its batch id — its entries are still reachable by id", () => {
    // The counter-case to the two above: nulling the id here would hide a batch whose journal entries exist (and,
    // when a rollback itself failed, whose files are still on disk). Only a run that journaled NOTHING goes null.
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("victim.md", "never lands\n");
    mkdirSync(join(projectRoot, ".claude", "agents"), { recursive: true });
    chmodSync(join(projectRoot, ".claude", "agents"), 0o500);
    const outcome = apply({
      manifest: {
        schemaVersion: 1,
        roles: [
          { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
          { name: "stray", harness: "claude-code", files: [{ transform: "copy", source: "victim.md", destination: ".claude/agents/victim.md" }] },
        ],
      },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.batchId).not.toBeNull();
    expect(readBatches(dataDir).map((b) => b.batchId)).toContain(outcome.batchId!);
    expect(readBatchStatuses(dataDir).get(outcome.batchId!)?.status).toBe("rolled-back");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-model gate round 2, finding 3: a MIXED batch — some writes journaled, one applied-but-unjournaled —
// could be retired as fully `undone`. `undo` reverses only what the journal shows, so reversing every visible
// entry left the invisible survivor live while the durable record claimed the batch held nothing. Future bare
// undos then skipped it, and the last trace of the stranded file was gone. Reachable from an ORDINARY journal
// append failure (a full disk mid-batch) — no attacker, so squarely inside decision #45.
// ─────────────────────────────────────────────────────────────────────────────
describe("gate round 2 finding 3 — a batch with an unjournaled survivor is never retired as undone", () => {
  test("undoing every journaled entry does NOT record `undone` while a survivor is live", () => {
    wBlueprint("first.md", "# Executor\n");
    wBlueprint("second.md", "stranded survivor\n");
    // Row 1 journals normally; row 2 LANDS but its journal append fails — the mixed batch the gate describes.
    const flaky: ProvisionEngine = {
      mergeConfig,
      writeTextFile: (t, c, o) => {
        // The survivor must land WITHOUT a journal entry, or the fixture is not the bug: calling the real
        // `writeTextFile` first would journal it, and `undo` would then reverse it like any other row. Write
        // the bytes directly and throw — exactly what production leaves behind when the rename succeeds and
        // the journal append then fails.
        if (t.endsWith(".cursor/agents/qa.md")) {
          mkdirSync(dirname(t), { recursive: true });
          writeFileSync(t, c);
          throw new AppliedButUnjournaledError(t, null, new Error("injected journal failure"));
        }
        return writeTextFile(t, c, o);
      },
    };
    const outcome = apply(
      {
        manifest: {
          schemaVersion: 1,
          roles: [
            { name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] },
            { name: "qa", harness: "cursor", files: [{ transform: "copy", source: "second.md", destination: ".cursor/agents/qa.md" }] },
          ],
        },
        blueprintRoot,
        projectRoot,
        dataDir,
      },
      { engine: flaky },
    );

    // The apply SUCCEEDED — one journaled write, one live-but-un-undoable survivor.
    expect(outcome.batchId).not.toBeNull();
    expect(outcome.applied.filter((w) => w.unjournaled)).toHaveLength(1);
    expect(readBatchStatuses(dataDir).get(outcome.batchId!)?.stranded).toBe(true);

    // Undo reverses every entry the journal HAS, and reports a clean sweep of them…
    const undone = undoBatch(projectRoot, dataDir);
    expect(undone.failed).toEqual([]);
    expect(undone.superseded).toEqual([]);
    expect(undone.reversed).toEqual([join(projectRoot, "AGENTS.md")]);

    // …but the survivor is still on disk, so the batch must NOT be retired.
    expect(existsProject(".cursor/agents/qa.md")).toBe(true);
    expect(readBatchStatuses(dataDir).get(outcome.batchId!)?.status).toBe("committed");
    // Still default-selectable — the fail-safe side, so the stranded file stays reachable.
    expect(newestBatchForProject(projectRoot, dataDir)?.batchId).toBe(outcome.batchId!);
  });

  test("a batch with NO survivor still retires normally (the guard is not over-broad)", () => {
    wBlueprint("first.md", "# Executor\n");
    const clean = apply({
      manifest: { schemaVersion: 1, roles: [{ name: "executor", harness: "codex", files: [{ transform: "copy", source: "first.md", destination: "AGENTS.md" }] }] },
      blueprintRoot,
      projectRoot,
      dataDir,
    });
    expect(readBatchStatuses(dataDir).get(clean.batchId!)?.stranded).toBeUndefined();
    undoBatch(projectRoot, dataDir);
    expect(readBatchStatuses(dataDir).get(clean.batchId!)?.status).toBe("undone");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate round 3: the round-2 stranded guard keyed on an AFFIRMATIVE stranded record, so a MISSING record read
// as "not stranded" and the batch was retired anyway. Both ways a record goes missing are ordinary, not
// adversarial — hence two regressions, one per path.
// ─────────────────────────────────────────────────────────────────────────────
describe("gate round 3 — an unknown survivor state never permits retirement", () => {
  /** An engine whose write for `landsUnjournaled` lands the bytes with NO journal entry (what production
   *  leaves when the rename succeeds and the journal append fails), and whose write for `hardFails` throws. */
  const mixedEngine = (landsUnjournaled: string, hardFails?: string): ProvisionEngine => ({
    mergeConfig,
    writeTextFile: (t, c, o) => {
      if (t.endsWith(landsUnjournaled)) {
        mkdirSync(dirname(t), { recursive: true });
        writeFileSync(t, c);
        throw new AppliedButUnjournaledError(t, null, new Error("injected journal failure"));
      }
      if (hardFails && t.endsWith(hardFails)) throw new Error("injected hard write failure");
      return writeTextFile(t, c, o);
    },
  });

  test("a mixed batch that later ABORTS is not retired — the abort path records it `partial` and stranded", () => {
    // apply's abort path records `partial` with the stranded flag when a survivor exists (PR #61; before that it
    // recorded nothing). Either way `undo` must not retire it: the survivor has no entry for `undo` to reverse.
    wBlueprint("a.md", "alpha\n");
    wBlueprint("b.md", "stranded survivor\n");
    wBlueprint("c.md", "never lands\n");
    const outcome = apply(
      {
        manifest: {
          schemaVersion: 1,
          roles: [
            { name: "executor", harness: "codex", files: [{ transform: "copy", source: "a.md", destination: "AGENTS.md" }] },
            { name: "qa", harness: "cursor", files: [{ transform: "copy", source: "b.md", destination: ".cursor/agents/qa.md" }] },
            { name: "architect", harness: "claude-code", files: [{ transform: "copy", source: "c.md", destination: ".claude/agents/architect.md" }] },
          ],
        },
        blueprintRoot,
        projectRoot,
        dataDir,
      },
      { engine: mixedEngine(".cursor/agents/qa.md", ".claude/agents/architect.md") },
    );

    expect(outcome.rolledBack).toBe(true);
    expect(existsProject(".cursor/agents/qa.md")).toBe(true); // the survivor is live
    expect(readBatchStatuses(dataDir).get(outcome.batchId!)).toMatchObject({ status: "partial", stranded: true });

    undoBatch(projectRoot, dataDir);
    // A stranded survivor must refuse retirement, so the batch stays reachable and its trace survives.
    expect(readBatchStatuses(dataDir).get(outcome.batchId!)?.status).toBe("partial");
    expect(newestBatchForProject(projectRoot, dataDir)?.batchId).toBe(outcome.batchId!);
  });

  test("a mixed batch whose status APPEND FAILED is not retired either", () => {
    // The other ordinary path to a missing record: status writes are best-effort. Simulated by erasing the
    // record after the apply, which is indistinguishable from the append never landing.
    wBlueprint("a.md", "alpha\n");
    wBlueprint("b.md", "stranded survivor\n");
    const outcome = apply(
      {
        manifest: {
          schemaVersion: 1,
          roles: [
            { name: "executor", harness: "codex", files: [{ transform: "copy", source: "a.md", destination: "AGENTS.md" }] },
            { name: "qa", harness: "cursor", files: [{ transform: "copy", source: "b.md", destination: ".cursor/agents/qa.md" }] },
          ],
        },
        blueprintRoot,
        projectRoot,
        dataDir,
      },
      { engine: mixedEngine(".cursor/agents/qa.md") },
    );
    expect(readBatchStatuses(dataDir).get(outcome.batchId!)?.stranded).toBe(true);
    rmSync(batchStatusPath(dataDir), { force: true }); // the append never landed

    undoBatch(projectRoot, dataDir);
    expect(readBatchStatuses(dataDir).get(outcome.batchId!)?.status).toBeUndefined();
    expect(existsProject(".cursor/agents/qa.md")).toBe(true);
  });
});
