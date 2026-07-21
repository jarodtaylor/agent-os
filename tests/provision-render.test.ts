import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { Manifest } from "../src/contract/index";
import { diffRendered, type DestinationRead } from "../src/provision/diff";
import {
  type ProvisionRead,
  type RenderIo,
  renderBlueprint,
} from "../src/provision/render";

function readMap(files: Record<string, string>, blocked: Set<string> = new Set()): (path: string) => ProvisionRead {
  return (path) => {
    if (blocked.has(path)) return { ok: false, reason: "blocked" };
    if (Object.hasOwn(files, path)) return { ok: true, content: files[path]! };
    return { ok: false, reason: "absent" };
  };
}

function destinationReadMap(
  files: Record<string, string>,
  blocked: Set<string> = new Set(),
): (path: string) => DestinationRead {
  return (path) => {
    if (blocked.has(path)) return { ok: false, reason: "blocked" };
    if (Object.hasOwn(files, path)) {
      const content = files[path]!;
      return { ok: true, content, bytes: Buffer.from(content, "utf8") };
    }
    return { ok: false, reason: "absent" };
  };
}

function io(sources: Record<string, string>, destinations: Record<string, string> = {}): RenderIo {
  return { readSource: readMap(sources), readDestination: readMap(destinations) };
}

function expectOk<T extends { ok: boolean }>(result: T): asserts result is Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
}

function manifest(files: Manifest["roles"][number]["files"]): Manifest {
  return {
    schemaVersion: 1,
    roles: [{ name: "Executor", harness: "codex", files }],
  };
}

function run1Manifest(): Manifest {
  return {
    schemaVersion: 1,
    roles: [
      {
        name: "QA",
        harness: "cursor",
        files: [
          { transform: "copy", source: "cursor/qa-smoke.md", destination: ".cursor/agents/qa-smoke.md" },
          { transform: "copy", source: "cursor/qa-regression.md", destination: ".cursor/agents/qa-regression.md" },
          { transform: "copy", source: "cursor/qa-browser-e2e.md", destination: ".cursor/agents/qa-browser-e2e.md" },
          { transform: "copy", source: "cursor/qa-skeptic-verifier.md", destination: ".cursor/agents/qa-skeptic-verifier.md" },
          { transform: "copy", source: "cursor/qa-gate/SKILL.md", destination: ".cursor/skills/qa-gate/SKILL.md" },
          { transform: "copy", source: "cursor/qa-gate/claude-invocation.md", destination: ".cursor/skills/qa-gate/claude-invocation.md" },
          { transform: "config-merge", source: "cursor/playwright.json", destination: ".cursor/mcp.json" },
        ],
      },
      {
        name: "Executor",
        harness: "codex",
        files: [
          { transform: "copy", source: "codex/AGENTS.md", destination: "AGENTS.md" },
          { transform: "copy", source: "codex/executor.toml", destination: ".codex/agents/executor.toml" },
          { transform: "scaffold", source: "codex/README.md", destination: ".codex/README.md" },
        ],
      },
      {
        name: "Orchestrator",
        harness: "claude-code",
        files: [
          {
            transform: "compose",
            sources: ["claude/orchestrator.md", "claude/architect.md", "claude/reviewer.md"],
            destination: "CLAUDE.md",
          },
          { transform: "scaffold", destination: ".claude/agents/README.md" },
        ],
      },
    ],
  };
}

