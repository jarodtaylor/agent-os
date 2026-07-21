import { describe, expect, test } from "bun:test";
import {
  TARGETS,
  checkTargetCompatibility,
  resolveTarget,
  type TargetInspection,
  type TargetPathState,
} from "../src/provision/targets";

const PROJECT = "/work/project";

function inspection(states: Record<string, TargetPathState>, contents: Record<string, string> = {}): TargetInspection {
  return {
    stat: (path) => states[path] ?? "absent",
    read: (path) => contents[path] ?? null,
  };
}

describe("provision target registry", () => {
  test("carries the verified project-scoped surfaces, formats, and write shapes for all three harnesses", () => {
    expect(TARGETS["claude-code"].surfaces).toEqual([
      expect.objectContaining({ location: "CLAUDE.md", format: "text", shape: "create" }),
      expect.objectContaining({ location: ".claude/agents", format: "text", shape: "create", extension: ".md" }),
      expect.objectContaining({ location: ".mcp.json", format: "json", shape: "merge" }),
    ]);
    expect(TARGETS.codex.surfaces).toEqual([
      expect.objectContaining({ location: "AGENTS.md", format: "text", shape: "create" }),
      expect.objectContaining({ location: ".codex/agents", format: "toml", shape: "create", extension: ".toml" }),
      expect.objectContaining({ location: ".codex/config.toml", format: "toml", shape: "merge" }),
    ]);
    expect(TARGETS.cursor.surfaces).toEqual([
      expect.objectContaining({ location: ".cursor/agents", format: "text", shape: "create", extension: ".md" }),
      expect.objectContaining({ location: ".cursor/skills", format: "text", shape: "create", entrypoint: "SKILL.md" }),
      expect.objectContaining({ location: ".cursor/mcp.json", format: "json", shape: "merge" }),
    ]);
    expect(TARGETS.codex.surfaces.some((surface) => surface.id === "skills")).toBe(false); // issue #36
  });

  test("resolves only known project-relative destinations for each harness", () => {
    expect(resolveTarget(PROJECT, "claude-code", ".claude/agents/reviewer.md")?.destination).toBe(
      "/work/project/.claude/agents/reviewer.md",
    );
    expect(resolveTarget(PROJECT, "codex", ".codex/agents/executor.toml")?.destination).toBe(
      "/work/project/.codex/agents/executor.toml",
    );
    expect(resolveTarget(PROJECT, "cursor", ".cursor/skills/qa-gate/SKILL.md")?.destination).toBe(
      "/work/project/.cursor/skills/qa-gate/SKILL.md",
    );
    expect(resolveTarget(PROJECT, "cursor", ".cursor/mcp.json")?.destination).toBe(
      "/work/project/.cursor/mcp.json",
    );

    expect(resolveTarget(PROJECT, "cursor", "/Users/me/.cursor/mcp.json")).toBeNull();
    expect(resolveTarget(PROJECT, "cursor", "../.cursor/mcp.json")).toBeNull();
    expect(resolveTarget(PROJECT, "cursor", ".cursor/agents/not-markdown.txt")).toBeNull();
    expect(resolveTarget(PROJECT, "codex", ".codex/skills/guessed/SKILL.md")).toBeNull(); // issue #36
  });

  test("AE4: a regular file where the Cursor agents directory must be fails loudly with the surface named", () => {
    const target = resolveTarget(PROJECT, "cursor", ".cursor/agents/qa.md")!;
    const result = checkTargetCompatibility(
      target,
      inspection({
        "/work/project/.cursor/agents": "file",
      }),
    );

    expect(result.compatible).toBe(false);
    if (!result.compatible) {
      expect(result.surface).toBe(".cursor/agents/*.md");
      expect(result.message).toContain(".cursor/agents/*.md");
      expect(result.message).toContain("directory");
    }
  });

  test("AE4: an unparseable Cursor mcp.json merge parent fails loudly with the surface named", () => {
    const target = resolveTarget(PROJECT, "cursor", ".cursor/mcp.json")!;
    const result = checkTargetCompatibility(
      target,
      inspection(
        { "/work/project/.cursor/mcp.json": "file" },
        { "/work/project/.cursor/mcp.json": "{ not valid json" },
      ),
    );

    expect(result.compatible).toBe(false);
    if (!result.compatible) {
      expect(result.surface).toBe(".cursor/mcp.json");
      expect(result.message).toContain(".cursor/mcp.json");
      expect(result.message).toContain("valid json");
    }
  });

  test("AE4: an absent create-shaped destination is compatible", () => {
    const target = resolveTarget(PROJECT, "cursor", ".cursor/agents/qa.md")!;
    expect(checkTargetCompatibility(target, inspection({}))).toEqual({ compatible: true });
  });

  test("a symlinked target is incompatible, while a valid existing merge config is compatible", () => {
    const agent = resolveTarget(PROJECT, "cursor", ".cursor/agents/qa.md")!;
    const symlink = checkTargetCompatibility(
      agent,
      inspection({
        "/work/project/.cursor/agents": "directory",
        "/work/project/.cursor/agents/qa.md": "symlink",
      }),
    );
    expect(symlink.compatible).toBe(false);
    if (!symlink.compatible) expect(symlink.message).toContain("symlink");

    const mcp = resolveTarget(PROJECT, "cursor", ".cursor/mcp.json")!;
    expect(
      checkTargetCompatibility(
        mcp,
        inspection(
          { "/work/project/.cursor/mcp.json": "file" },
          { "/work/project/.cursor/mcp.json": '{"mcpServers":{"playwright":{"command":"npx"}}}' },
        ),
      ),
    ).toEqual({ compatible: true });
  });

  test("inspection exceptions fail closed for both stat and read operations", () => {
    const agent = resolveTarget(PROJECT, "cursor", ".cursor/agents/qa.md")!;
    const statFailure = checkTargetCompatibility(agent, {
      stat: () => {
        throw new Error("permission denied");
      },
      read: () => null,
    });
    expect(statFailure).toEqual(
      expect.objectContaining({
        compatible: false,
        surface: ".cursor/agents/*.md",
        reason: "inspection-failed",
      }),
    );

    const mcp = resolveTarget(PROJECT, "cursor", ".cursor/mcp.json")!;
    const readFailure = checkTargetCompatibility(mcp, {
      stat: (path) => (path === "/work/project/.cursor/mcp.json" ? "file" : "directory"),
      read: () => {
        throw new Error("read failed");
      },
    });
    expect(readFailure).toEqual(
      expect.objectContaining({
        compatible: false,
        surface: ".cursor/mcp.json",
        reason: "inspection-failed",
      }),
    );
  });

  test("symlinked ancestors and intermediate skill directories fail closed", () => {
    const target = resolveTarget(PROJECT, "cursor", ".cursor/skills/qa-gate/SKILL.md")!;

    for (const path of ["/work/project/.cursor", "/work/project/.cursor/skills/qa-gate"]) {
      const result = checkTargetCompatibility(target, inspection({ [path]: "symlink" }));
      expect(result).toEqual(
        expect.objectContaining({
          compatible: false,
          path,
          reason: "symlink",
          surface: ".cursor/skills/**/SKILL.md",
        }),
      );
    }
  });

  test("a create-shaped target that is already a directory is incompatible", () => {
    const target = resolveTarget(PROJECT, "cursor", ".cursor/agents/qa.md")!;
    const result = checkTargetCompatibility(
      target,
      inspection({
        "/work/project/.cursor": "directory",
        "/work/project/.cursor/agents": "directory",
        "/work/project/.cursor/agents/qa.md": "directory",
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        compatible: false,
        reason: "non-file",
        surface: ".cursor/agents/*.md",
      }),
    );
  });
});
