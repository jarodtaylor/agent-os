/**
 * The known-projects registry (U10 U6 — KTD11): the ONE bridge from a logical project NAME to a place on disk.
 *
 * WHY IT EXISTS: U7's propose MCP tools take a `project` argument supplied by an agent. If any code path joined
 * that string into a filesystem path, an MCP caller would own an arbitrary-path oracle over the operator's
 * machine. Instead `project` stays a LOGICAL KEY: `init` records the mapping here, and every consumer resolves
 * a name through `lookupProject` — an unknown name is a typed refusal that touches no filesystem at all. The
 * registry is therefore a whitelist, not a lookup convenience, and nothing else in the system may translate a
 * caller-supplied project string into a path.
 *
 * WHY APPEND-ONLY JSONL, mirroring `batch-status.ts` and the undo journal: a read-modify-write JSON object
 * would need its own atomic-rewrite + crash story for a file that only ever grows by one line per `init`.
 * Append-only reuses the discipline already proven twice in this data dir — one self-contained line per record,
 * a torn tail isolated by leading with a newline, malformed lines skipped on read, newest record per name wins.
 *
 * UNTRUSTED INPUT: the file can be hand-edited, torn mid-append, or partially written on a crash, so every line
 * is zod-validated on read (never an `as` cast) and every reader is total — a corrupt registry degrades to
 * "fewer known projects", never a throw in a caller's read path.
 *
 * ROOTS ARE STORED CANONICAL (issue #51.1): callers hand this module an ALREADY-realpath'd project root (the
 * CLI canonicalizes once at ingress). Storing the canonical identity is what makes the registry agree with the
 * undo journal's `projectRoot` stamps, so a project reached through a symlink resolves to one identity
 * everywhere. This module does not itself realpath — it cannot, since it must stay total and a record may name
 * a root that no longer exists.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { resolveDataDir } from "../paths";
import { appendJsonlRecord } from "./internal";

/**
 * Is this a LOGICAL project name — a key, never a path fragment? Refuses everything that could act as a path
 * segment or a traversal (`/`, `\`, NUL, the bare `.`/`..`), plus empties and absurd lengths. This is defense
 * in depth, not the primary defense: the primary defense is that no consumer ever path-joins a name at all.
 * Backslash is refused even though this is a POSIX-only tool, so a name can never grow teeth on a future host.
 */
const MAX_NAME_LENGTH = 128;
export function isLogicalProjectName(name: string): boolean {
  if (name.trim() !== name || name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  if (name === "." || name === "..") return false;
  return !/[\/\\\0]/.test(name);
}

/** One registered project. `projectRoot` is where native surfaces are written; `blueprintRoot` is where the
 *  manifest lives. Both are stored explicitly rather than deriving one from the other, so a future blueprint
 *  location (a monorepo sub-path) needs no migration and no consumer re-derives a path convention. */
export const KnownProjectRecord = z.object({
  name: z.string().min(1).refine(isLogicalProjectName),
  projectRoot: z.string().min(1),
  blueprintRoot: z.string().min(1),
  ts: z.number().int().nonnegative(),
});
export type KnownProjectRecord = z.infer<typeof KnownProjectRecord>;

/** The registry file, a sibling of the undo journal and the batch-status sidecar. Takes an ALREADY-resolved
 *  dataDir, mirroring `batchStatusPath`, so the three data-dir files can never land in different directories. */
export function knownProjectsPath(dataDir: string): string {
  return join(dataDir, "known-projects.jsonl");
}

/** What a project registration did. `conflict` is the load-bearing one: a name already bound to a DIFFERENT
 *  root must never be silently rebound, or `init` in a second repo whose basename collides would quietly
 *  redirect every U7 lookup for the first one. The caller (the CLI) reports it and offers `--name`. */
export type RegisterOutcome =
  | { kind: "registered"; record: KnownProjectRecord }
  | { kind: "conflict"; name: string; existing: KnownProjectRecord }
  | { kind: "invalid-name"; name: string }
  | { kind: "write-failed"; name: string; error: string };

/**
 * Bind `name` to this project. Unlike `recordBatchStatus` (best-effort metadata about an already-finished
 * apply), this write is LOAD-BEARING — without it U7 cannot resolve the project at all — so a failure is
 * RETURNED for the caller to report, never swallowed.
 *
 * Re-registering the same name at the same root is idempotent by design: `init --force` re-runs it, and the
 * newest-wins read means an appended duplicate resolves identically.
 */
export function registerProject(
  dataDir: string,
  entry: { name: string; projectRoot: string; blueprintRoot: string },
): RegisterOutcome {
  const { name, projectRoot, blueprintRoot } = entry;
  if (!isLogicalProjectName(name)) return { kind: "invalid-name", name };

  const resolved = resolveDataDir(dataDir);
  const existing = readKnownProjects(resolved).get(name);
  if (existing && existing.projectRoot !== projectRoot) return { kind: "conflict", name, existing };

  const record: KnownProjectRecord = { name, projectRoot, blueprintRoot, ts: Date.now() };
  const path = knownProjectsPath(resolved);
  try {
    appendJsonlRecord(path, record);
  } catch (err) {
    return { kind: "write-failed", name, error: err instanceof Error ? err.message : String(err) };
  }
  return { kind: "registered", record };
}

/**
 * Every well-formed registration, newest record winning per `name`. Malformed/torn/schema-invalid lines are
 * skipped — one corrupt row must not hide the good records around it — and an absent or unreadable file yields
 * an empty map, so an unknown name is the fail-closed answer (a refusal), never an accidental resolution.
 */
export function readKnownProjects(dataDir?: string): Map<string, KnownProjectRecord> {
  const path = knownProjectsPath(resolveDataDir(dataDir));
  const out = new Map<string, KnownProjectRecord>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out; // absent or unreadable — no project is known, which refuses every lookup
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      continue; // torn / partial line — skip, keep reading
    }
    const parsed = KnownProjectRecord.safeParse(parsedLine);
    if (!parsed.success) continue;
    // Newest `ts` wins, with a later LINE breaking a tie: two `init` runs in the same millisecond must still
    // resolve deterministically to the one that ran last.
    const current = out.get(parsed.data.name);
    if (!current || parsed.data.ts >= current.ts) out.set(parsed.data.name, parsed.data);
  }
  return out;
}

/** The result of resolving a logical project name. `unknown` carries only the name the caller already had —
 *  no path, no filesystem access, nothing that could confirm or deny what exists on disk. */
export type ProjectLookup = { kind: "found"; record: KnownProjectRecord } | { kind: "unknown"; name: string };

/** Resolve a logical project name to its recorded roots. THE one bridge from an MCP-supplied `project` string
 *  to disk (KTD11) — an unregistered name is refused before any path is constructed. */
export function lookupProject(name: string, dataDir?: string): ProjectLookup {
  const record = readKnownProjects(dataDir).get(name);
  return record ? { kind: "found", record } : { kind: "unknown", name };
}