describe("renderBlueprint — transform vocabulary (R5/R6, KTD3/KTD6)", () => {
  test("run-1-shaped fixture reproduces all eight copy rows and the composed native bytes", () => {
    const input = run1Manifest();
    const sources: Record<string, string> = {
      "cursor/qa-smoke.md": "smoke\n",
      "cursor/qa-regression.md": "regression",
      "cursor/qa-browser-e2e.md": "browser\n\n",
      "cursor/qa-skeptic-verifier.md": "skeptic\n",
      "cursor/qa-gate/SKILL.md": "gate\n",
      "cursor/qa-gate/claude-invocation.md": "invoke\n",
      "cursor/playwright.json": '{"mcpServers":{"playwright":{"command":"npx"}}}',
      "codex/AGENTS.md": "executor\n",
      "codex/executor.toml": 'model = "gpt-5-codex"\n',
      "codex/README.md": "two role surfaces\n",
      "claude/orchestrator.md": "ORCHESTRATE\n",
      "claude/architect.md": "ARCHITECT\n",
      "claude/reviewer.md": "REVIEW\n",
    };

    const result = renderBlueprint(input, io(sources));

    expectOk(result);
    expect(result.files).toHaveLength(12);
    const copies = result.files.filter((file) => file.transform === "copy");
    expect(copies).toHaveLength(8);
    for (const copy of copies) {
      const entry = input.roles.flatMap((role) => role.files).find((file) => file.destination === copy.destination);
      expect(entry?.transform).toBe("copy");
      if (entry?.transform === "copy") expect(copy.content).toBe(sources[entry.source]);
    }
    expect(result.files.find((file) => file.transform === "compose")?.content).toBe(
      "<!-- agent-os compose; manifest schemaVersion=1 -->\n" +
        "<!-- source: claude/orchestrator.md -->\nORCHESTRATE\n\n" +
        "<!-- source: claude/architect.md -->\nARCHITECT\n\n" +
        "<!-- source: claude/reviewer.md -->\nREVIEW\n",
    );
  });

  test("copy preserves source bytes exactly, including trailing-newline shape", () => {
    const input = manifest([
      { transform: "copy", source: "none.md", destination: "AGENTS.md" },
      { transform: "copy", source: "many.md", destination: ".codex/agents/many.md" },
    ]);

    const result = renderBlueprint(input, io({ "none.md": "no newline", "many.md": "many\n\n" }));

    expectOk(result);
    expect(result.files.map((file) => file.content)).toEqual(["no newline", "many\n\n"]);
    expect(result.files.map((file) => file.format)).toEqual(["text", "text"]);
  });

  test("a source reused by multiple destinations is read once per deterministic render", () => {
    const input = manifest([
      { transform: "copy", source: "shared.md", destination: "AGENTS.md" },
      { transform: "copy", source: "shared.md", destination: ".codex/agents/shared.md" },
    ]);
    let sourceReads = 0;
    const renderIo: RenderIo = {
      readSource() {
        sourceReads++;
        return { ok: true, content: `snapshot ${sourceReads}\n` };
      },
      readDestination: readMap({}),
    };

    const result = renderBlueprint(input, renderIo);

    expectOk(result);
    expect(sourceReads).toBe(1);
    expect(result.files.map((file) => file.content)).toEqual(["snapshot 1\n", "snapshot 1\n"]);
  });

  test("compose assembles ordered sources with schema-versioned boilerplate", () => {
    const input = manifest([
      { transform: "compose", sources: ["identity.md", "reviewer.md"], destination: "CLAUDE.md" },
    ]);

    const result = renderBlueprint(input, io({ "identity.md": "IDENTITY\n", "reviewer.md": "REVIEW\n" }));

    expectOk(result);
    expect(result.files[0]!.content).toBe(
      "<!-- agent-os compose; manifest schemaVersion=1 -->\n" +
        "<!-- source: identity.md -->\n" +
        "IDENTITY\n\n" +
        "<!-- source: reviewer.md -->\n" +
        "REVIEW\n",
    );
  });

  test("scaffold renders content only while the destination is absent", () => {
    const input = manifest([
      { transform: "scaffold", source: "README.md", destination: ".codex/README.md" },
      { transform: "scaffold", source: "missing.md", destination: ".claude/agents/README.md" },
      { transform: "scaffold", destination: ".cursor/README.md" },
    ]);

    const result = renderBlueprint(
      input,
      io(
        { "README.md": "Codex surfaces\n" },
        { ".claude/agents/README.md": "hand-authored\n" },
      ),
    );

    expectOk(result);
    expect(result.files.map((file) => file.content)).toEqual(["Codex surfaces\n", null, ""]);
  });

  test("config-merge parses a structured patch for the U14 merge path", () => {
    const input = manifest([
      { transform: "config-merge", source: "playwright.json", destination: ".cursor/mcp.json" },
    ]);
    const patch = { mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } };

    const result = renderBlueprint(input, io({ "playwright.json": JSON.stringify(patch) }));

    expectOk(result);
    expect(result.files[0]).toMatchObject({ transform: "config-merge", format: "json", patch });
  });

  test("config-merge rejects malformed and non-object patches without exposing source content", () => {
    const cases = [
      { source: "malformed.json", content: '{"secret":"unterminated', problem: "malformed-source" },
      { source: "scalar.json", content: '"secret-value"', problem: "invalid-config-patch" },
      { source: "array.json", content: '["secret-value"]', problem: "invalid-config-patch" },
    ] as const;

    for (const { source, content, problem } of cases) {
      const input = manifest([{ transform: "config-merge", source, destination: ".cursor/mcp.json" }]);
      const result = renderBlueprint(input, io({ [source]: content }));

      expect(result).toEqual({
        ok: false,
        error: {
          problem,
          role: "Executor",
          harness: "codex",
          source,
          destination: ".cursor/mcp.json",
        },
      });
      expect(JSON.stringify(result)).not.toContain("secret-value");
      expect(JSON.stringify(result)).not.toContain("unterminated");
    }
  });

  test("blocked source and scaffold destination reads return exact content-free errors", () => {
    const blockedSource = renderBlueprint(
      manifest([{ transform: "copy", source: "role.md", destination: "AGENTS.md" }]),
      {
        readSource: readMap({}, new Set(["role.md"])),
        readDestination: readMap({}),
      },
    );
    expect(blockedSource).toEqual({
      ok: false,
      error: {
        problem: "unreadable-source",
        role: "Executor",
        harness: "codex",
        source: "role.md",
        destination: "AGENTS.md",
      },
    });

    const blockedDestination = renderBlueprint(
      manifest([{ transform: "scaffold", source: "README.md", destination: ".codex/README.md" }]),
      {
        readSource: readMap({ "README.md": "must not leak" }),
        readDestination: readMap({}, new Set([".codex/README.md"])),
      },
    );
    expect(blockedDestination).toEqual({
      ok: false,
      error: {
        problem: "unreadable-destination",
        role: "Executor",
        harness: "codex",
        destination: ".codex/README.md",
      },
    });
    expect(JSON.stringify(blockedDestination)).not.toContain("must not leak");
  });

  test("missing compose source fails loudly with role, source, and destination", () => {
    const input: Manifest = {
      schemaVersion: 1,
      roles: [
        {
          name: "Orchestrator",
          harness: "claude-code",
          files: [{ transform: "compose", sources: ["identity.md", "missing.md"], destination: "CLAUDE.md" }],
        },
      ],
    };

    const result = renderBlueprint(input, io({ "identity.md": "identity\n" }));

    expect(result).toEqual({
      ok: false,
      error: {
        problem: "missing-source",
        role: "Orchestrator",
        harness: "claude-code",
        source: "missing.md",
        destination: "CLAUDE.md",
      },
    });
  });

  test("empty-but-present compose source renders with an attached warning and stays byte-stable", () => {
    const input = manifest([
      { transform: "compose", sources: ["empty.md", "body.md"], destination: "CLAUDE.md" },
    ]);
    const render = () => renderBlueprint(input, io({ "empty.md": "", "body.md": "body\n" }));

    const first = render();
    expectOk(first);
    expect(first.files[0]!.warnings).toEqual([
      {
        code: "empty-source",
        role: "Executor",
        source: "empty.md",
        destination: "CLAUDE.md",
      },
    ]);

    const expected = first.files[0]!.content;
    for (let attempt = 0; attempt < 100; attempt++) {
      const repeated = render();
      expect(repeated.ok).toBe(true);
      if (repeated.ok) expect(repeated.files[0]!.content).toBe(expected);
    }
  });
});

