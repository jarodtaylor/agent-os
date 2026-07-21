/**
 * Pure blueprint renderer (U10 U3 — R5/R6, KTD3/KTD6).
 *
 * Rendering performs no writes and owns no filesystem paths. Callers inject bounded reads for blueprint
 * sources and live destinations, keeping the core deterministic and fixture-friendly. Read failures become
 * typed, content-free results: a parser error can quote source bytes, so no thrown parser message crosses
 * this boundary.
 */
import { extname } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { ConfigFormat } from "../configwrite/index";
import type { Manifest, Runtime } from "../contract/index";
import type { ReadOutcome } from "./internal";

/** The shared bounded-read outcome from U1, named for U3 callers. */
export type ProvisionRead = ReadOutcome;

/** The two read namespaces a render needs. Paths are manifest-relative and project-relative respectively. */
export interface RenderIo {
  readSource(source: string): ProvisionRead;
  readDestination(destination: string): ProvisionRead;
}

export interface RenderWarning {
  code: "empty-source";
  role: string;
  source: string;
  destination: string;
}

interface RenderedCommon {
  role: string;
  harness: Runtime;
  destination: string;
  driftTracked: boolean;
  warnings: RenderWarning[];
}

export type RenderedFile =
  | (RenderedCommon & {
      transform: "copy" | "compose";
      format: ConfigFormat;
      content: string;
      patch: null;
    })
  | (RenderedCommon & {
      transform: "scaffold";
      format: ConfigFormat;
      /** `null` only for a scaffold whose destination was already present, so its source was not materialized. */
      content: string | null;
      patch: null;
    })
  | (RenderedCommon & {
      transform: "config-merge";
      format: Exclude<ConfigFormat, "text">;
      content: null;
      patch: Record<string, unknown>;
    });

export type RenderError =
  | {
      problem: "missing-source" | "unreadable-source" | "malformed-source" | "invalid-config-patch";
      role: string;
      harness: Runtime;
      source: string;
      destination: string;
    }
  | {
      problem: "unreadable-destination" | "unsupported-config-format";
      role: string;
      harness: Runtime;
      destination: string;
    };

export type RenderResult = { ok: true; files: RenderedFile[] } | { ok: false; error: RenderError };

/**
 * Render every manifest entry in manifest order. Stops on the first role/file failure so callers get one
 * loud, deterministic refusal rather than a partial plan whose missing row could look like a no-op.
 */
