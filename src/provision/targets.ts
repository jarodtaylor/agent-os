/**
 * Provisioning target registry (U10/U4): build-time knowledge of the three writable harnesses' project
 * surfaces. A caller supplies a manifest destination; this module proves that it belongs to the selected
 * harness, resolves it under the project root, and checks the live path shape before any write begins.
 *
 * The registry is deliberately data, not live discovery (R10/KTD4). Surface locations and formats were
 * verified against current harness documentation and live installations; runtime inspection only answers
 * whether the known destination is safe to create/overwrite/merge. Every path is project-relative (R9).
 */
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { Runtime } from "../contract/index";
import type { ConfigFormat } from "../configwrite/index";

export type ProvisionHarness = Extract<Runtime, "claude-code" | "codex" | "cursor">;
export type TargetSurfaceId = "instructions" | "agents" | "skills" | "mcp";
export type TargetShape = "create" | "merge";

export interface TargetSurface {
  id: TargetSurfaceId;
  /** Project-relative exact file or directory root. */
  location: string;
  /** Human-facing surface name used in loud compatibility failures. */
  label: string;
  layout: "file" | "directory";
  format: ConfigFormat;
  shape: TargetShape;
  /** For a directory surface whose immediate children are target files (`*.md`, `*.toml`). */
  extension?: string;
  /** For a directory surface whose nested entries end in a fixed file (`<skill>/SKILL.md`). */
  entrypoint?: string;
}

export interface TargetDescriptor {
  harness: ProvisionHarness;
  surfaces: readonly TargetSurface[];
}

const CLAUDE_CODE: TargetDescriptor = {
  harness: "claude-code",
  surfaces: [
    { id: "instructions", location: "CLAUDE.md", label: "CLAUDE.md", layout: "file", format: "text", shape: "create" },
    {
      id: "agents",
      location: ".claude/agents",
      label: ".claude/agents/*.md",
      layout: "directory",
      format: "text",
      shape: "create",
      extension: ".md",
    },
    { id: "mcp", location: ".mcp.json", label: ".mcp.json", layout: "file", format: "json", shape: "merge" },
  ],
};

const CODEX: TargetDescriptor = {
  harness: "codex",
  surfaces: [
    { id: "instructions", location: "AGENTS.md", label: "AGENTS.md", layout: "file", format: "text", shape: "create" },
    {
      id: "agents",
      location: ".codex/agents",
      label: ".codex/agents/*.toml",
      layout: "directory",
      format: "toml",
      shape: "create",
      extension: ".toml",
    },
    {
      id: "mcp",
      location: ".codex/config.toml",
      label: ".codex/config.toml MCP tables",
      layout: "file",
      format: "toml",
      shape: "merge",
    },
    // Codex skills intentionally absent: authoritative discovery remains deferred to issue #36. The naive
    // `.codex/skills` root is known-wrong, so encoding it here would violate R10's verified-knowledge rule.
  ],
};

const CURSOR: TargetDescriptor = {
  harness: "cursor",
  surfaces: [
    {
      id: "agents",
      location: ".cursor/agents",
      label: ".cursor/agents/*.md",
      layout: "directory",
      format: "text",
      shape: "create",
      extension: ".md",
    },
    {
      id: "skills",
      location: ".cursor/skills",
      label: ".cursor/skills/**/SKILL.md",
      layout: "directory",
      format: "text",
      shape: "create",
      entrypoint: "SKILL.md",
    },
    {
      id: "mcp",
      location: ".cursor/mcp.json",
      label: ".cursor/mcp.json",
      layout: "file",
      format: "json",
      shape: "merge",
    },
  ],
};

/** Exactly one descriptor row per U10 provisioning harness (R13). */
export const TARGETS: Readonly<Record<ProvisionHarness, TargetDescriptor>> = {
  "claude-code": CLAUDE_CODE,
  codex: CODEX,
  cursor: CURSOR,
};

export interface ResolvedTarget {
  harness: ProvisionHarness;
  surface: TargetSurface;
  projectRoot: string;
  /** The normalized project-relative manifest destination. */
  relativeDestination: string;
  /** The resolved project-scoped destination. */
  destination: string;
  /** Absolute/project-scoped root of a directory-shaped surface; equal to destination for exact files. */
  surfaceRoot: string;
}

/**
 * Resolve a manifest destination only when it matches a known surface for that harness. Returns `null` for
 * unknown, absolute, or escaping destinations; the Manifest contract already rejects those paths, but this
 * boundary stays total when called directly.
 */
export function resolveTarget(
  projectRoot: string,
  harness: ProvisionHarness,
  destination: string,
): ResolvedTarget | null {
  const normalized = normalizeRelative(destination);
  if (normalized === null) return null;

  const surface = TARGETS[harness].surfaces.find((candidate) => matchesSurface(candidate, normalized));
  if (!surface) return null;

  return {
    harness,
    surface,
    projectRoot,
    relativeDestination: normalized,
    destination: posix.join(projectRoot, normalized),
    surfaceRoot: posix.join(projectRoot, surface.location),
  };
}

