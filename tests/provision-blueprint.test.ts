import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { jsonSchemas, Manifest } from "../src/contract/index";
import {
  type BlueprintLoad,
  checkSchemaVersion,
  loadBlueprint,
  MANIFEST_FILENAME,
  MIN_SCHEMA_VERSION,
  sourcesOf,
  SUPPORTED_SCHEMA_VERSION,
} from "../src/provision/blueprint";
import { type BlueprintIo, containsSecret, hasMachineAbsolutePath, type ReadOutcome } from "../src/provision/internal";

// Fixture-HOME pattern (like tests/scan.test.ts): a temp dir per test standing in for a blueprint root, torn
// down after. The loader is a pure disk read, so the disk IS the state under test — no db/repo needed.
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bp-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── real-io fixture builders ──
function writeFile(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function writeManifest(value: unknown): void {
  writeFile(MANIFEST_FILENAME, JSON.stringify(value));
}
function writeRawManifest(raw: string): void {
  writeFile(MANIFEST_FILENAME, raw);
}

// ── injected-io fixture: root "" makes the loader request relative paths = these map keys ──
function fakeIo(files: Record<string, string>, blocked: Set<string> = new Set()): BlueprintIo {
  return {
    readFileBounded(path: string): ReadOutcome {
      if (blocked.has(path)) return { ok: false, reason: "blocked" };
      if (path in files) return { ok: true, content: files[path]! };
      return { ok: false, reason: "absent" };
    },
  };
}

// ── narrowing assertion (expect + type guard in one) ──
function assertKind<K extends BlueprintLoad["kind"]>(
  r: BlueprintLoad,
  kind: K,
): asserts r is Extract<BlueprintLoad, { kind: K }> {
  expect(r.kind).toBe(kind);
}

const VALID_KINDS: readonly BlueprintLoad["kind"][] = ["loaded", "absent", "schema-incompatible", "secret-hit", "invalid"];

// A token that matches the `sk-…` secret pattern in src/capture/secret-classify.ts (16+ body chars).
const SECRET = "sk-ant-api03-ABCDEFGHIJKLMNOP1234";

// ── the run-1-shaped blueprint (the lived agent-cost-tracker map: 12 destinations across 3 role bundles) ──
function run1Manifest(): Manifest {
  return {
    schemaVersion: 1,
    roles: [
      {
        name: "QA",
        harness: "cursor",
        files: [
          { transform: "copy", source: "roles/variants/cursor/agents/qa-smoke.md", destination: ".cursor/agents/qa-smoke.md" },
          { transform: "copy", source: "roles/variants/cursor/agents/qa-regression.md", destination: ".cursor/agents/qa-regression.md" },
          { transform: "copy", source: "roles/variants/cursor/agents/qa-browser-e2e.md", destination: ".cursor/agents/qa-browser-e2e.md" },
          { transform: "copy", source: "roles/variants/cursor/agents/qa-skeptic-verifier.md", destination: ".cursor/agents/qa-skeptic-verifier.md" },
          { transform: "copy", source: "roles/variants/cursor/skills/qa-gate/SKILL.md", destination: ".cursor/skills/qa-gate/SKILL.md" },
          { transform: "copy", source: "roles/variants/cursor/skills/qa-gate/claude-invocation.md", destination: ".cursor/skills/qa-gate/claude-invocation.md" },
          { transform: "config-merge", source: "registrations/cursor-playwright-mcp.json", destination: ".cursor/mcp.json" },
        ],
      },
      {
        name: "Executor",
        harness: "codex",
        model: "gpt-5-codex", // descriptive pin — round-trips, drives no file op
        files: [
          // Non-1:1 (R3): one role → TWO native destinations.
          { transform: "copy", source: "roles/variants/codex/AGENTS.md", destination: "AGENTS.md" },
          { transform: "copy", source: "roles/variants/codex/executor.toml", destination: ".codex/agents/executor.toml" },
          { transform: "scaffold", source: "roles/variants/codex/README.md", destination: ".codex/README.md" },
        ],
      },
      {
        name: "Orchestrator",
        harness: "claude-code",
        model: "claude-opus-4-8",
        files: [
          // Non-1:1 (R3): THREE ordered sources compose → one native file.
          {
            transform: "compose",
            sources: [
              "roles/variants/claude-code/orchestrator.md",
              "roles/variants/claude-code/architect.md",
              "roles/variants/claude-code/reviewer.md",
            ],
            destination: "CLAUDE.md",
          },
          { transform: "scaffold", destination: ".claude/agents/README.md" }, // placeholder — no source
        ],
      },
    ],
  };
}

/** Write a benign, portable, secret-free source file for every source the manifest references. */
function writeAllSources(m: Manifest): void {
  for (const role of m.roles) {
    for (const entry of role.files) {
      // sourcesOf is the loader's own exhaustive source resolver — reused so a future 5th transform can't
      // silently stop getting fixture files written (its assertNever fails the build; a hand-rolled ternary
      // would return []). It only writes files here, asserting nothing, so it can't mask a loader defect.
      for (const s of sourcesOf(entry)) writeFile(s, benignContent(s));
    }
  }
}
function benignContent(src: string): string {
  if (src.endsWith(".json")) {
    return JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest", "--headless"] } } });
  }
  if (src.endsWith(".toml")) return `# executor\nmodel = "gpt-5-codex"\n`;
  return `# ${src}\nBenign portable role content.\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("loadBlueprint — happy path (run-1 shape)", () => {
  test("a run-1-shaped manifest parses; role/harness/model/file metadata round-trips", () => {
    const m = run1Manifest();
    writeManifest(m);
    writeAllSources(m);

    const result = loadBlueprint(root);
    assertKind(result, "loaded");

    // Whole manifest round-trips byte-for-structure (no schema defaults injected).
    expect(result.manifest).toEqual(m);
    // Re-parsing the loaded manifest is idempotent (contract conformance).
    expect(() => Manifest.parse(result.manifest)).not.toThrow();

    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.manifest.roles.map((r) => r.name)).toEqual(["QA", "Executor", "Orchestrator"]);
    expect(result.manifest.roles.map((r) => r.harness)).toEqual(["cursor", "codex", "claude-code"]);
    // model pin: present where set, absent where not.
    expect(result.manifest.roles[1]!.model).toBe("gpt-5-codex");
    expect(result.manifest.roles[0]!.model).toBeUndefined();
  });

  test("non-1:1 (R3): Codex role maps to two native destinations", () => {
    const m = run1Manifest();
    writeManifest(m);
    writeAllSources(m);

    const result = loadBlueprint(root);
    assertKind(result, "loaded");
    const codex = result.manifest.roles.find((r) => r.harness === "codex")!;
    const dests = codex.files.map((f) => f.destination);
    expect(dests).toContain("AGENTS.md");
    expect(dests).toContain(".codex/agents/executor.toml");
  });

  test("non-1:1 (R3): compose carries three ORDERED sources into one destination", () => {
    const m = run1Manifest();
    writeManifest(m);
    writeAllSources(m);

    const result = loadBlueprint(root);
    assertKind(result, "loaded");
    const compose = result.manifest.roles
      .flatMap((r) => r.files)
      .find((f) => f.transform === "compose")!;
    expect(compose.transform).toBe("compose");
    if (compose.transform === "compose") {
      expect(compose.sources).toEqual([
        "roles/variants/claude-code/orchestrator.md",
        "roles/variants/claude-code/architect.md",
        "roles/variants/claude-code/reviewer.md",
      ]);
    }
  });

  test("scaffold without a source is legal (create-only placeholder)", () => {
    const m = run1Manifest();
    writeManifest(m);
    writeAllSources(m);

    const result = loadBlueprint(root);
    assertKind(result, "loaded");
    const placeholder = result.manifest.roles
      .flatMap((r) => r.files)
      .find((f) => f.destination === ".claude/agents/README.md")!;
    expect(placeholder.transform).toBe("scaffold");
    if (placeholder.transform === "scaffold") expect(placeholder.source).toBeUndefined();
  });

  test("generalizes to a structurally different blueprint (different roles / harness mix / drift flag)", () => {
    // Not the run-1 fixture — a different role set, harness mix, and an explicit driftTracked flag.
    const m: Manifest = {
      schemaVersion: 1,
      roles: [
        { name: "Writer", harness: "hermes", files: [{ transform: "copy", source: "a.md", destination: "OUT.md", driftTracked: false }] },
        { name: "Merger", harness: "claude-code", files: [{ transform: "compose", sources: ["x.md", "y.md"], destination: "Z.md" }] },
      ],
    };
    writeManifest(m);
    writeAllSources(m);

    const result = loadBlueprint(root);
    assertKind(result, "loaded");
    expect(result.manifest.roles[0]!.harness).toBe("hermes");
    const copy = result.manifest.roles[0]!.files[0]!;
    expect(copy.transform).toBe("copy");
    if (copy.transform === "copy") expect(copy.driftTracked).toBe(false); // flag round-trips for U3
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("loadBlueprint — schema edges", () => {
  test("unknown manifest key rejected (strictObject)", () => {
    writeManifest({ schemaVersion: 1, roles: [], extra: true });
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("schema");
  });

  test("unknown role-bundle key rejected (strictObject)", () => {
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "codex", files: [], bogus: 1 }] });
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("schema");
  });

  test("empty roles array is legal", () => {
    writeManifest({ schemaVersion: 1, roles: [] });
    const result = loadBlueprint(root);
    assertKind(result, "loaded");
    expect(result.manifest.roles).toEqual([]);
  });

  test("a role with an empty files array is legal (a declared role not yet carrying surfaces)", () => {
    writeManifest({ schemaVersion: 1, roles: [{ name: "Declared", harness: "claude-code", files: [] }] });
    const result = loadBlueprint(root);
    assertKind(result, "loaded");
    expect(result.manifest.roles[0]!.files).toEqual([]);
  });

  test("schema detail carries field PATHS + zod CODES only, never received values", () => {
    // A wrong-typed harness value that must NOT leak into the detail string.
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "not-a-real-harness-VALUE", files: [] }] });
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("schema");
    expect(result.detail).toBeDefined();
    expect(result.detail).not.toContain("not-a-real-harness-VALUE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("loadBlueprint — schemaVersion compatibility (R1)", () => {
  test("newer than supported → explicit 'upgrade agent-os' instruction", () => {
    writeManifest({ schemaVersion: SUPPORTED_SCHEMA_VERSION + 1, roles: [] });
    const result = loadBlueprint(root);
    assertKind(result, "schema-incompatible");
    expect(result.direction).toBe("too-new");
    expect(result.found).toBe(SUPPORTED_SCHEMA_VERSION + 1);
    expect(result.message.toLowerCase()).toContain("upgrade agent-os");
  });

  test("newer version wins over unknown fields — version is checked BEFORE strict parse", () => {
    // A newer manifest carrying a field this engine doesn't know must upgrade, not schema-error.
    writeManifest({ schemaVersion: SUPPORTED_SCHEMA_VERSION + 1, roles: [], futureField: { deep: true } });
    const result = loadBlueprint(root);
    assertKind(result, "schema-incompatible");
    expect(result.direction).toBe("too-new");
  });

  test("checkSchemaVersion: both compat branches testable at any floor; the default window is live (unit)", () => {
    // At MIN == 1 the too-old branch is unreachable via loadBlueprint (nothing valid sits below the floor) —
    // it activates when a future v2 raises MIN. checkSchemaVersion is pure in its window, so prove both
    // directions and the boundaries here by injecting the supported range.
    const tooOld = checkSchemaVersion(1, { min: 2, max: 2 });
    if (tooOld?.kind !== "schema-incompatible") throw new Error(`expected schema-incompatible, got ${tooOld?.kind}`);
    expect(tooOld.direction).toBe("too-old");
    expect(tooOld.message.toLowerCase()).toContain("migrate");

    const tooNew = checkSchemaVersion(3, { min: 1, max: 2 });
    if (tooNew?.kind !== "schema-incompatible") throw new Error(`expected schema-incompatible, got ${tooNew?.kind}`);
    expect(tooNew.direction).toBe("too-new");
    expect(tooNew.message.toLowerCase()).toContain("upgrade agent-os");

    expect(checkSchemaVersion(2, { min: 1, max: 2 })).toBeNull(); // in-range → compatible
    const bad = checkSchemaVersion(null);
    if (bad?.kind !== "invalid") throw new Error("expected invalid for null peek");
    expect(bad.problem).toBe("bad-schema-version");

    // The default window is the module's live [MIN, SUPPORTED]; boundary versions are compatible.
    expect(checkSchemaVersion(MIN_SCHEMA_VERSION)).toBeNull();
    expect(checkSchemaVersion(SUPPORTED_SCHEMA_VERSION)).toBeNull();
  });

  test("missing / non-integer schemaVersion → invalid (bad-schema-version), NOT mislabeled too-old", () => {
    writeManifest({ roles: [] }); // absent
    const r1 = loadBlueprint(root);
    assertKind(r1, "invalid");
    expect(r1.problem).toBe("bad-schema-version");

    writeManifest({ schemaVersion: "one", roles: [] }); // non-integer
    const r2 = loadBlueprint(root);
    assertKind(r2, "invalid");
    expect(r2.problem).toBe("bad-schema-version");
  });

  test("zero / negative schemaVersion → invalid (bad-schema-version), NOT too-old", () => {
    // 0 and negatives are not "an old version" — they are not valid versions at all (schema is .min(1)).
    // peekSchemaVersion must reject them so they route to bad-schema-version, never a bogus "migrate to v1".
    for (const v of [0, -3]) {
      writeManifest({ schemaVersion: v, roles: [] });
      const result = loadBlueprint(root);
      assertKind(result, "invalid");
      expect(result.problem).toBe("bad-schema-version");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("loadBlueprint — front-gate (secret + absolute-path, R4/KTD5)", () => {
  test("a secret in a source file → secret-hit naming the file, with ZERO content echoed", () => {
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "codex", files: [{ transform: "copy", source: "role.md", destination: "AGENTS.md" }] }] });
    writeFile("role.md", `# role\nexport TOKEN=${SECRET}\n`);

    const result = loadBlueprint(root);
    assertKind(result, "secret-hit");
    expect(result.file).toBe("role.md");
    // No blueprint content (the secret) anywhere in the result.
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("a secret in the manifest itself → secret-hit naming the manifest, ZERO content echoed", () => {
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "codex", model: SECRET, files: [] }] });
    const result = loadBlueprint(root);
    assertKind(result, "secret-hit");
    expect(result.file).toBe(MANIFEST_FILENAME);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("a machine-specific absolute path in a source file → invalid(absolute-path), ZERO content echoed", () => {
    const ABS = "/Users/jarod/notes/private.md";
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "codex", files: [{ transform: "copy", source: "role.md", destination: "AGENTS.md" }] }] });
    writeFile("role.md", `# role\nSee ${ABS} for details.\n`);

    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("absolute-path");
    expect(result.file).toBe("role.md");
    expect(JSON.stringify(result)).not.toContain(ABS);
  });

  test("secret is caught even when it sits in a COMPOSE source (every source is gated)", () => {
    writeManifest({
      schemaVersion: 1,
      roles: [{ name: "X", harness: "claude-code", files: [{ transform: "compose", sources: ["a.md", "b.md"], destination: "CLAUDE.md" }] }],
    });
    writeFile("a.md", "# a\nclean\n");
    writeFile("b.md", `# b\nAuthorization: Bearer ${SECRET}\n`);

    const result = loadBlueprint(root);
    assertKind(result, "secret-hit");
    expect(result.file).toBe("b.md");
  });

  test("a JSON-unicode-escaped secret in the manifest → secret-hit (a raw-byte scan alone would miss it)", () => {
    // The secret is hidden behind a \uXXXX escape (the 'a' of api03): the RAW bytes read clean — the sk-
    // regex breaks at the backslash — but JSON.parse decodes it back into loaded.manifest.model. Scanning
    // only the raw manifest bytes would certify this blueprint secret-free and hand the live credential to a
    // downstream consumer (U3 render / status / propose). The gate must scan the parsed form too.
    const BACKSLASH = String.fromCharCode(92);
    const escapedModel = `sk-ant-${BACKSLASH}u0061pi03-ABCDEFGHIJKLMNOP1234`; // a = "a" -> decodes to SECRET
    writeRawManifest(`{"schemaVersion":1,"roles":[{"name":"X","harness":"codex","model":"${escapedModel}","files":[]}]}`);

    const result = loadBlueprint(root);
    assertKind(result, "secret-hit");
    expect(result.file).toBe(MANIFEST_FILENAME);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("a JSON-unicode-escaped machine-absolute path in the manifest → invalid(absolute-path)", () => {
    // Same escape asymmetry for R4's path check: / is "/", so the raw bytes hide "/Users/..." but the
    // parsed model carries it. The parsed-form scan must catch it.
    const BACKSLASH = String.fromCharCode(92);
    const escapedPath = `${BACKSLASH}u002fUsers${BACKSLASH}u002fjarod${BACKSLASH}u002fx.md`; // -> /Users/jarod/x.md
    writeRawManifest(`{"schemaVersion":1,"roles":[{"name":"X","harness":"cursor","model":"${escapedPath}","files":[]}]}`);

    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("absolute-path");
    expect(result.file).toBe(MANIFEST_FILENAME);
  });

  test("a source referenced by two file entries is read once (seen dedup)", () => {
    // The `seen` set scans a shared source once — prove it via an injected io that counts non-manifest reads.
    let sourceReads = 0;
    const io: BlueprintIo = {
      readFileBounded(path: string): ReadOutcome {
        if (path.endsWith(MANIFEST_FILENAME)) {
          return {
            ok: true,
            content: JSON.stringify({
              schemaVersion: 1,
              roles: [
                { name: "A", harness: "codex", files: [{ transform: "copy", source: "shared.md", destination: "AGENTS.md" }] },
                { name: "B", harness: "cursor", files: [{ transform: "copy", source: "shared.md", destination: "x.md" }] },
              ],
            }),
          };
        }
        sourceReads++;
        return { ok: true, content: "# shared\nclean portable content\n" };
      },
    };
    const result = loadBlueprint("", io);
    assertKind(result, "loaded");
    expect(sourceReads).toBe(1); // shared.md read once despite two references
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("loadBlueprint — absence & unreadable files", () => {
  test("a missing manifest → absent (not a throw)", () => {
    const result = loadBlueprint(root); // nothing written
    assertKind(result, "absent");
    expect(result.manifestPath).toContain(MANIFEST_FILENAME);
  });

  test("a directory where the manifest must be → invalid(unreadable-manifest), never hangs", () => {
    mkdirSync(join(root, MANIFEST_FILENAME), { recursive: true }); // manifest.json is a DIRECTORY
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("unreadable-manifest");
  });

  test("an absent SOURCE is skipped (still loadable) — render raises missing-source, not the gate", () => {
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "codex", files: [{ transform: "copy", source: "missing.md", destination: "AGENTS.md" }] }] });
    // missing.md is never written.
    const result = loadBlueprint(root);
    assertKind(result, "loaded"); // U1 does not raise missing-source; U3 does.
  });

  test("a PRESENT-but-unreadable source fails CLOSED → invalid(unreadable-source) — bytes we can't gate", () => {
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "codex", files: [{ transform: "copy", source: "role.md", destination: "AGENTS.md" }] }] });
    mkdirSync(join(root, "role.md"), { recursive: true }); // role.md is a DIRECTORY → present but unreadable
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("unreadable-source");
    expect(result.file).toBe("role.md");
  });

  test("an oversized source (>16 MiB) is refused by the size cap → invalid(unreadable-source)", () => {
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "codex", files: [{ transform: "copy", source: "big.md", destination: "AGENTS.md" }] }] });
    writeFile("big.md", "x".repeat(16 * 1024 * 1024 + 1)); // one byte over the ceiling
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("unreadable-source"); // stat guard fires WITHOUT reading the file
  });

  test("a non-ENOENT source read failure (ENOTDIR through a regular file) fails CLOSED → unreadable-source", () => {
    // Every other 'blocked' case reaches it via a SUCCESSFUL stat (directory / oversize). This drives the
    // catch block's NON-ENOENT arm: statting a path THROUGH a regular-file segment throws ENOTDIR, proving
    // isNotFound's false arm yields 'blocked' (fail-closed), not 'absent' (skip) — the fail-open regression guard.
    writeFile("afile", "a regular file, not a directory\n");
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "codex", files: [{ transform: "copy", source: "afile/nested.md", destination: "AGENTS.md" }] }] });
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("unreadable-source");
    expect(result.file).toBe("afile/nested.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("loadBlueprint — totality (never throws; always a discriminated variant)", () => {
  test("truncated JSON → invalid(malformed-json), no throw", () => {
    writeRawManifest('{"schemaVersion":1,"roles":[');
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("malformed-json");
  });

  test("non-object JSON roots ([], scalar, null) → a discriminated variant, no throw", () => {
    for (const raw of ["[]", '"hello"', "42", "null", "true"]) {
      const result = loadBlueprint("", fakeIo({ [MANIFEST_FILENAME]: raw }));
      expect(VALID_KINDS).toContain(result.kind);
      expect(result.kind).toBe("invalid");
    }
  });

  test("wrong-typed fields → invalid, no throw", () => {
    writeManifest({ schemaVersion: 1, roles: "not-an-array" });
    assertKind(loadBlueprint(root), "invalid");
  });

  test("pathologically deep JSON does not throw", () => {
    const deep = "[".repeat(100_000) + "1" + "]".repeat(100_000);
    let result!: BlueprintLoad;
    expect(() => {
      result = loadBlueprint("", fakeIo({ [MANIFEST_FILENAME]: deep }));
    }).not.toThrow();
    expect(VALID_KINDS).toContain(result.kind);
  });

  test("a fixed battery of malformed manifests each returns a discriminated variant, never throws", () => {
    const battery = [
      "",
      "{",
      "}",
      "[]",
      "null",
      "true",
      "42",
      '"str"',
      "not json at all",
      '{"schemaVersion":',
      '{"schemaVersion":1}',
      '{"schemaVersion":1,"roles":{}}',
      '{"roles":[]}',
      '{"schemaVersion":1.5,"roles":[]}',
      '{"schemaVersion":-3,"roles":[]}',
      '{"schemaVersion":1,"roles":[{"name":"","harness":"codex","files":[]}]}',
      '{"schemaVersion":1,"roles":[{"harness":"nope"}]}',
      '{"schemaVersion":1,"roles":[]}', // the one VALID member → loaded
    ];
    for (const raw of battery) {
      let result!: BlueprintLoad;
      expect(() => {
        result = loadBlueprint("", fakeIo({ [MANIFEST_FILENAME]: raw }));
      }).not.toThrow();
      expect(VALID_KINDS).toContain(result.kind);
    }
  });

  test("random-bytes fuzz: 200 random manifest bodies, never a throw, always a variant", () => {
    const chars = '{}[]":,\\ \n\t01abZ-_/.skiveu"';
    const rand = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    for (let i = 0; i < 200; i++) {
      const raw = rand(Math.floor(Math.random() * 120));
      let result!: BlueprintLoad;
      expect(() => {
        result = loadBlueprint("", fakeIo({ [MANIFEST_FILENAME]: raw }));
      }).not.toThrow();
      expect(VALID_KINDS).toContain(result.kind);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("loadBlueprint — cardinality budget (no-hang guard; decision #45 own-file pathological case)", () => {
  test("pathologically many roles → invalid(too-large), rejected BEFORE a giant safeParse", () => {
    // 50k null roles: the preflight rejects on roles.length before safeParse would materialize 50k issues.
    writeManifest({ schemaVersion: 1, roles: new Array(50_000).fill(null) });
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("too-large");
  });

  test("pathologically many file entries in one role → invalid(too-large)", () => {
    const files = new Array(20_000).fill({ transform: "copy", source: "x.md", destination: "y.md" });
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "codex", files }] });
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("too-large");
  });

  test("pathologically many compose sources in one entry → invalid(too-large) (bounds the read loop too)", () => {
    const sources = new Array(20_000).fill("s.md");
    writeManifest({ schemaVersion: 1, roles: [{ name: "X", harness: "claude-code", files: [{ transform: "compose", sources, destination: "CLAUDE.md" }] }] });
    const result = loadBlueprint(root);
    assertKind(result, "invalid");
    expect(result.problem).toBe("too-large");
  });

  test("a normal-sized blueprint is well within budget — the guard rejects only the pathological", () => {
    const m = run1Manifest();
    writeManifest(m);
    writeAllSources(m);
    assertKind(loadBlueprint(root), "loaded"); // run-1: 3 roles, ~12 entries — nowhere near the caps
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("contract — Manifest JSON schema export (KTD10; verify toJSONSchema didn't silently surprise)", () => {
  test("jsonSchemas.Manifest emits and serializes the discriminated union", () => {
    expect(jsonSchemas.Manifest).toBeDefined();
    const serialized = JSON.stringify(jsonSchemas.Manifest);
    expect(serialized).toContain("schemaVersion");
    // the transform discriminant literals survived the nested discriminatedUnion → array → strictObject.
    expect(serialized).toContain("copy");
    expect(serialized).toContain("compose");
    expect(serialized).toContain("config-merge");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("content heuristics (unit)", () => {
  test("hasMachineAbsolutePath: flags user-home roots, not relative segments or portable system paths", () => {
    expect(hasMachineAbsolutePath("read /Users/jarod/x.md")).toBe(true);
    expect(hasMachineAbsolutePath("cd /home/deploy/app")).toBe(true);
    expect(hasMachineAbsolutePath('"/root/secrets/key"')).toBe(true);
    expect(hasMachineAbsolutePath("/Users/jarod/x")).toBe(true); // at start of string

    expect(hasMachineAbsolutePath("roles/Users/x")).toBe(false); // relative segment, not an absolute path
    expect(hasMachineAbsolutePath("/usr/bin/node")).toBe(false); // portable system path
    expect(hasMachineAbsolutePath("/etc/hosts")).toBe(false);
    expect(hasMachineAbsolutePath("go to the /home page")).toBe(false); // no path segment after
    expect(hasMachineAbsolutePath("http://Users/thing")).toBe(false); // URL host, not an abs path
  });

  test("containsSecret: reuses the capture classifier (sk- tokens, key=value), passes clean prose", () => {
    expect(containsSecret(`token: ${SECRET}`)).toBe(true);
    expect(containsSecret("API_KEY=abcdef")).toBe(true);
    expect(containsSecret('model = "gpt-5-codex"')).toBe(false);
    expect(containsSecret("# just some portable role prose\n")).toBe(false);
  });

  test("containsSecret runs in linear time on keyword-dense input (ReDoS guard — the gate runs it over whole files)", () => {
    // The keyword-assignment pattern was O(n^2) on keyword-dense input via unbounded greedy identifier runs;
    // bounded to {0,64}. A ~1 MB file of the repeated keyword must classify far under budget — the front-gate
    // runs this over every blueprint source up to the 16 MiB read cap. Unbounded, 500 KB did not finish in 30s.
    const keywordDense = "token ".repeat(180_000); // ~1.1 MB, no [:=] → not a secret assignment
    const start = performance.now();
    const hit = containsSecret(keywordDense);
    const elapsedMs = performance.now() - start;
    expect(hit).toBe(false);
    expect(elapsedMs).toBeLessThan(2000); // ~7ms in practice; 2s cleanly separates linear from the >30s quadratic
  });
});