export function renderBlueprint(manifest: Manifest, io: RenderIo): RenderResult {
  const files: RenderedFile[] = [];
  const sourceReads = new Map<string, ProvisionRead>();

  for (const role of manifest.roles) {
    for (const entry of role.files) {
      const common = {
        role: role.name,
        harness: role.harness,
        destination: entry.destination,
        driftTracked: entry.transform === "scaffold" ? false : (entry.driftTracked ?? true),
      } satisfies Omit<RenderedCommon, "warnings">;
      const format = formatForDestination(entry.destination);

      switch (entry.transform) {
        case "copy": {
          const source = readRequiredSource(io, sourceReads, role.name, role.harness, entry.source, entry.destination);
          if (!source.ok) return source;
          files.push({ ...common, transform: "copy", format, content: source.content, patch: null, warnings: [] });
          break;
        }

        case "compose": {
          const parts: Array<{ source: string; content: string }> = [];
          const warnings: RenderWarning[] = [];
          for (const sourcePath of entry.sources) {
            const source = readRequiredSource(io, sourceReads, role.name, role.harness, sourcePath, entry.destination);
            if (!source.ok) return source;
            if (source.content.length === 0) {
              warnings.push({ code: "empty-source", role: role.name, source: sourcePath, destination: entry.destination });
            }
            parts.push({ source: sourcePath, content: source.content });
          }
          files.push({
            ...common,
            transform: "compose",
            format,
            content: composeV1(manifest.schemaVersion, parts),
            patch: null,
            warnings,
          });
          break;
        }

        case "scaffold": {
          const live = io.readDestination(entry.destination);
          if (!live.ok && live.reason === "blocked") {
            return {
              ok: false,
              error: {
                problem: "unreadable-destination",
                role: role.name,
                harness: role.harness,
                destination: entry.destination,
              },
            };
          }

          // Existing scaffolds are intentionally left alone. Do not even read their optional source: a stale
          // or missing seed cannot break a create-once surface that no longer needs materialization.
          if (live.ok) {
            files.push({ ...common, transform: "scaffold", format, content: null, patch: null, warnings: [] });
            break;
          }

          if (!entry.source) {
            files.push({ ...common, transform: "scaffold", format, content: "", patch: null, warnings: [] });
            break;
          }
          const source = readRequiredSource(io, sourceReads, role.name, role.harness, entry.source, entry.destination);
          if (!source.ok) return source;
          files.push({ ...common, transform: "scaffold", format, content: source.content, patch: null, warnings: [] });
          break;
        }

        case "config-merge": {
          if (format === "text") {
            return {
              ok: false,
              error: {
                problem: "unsupported-config-format",
                role: role.name,
                harness: role.harness,
                destination: entry.destination,
              },
            };
          }
          const source = readRequiredSource(io, sourceReads, role.name, role.harness, entry.source, entry.destination);
          if (!source.ok) return source;
          const parsed = parseConfigValue(format, source.content);
          if (!parsed.ok) {
            return {
              ok: false,
              error: {
                problem: "malformed-source",
                role: role.name,
                harness: role.harness,
                source: entry.source,
                destination: entry.destination,
              },
            };
          }
          if (!isPlainRecord(parsed.value)) {
            return {
              ok: false,
              error: {
                problem: "invalid-config-patch",
                role: role.name,
                harness: role.harness,
                source: entry.source,
                destination: entry.destination,
              },
            };
          }
          files.push({ ...common, transform: "config-merge", format, content: null, patch: parsed.value, warnings: [] });
          break;
        }

        default:
          return assertNever(entry);
      }
    }
  }

  return { ok: true, files };
}

/** Config formats follow the same extension vocabulary as U14; everything else is opaque text. */
function formatForDestination(destination: string): ConfigFormat {
  switch (extname(destination).toLowerCase()) {
    case ".json":
      return "json";
    case ".toml":
      return "toml";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      return "text";
  }
}

export type ParsedConfig = { ok: true; value: unknown } | { ok: false };

/** Read-side parser shared with diff. It is total and intentionally discards parser messages/content. */
export function parseConfigValue(format: Exclude<ConfigFormat, "text">, content: string): ParsedConfig {
  try {
    switch (format) {
      case "json":
        return { ok: true, value: JSON.parse(content) };
      case "toml":
        return { ok: true, value: parseToml(content) };
      case "yaml":
        return { ok: true, value: parseYaml(content) };
      default:
        return assertNever(format);
    }
  } catch {
    return { ok: false };
  }
}

/** Plain config maps only — arrays/scalars/class instances cannot be partial merge patches. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRequiredSource(
  io: RenderIo,
  sourceReads: Map<string, ProvisionRead>,
  role: string,
  harness: Runtime,
  source: string,
  destination: string,
): { ok: true; content: string } | { ok: false; error: RenderError } {
  let read = sourceReads.get(source);
  if (!read) {
    read = io.readSource(source);
    sourceReads.set(source, read);
  }
  if (read.ok) return read;
  return {
    ok: false,
    error: {
      problem: read.reason === "absent" ? "missing-source" : "unreadable-source",
      role,
      harness,
      source,
      destination,
    },
  };
}

/**
 * Schema-v1 compose recipe. The manifest schema owns the recipe version: future schema versions can change
 * framing without making an unchanged v1 blueprint churn forever. Source order and bytes are preserved.
 */
function composeV1(schemaVersion: number, parts: ReadonlyArray<{ source: string; content: string }>): string {
  const prefix = `<!-- agent-os compose; manifest schemaVersion=${schemaVersion} -->\n`;
  return (
    prefix +
    parts
      .map(({ source, content }) => `<!-- source: ${source} -->\n${content}`)
      .join("\n")
  );
}

function assertNever(value: never): never {
  throw new Error(`provision render: unhandled variant ${String(value)}`);
}