function normalizeRelative(path: string): string | null {
  if (path.length === 0 || path.includes("\0") || posix.isAbsolute(path)) return null;
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function matchesSurface(surface: TargetSurface, destination: string): boolean {
  if (surface.layout === "file") return destination === surface.location;

  const prefix = `${surface.location}/`;
  if (!destination.startsWith(prefix)) return false;
  const child = destination.slice(prefix.length);
  if (child.length === 0) return false;

  if (surface.extension) return !child.includes("/") && child.endsWith(surface.extension) && child !== surface.extension;
  if (surface.entrypoint) return child.includes("/") && child.endsWith(`/${surface.entrypoint}`);
  return true;
}

export type TargetPathState = "absent" | "file" | "directory" | "symlink" | "other";

/** Injected runtime reads keep compatibility checking deterministic and independently testable. */
export interface TargetInspection {
  stat(path: string): TargetPathState;
  read(path: string): string | null;
}

export type TargetCompatibility =
  | { compatible: true }
  | {
      compatible: false;
      surface: string;
      path: string;
      reason: "file-where-directory" | "symlink" | "non-file" | "unreadable" | "malformed" | "inspection-failed";
      message: string;
    };

/**
 * Fail-closed compatibility check for AE4/R10. Absence is normal for every create-shaped destination. A
 * merge-shaped existing config must be a readable, parseable object. Symlinks are refused at every inspected
 * parent and at the target itself so provisioning never writes through an indirection it did not describe.
 */
export function checkTargetCompatibility(target: ResolvedTarget, io: TargetInspection): TargetCompatibility {
  const { surface } = target;

  if (surface.layout === "directory") {
    const rootCheck = requireDirectoryOrAbsent(target.surfaceRoot, surface, io);
    if (rootCheck) return rootCheck;
  }

  for (const parent of destinationParents(target)) {
    if (parent === target.surfaceRoot) continue; // directory surfaces already inspected their root above
    const parentCheck = requireDirectoryOrAbsent(parent, surface, io);
    if (parentCheck) return parentCheck;
  }

  const targetState = inspectState(target.destination, surface, io);
  if (typeof targetState !== "string") return targetState;
  if (targetState === "absent") return { compatible: true };
  if (targetState === "symlink") return incompatible(surface, target.destination, "symlink", "is a symlink");
  if (targetState !== "file") {
    return incompatible(surface, target.destination, "non-file", "must be a regular file when present");
  }

  if (surface.shape === "create") return { compatible: true };

  let content: string | null;
  try {
    content = io.read(target.destination);
  } catch {
    return incompatible(surface, target.destination, "inspection-failed", "could not be inspected safely");
  }
  if (content === null) return incompatible(surface, target.destination, "unreadable", "is not readable");
  if (!isValidMergeConfig(surface.format, content)) {
    return incompatible(surface, target.destination, "malformed", `is not valid ${surface.format} object config`);
  }
  return { compatible: true };
}

function destinationParents(target: ResolvedTarget): string[] {
  const relativeParent = posix.dirname(target.relativeDestination);
  if (relativeParent === ".") return [];

  const parents: string[] = [];
  let current = "";
  for (const segment of relativeParent.split("/")) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    parents.push(posix.join(target.projectRoot, current));
  }
  return parents;
}

function requireDirectoryOrAbsent(path: string, surface: TargetSurface, io: TargetInspection): TargetCompatibility | null {
  const state = inspectState(path, surface, io);
  if (typeof state !== "string") return state;
  if (state === "absent" || state === "directory") return null;
  if (state === "symlink") return incompatible(surface, path, "symlink", "requires a directory but is a symlink");
  if (state === "file") return incompatible(surface, path, "file-where-directory", "requires a directory but is a regular file");
  return incompatible(surface, path, "non-file", "requires a directory but has an incompatible path type");
}

function inspectState(path: string, surface: TargetSurface, io: TargetInspection): TargetPathState | TargetCompatibility {
  try {
    return io.stat(path);
  } catch {
    return incompatible(surface, path, "inspection-failed", "could not be inspected safely");
  }
}

function incompatible(
  surface: TargetSurface,
  path: string,
  reason: Exclude<TargetCompatibility, { compatible: true }>["reason"],
  detail: string,
): TargetCompatibility {
  return {
    compatible: false,
    surface: surface.label,
    path,
    reason,
    message: `Provisioning surface '${surface.label}' is incompatible at '${path}': ${detail}`,
  };
}

function isValidMergeConfig(format: ConfigFormat, content: string): boolean {
  try {
    let parsed: unknown;
    switch (format) {
      case "json":
        parsed = JSON.parse(content);
        break;
      case "toml":
        parsed = parseToml(content);
        break;
      case "yaml":
        parsed = parseYaml(content);
        break;
      case "text":
        return false; // text has no merge semantics
      default:
        return assertNever(format);
    }
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function assertNever(value: never): never {
  throw new Error(`targets: unhandled config format '${String(value)}'`);
}