describe("diffRendered — presence semantics (R8 read side, KTD8)", () => {
  test("classifies create, noop, overwrite, merge, and scaffold-skip in manifest order", () => {
    const input = manifest([
      { transform: "copy", source: "create.md", destination: "create.md" },
      { transform: "copy", source: "same.md", destination: "same.md" },
      { transform: "copy", source: "changed.md", destination: "changed.md" },
      { transform: "config-merge", source: "patch.json", destination: "merge.json" },
      { transform: "config-merge", source: "create-patch.json", destination: "create-config.json" },
      { transform: "scaffold", source: "scaffold.md", destination: "existing.md" },
      { transform: "scaffold", source: "new-scaffold.md", destination: "new-scaffold.md" },
    ]);
    const live = {
      "same.md": "same\n",
      "changed.md": "old\n",
      "merge.json": '{"foreign":true}',
      "existing.md": "keep me\n",
    };
    const rendered = renderBlueprint(
      input,
      io(
        {
          "create.md": "new\n",
          "same.md": "same\n",
          "changed.md": "new\n",
          "patch.json": '{"owned":{"enabled":true}}',
          "create-patch.json": '{"owned":{"enabled":true}}',
          "scaffold.md": "starter\n",
          "new-scaffold.md": "starter\n",
        },
        live,
      ),
    );
    expectOk(rendered);

    const result = diffRendered(rendered.files, destinationReadMap(live));

    expectOk(result);
    expect(result.rows.map(({ destination, action, drift }) => ({ destination, action, drift }))).toEqual([
      { destination: "create.md", action: "create", drift: true },
      { destination: "same.md", action: "noop", drift: false },
      { destination: "changed.md", action: "overwrite", drift: true },
      { destination: "merge.json", action: "merge", drift: true },
      { destination: "create-config.json", action: "create", drift: true },
      { destination: "existing.md", action: "scaffold-skip", drift: false },
      { destination: "new-scaffold.md", action: "create", drift: false },
    ]);
    expect(result.rows[5]).toEqual({
      role: "Executor",
      harness: "codex",
      destination: "existing.md",
      action: "scaffold-skip",
      drift: false,
    });
    expect(result.rows[6]).toEqual({
      role: "Executor",
      harness: "codex",
      destination: "new-scaffold.md",
      action: "create",
      drift: false,
    });
  });

  test("unchanged re-render is all-noop; foreign-formatted JSON is compared semantically", () => {
    const input = manifest([
      { transform: "copy", source: "role.md", destination: "AGENTS.md" },
      { transform: "copy", source: "settings.json", destination: ".cursor/settings.json" },
      { transform: "config-merge", source: "patch.json", destination: ".cursor/mcp.json" },
    ]);
    const sources = {
      "role.md": "role\n",
      "settings.json": '{"alpha":1,"nested":{"enabled":true}}\n',
      "patch.json": '{"mcpServers":{"playwright":{"command":"npx"}}}',
    };
    const live = {
      "AGENTS.md": "role\n",
      ".cursor/settings.json": '{\n    "nested": { "enabled": true },\n    "alpha": 1\n}\n',
      ".cursor/mcp.json": '{\n  "foreign": true,\n  "mcpServers": { "playwright": { "command": "npx" } }\n}\n',
    };
    const rendered = renderBlueprint(input, io(sources, live));
    expectOk(rendered);

    const result = diffRendered(rendered.files, destinationReadMap(live));

    expectOk(result);
    expect(result.rows.map((row) => row.action)).toEqual(["noop", "noop", "noop"]);
    expect(result.rows.every((row) => row.drift === false)).toBe(true);
  });

  test("idempotency is proven independently for json, toml, yaml, and text", () => {
    const input = manifest([
      { transform: "copy", source: "config.json", destination: "config.json" },
      { transform: "copy", source: "config.toml", destination: "config.toml" },
      { transform: "copy", source: "config.yaml", destination: "config.yaml" },
      { transform: "copy", source: "role.md", destination: "role.md" },
    ]);
    const rendered = renderBlueprint(
      input,
      io({
        "config.json": '{"alpha":1,"nested":{"enabled":true}}',
        "config.toml": 'alpha = 1\n\n[nested]\nenabled = true\n',
        "config.yaml": "alpha: 1\nnested:\n  enabled: true\n",
        "role.md": "opaque text\n",
      }),
    );
    expectOk(rendered);

    const result = diffRendered(
      rendered.files,
      destinationReadMap({
        "config.json": '{\n  "nested": { "enabled": true },\n  "alpha": 1\n}',
        "config.toml": '# foreign formatting/comment\nalpha = 1\n[nested]\nenabled = true\n',
        "config.yaml": "nested: { enabled: true }\nalpha: 1\n",
        "role.md": "opaque text\n",
      }),
    );

    expectOk(result);
    expect(result.rows.map((row) => row.action)).toEqual(["noop", "noop", "noop", "noop"]);
  });

  test("driftTracked=false suppresses drift without changing the required overwrite verdict", () => {
    const input = manifest([
      { transform: "copy", source: "role.md", destination: "AGENTS.md", driftTracked: false },
    ]);
    const rendered = renderBlueprint(input, io({ "role.md": "wanted\n" }, { "AGENTS.md": "edited\n" }));
    expectOk(rendered);

    const result = diffRendered(rendered.files, destinationReadMap({ "AGENTS.md": "edited\n" }));

    expectOk(result);
    expect(result.rows[0]).toMatchObject({ action: "overwrite", drift: false });
  });

  test("structured copy overwrites a malformed live target when the rendered value is valid", () => {
    const input = manifest([
      { transform: "copy", source: "settings.json", destination: ".cursor/settings.json" },
    ]);
    const rendered = renderBlueprint(input, io({ "settings.json": '{"valid":true}' }));
    expectOk(rendered);

    const result = diffRendered(
      rendered.files,
      destinationReadMap({ ".cursor/settings.json": '{"secret":"unterminated' }),
    );

    expectOk(result);
    expect(result.rows[0]).toEqual({
      role: "Executor",
      harness: "codex",
      destination: ".cursor/settings.json",
      action: "overwrite",
      drift: true,
    });
  });

  test("structured copy validates rendered content before deciding a malformed live target can be replaced", () => {
    const input = manifest([
      { transform: "copy", source: "settings.json", destination: ".cursor/settings.json" },
    ]);
    const rendered = renderBlueprint(input, io({ "settings.json": '{"invalid":"render"' }));
    expectOk(rendered);

    const result = diffRendered(
      rendered.files,
      destinationReadMap({ ".cursor/settings.json": '{"invalid":"live"' }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        problem: "malformed-rendered",
        role: "Executor",
        harness: "codex",
        destination: ".cursor/settings.json",
        format: "json",
      },
    });
    expect(JSON.stringify(result)).not.toContain("invalid");
  });

  test("config-merge keeps malformed live config fatal and content-free", () => {
    const input = manifest([
      { transform: "config-merge", source: "patch.json", destination: ".cursor/settings.json" },
    ]);
    const rendered = renderBlueprint(input, io({ "patch.json": '{"owned":true}' }));
    expectOk(rendered);

    const result = diffRendered(
      rendered.files,
      destinationReadMap({ ".cursor/settings.json": '{"secret":"unterminated' }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        problem: "malformed-destination",
        role: "Executor",
        harness: "codex",
        destination: ".cursor/settings.json",
        format: "json",
      },
    });
    expect(JSON.stringify(result)).not.toContain("unterminated");
  });

  test("opaque text compares rendered UTF-8 bytes with the raw destination bytes", () => {
    const rendered = renderBlueprint(
      manifest([{ transform: "copy", source: "role.md", destination: "AGENTS.md" }]),
      io({ "role.md": "\uFFFD" }),
    );
    expectOk(rendered);

    const result = diffRendered(rendered.files, () => ({
      ok: true,
      content: "\uFFFD",
      bytes: Uint8Array.of(0x80),
    }));

    expectOk(result);
    expect(result.rows[0]).toMatchObject({ action: "overwrite", drift: true });
  });

  test("blocked destination reads fail softly with an exact content-free error", () => {
    const rendered = renderBlueprint(
      manifest([{ transform: "copy", source: "role.md", destination: "AGENTS.md" }]),
      io({ "role.md": "wanted\n" }),
    );
    expectOk(rendered);

    const result = diffRendered(rendered.files, destinationReadMap({}, new Set(["AGENTS.md"])));

    expect(result).toEqual({
      ok: false,
      error: {
        problem: "unreadable-destination",
        role: "Executor",
        harness: "codex",
        destination: "AGENTS.md",
      },
    });
    expect(JSON.stringify(result)).not.toContain("wanted");
  });

  test("a scaffold that disappears after render fails as a stale snapshot", () => {
    const rendered = renderBlueprint(
      manifest([{ transform: "scaffold", source: "README.md", destination: ".codex/README.md" }]),
      io({}, { ".codex/README.md": "hand-authored secret\n" }),
    );
    expectOk(rendered);
    expect(rendered.files[0]).toMatchObject({ transform: "scaffold", content: null });

    const result = diffRendered(rendered.files, destinationReadMap({}));

    expect(result).toEqual({
      ok: false,
      error: {
        problem: "stale-scaffold",
        role: "Executor",
        harness: "codex",
        destination: ".codex/README.md",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
