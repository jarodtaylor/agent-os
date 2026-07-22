/**
 * Pure rendered-vs-live diff (U10 U3 — R5/R8 read side, KTD8).
 *
 * Structured configs are compared as parsed values before any write/serialization decision. Opaque text is
 * compared by exact bytes. Scaffold rows are create-once and never drift. No function in this module writes.
 */
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { deepMerge } from "../configwrite/index";
import type { ConfigFormat } from "../configwrite/index";
import type { Runtime } from "../contract/index";
import { isPlainRecord, parseConfigValue, type RenderedFile } from "./render";

export type PlanAction = "create" | "noop" | "overwrite" | "merge" | "scaffold-skip";

export interface DiffRow {
  role: string;
  harness: Runtime;
  destination: string;
  action: PlanAction;
  drift: boolean;
}

export type DiffError =
  | {
      problem: "unreadable-destination" | "stale-scaffold";
      role: string;
      harness: Runtime;
      destination: string;
      /** WHY the destination could not be read, when the reader knew (`unreadable-destination` only). Carried
       *  because the three causes have completely different remedies — remove the symlink, shrink the file,
       *  fix the permissions — and "unreadable-destination" alone sends the operator hunting. Still a fixed
       *  enum, never a message derived from bytes, so KTD5 is untouched. */
      blockedBy?: BlockedReason;
    }
  | {
      problem: "malformed-destination" | "invalid-config-destination" | "malformed-rendered";
      role: string;
      harness: Runtime;
      destination: string;
      format: ConfigFormat;
    };

export type DiffResult = { ok: true; rows: DiffRow[] } | { ok: false; error: DiffError };

/** Why a present destination could not be safely read. A fixed enum, not a message: `symlink` (provisioning
 *  never reads or writes through an indirection it did not describe), `oversized` (past the shared 16 MiB read
 *  bound), `non-regular` (a directory/FIFO/device), `unreadable` (permissions or any other lookup failure). */
export type BlockedReason = "symlink" | "oversized" | "non-regular" | "unreadable";

/** A live destination read retains raw bytes for KTD8's opaque-text identity check. */
export type DestinationRead =
  | { ok: true; content: string; bytes: Uint8Array }
  | { ok: false; reason: "absent" | "blocked"; blockedBy?: BlockedReason };

export type DestinationReader = (destination: string) => DestinationRead;

/** Diff in manifest/render order, returning the first content-free read/parse failure. */
export function diffRendered(files: readonly RenderedFile[], readDestination: DestinationReader): DiffResult {
  const rows: DiffRow[] = [];

  for (const file of files) {
    const live = readDestination(file.destination);
    if (!live.ok && live.reason === "blocked") return failure(file, "unreadable-destination", live.blockedBy);

    if (!live.ok) {
      if (file.transform === "scaffold" && file.content === null) return failure(file, "stale-scaffold");
      rows.push(row(file, "create"));
      continue;
    }

    if (file.transform === "scaffold") {
      rows.push(row(file, "scaffold-skip"));
      continue;
    }

    if (file.transform === "config-merge") {
      const parsed = parseLiveConfig(file, file.format, live.content);
      if (!parsed.ok) return parsed;
      if (!isPlainRecord(parsed.value)) return configFailure(file, "invalid-config-destination");

      // Ask the semantic presence question against the exact merge U14 will perform. Foreign formatting and
      // foreign keys cannot turn an already-present patch into a false write.
      const merged = deepMerge(parsed.value, file.patch);
      const action: PlanAction = isDeepStrictEqual(merged, parsed.value) ? "noop" : "merge";
      rows.push(row(file, action));
      continue;
    }

    if (file.format === "text") {
      const action: PlanAction = Buffer.from(file.content, "utf8").equals(live.bytes) ? "noop" : "overwrite";
      rows.push(row(file, action));
      continue;
    }

    const rendered = parseConfigValue(file.format, file.content);
    if (!rendered.ok) return configFailure(file, "malformed-rendered");
    const parsed = parseLiveConfig(file, file.format, live.content);
    // Copy and compose own the whole destination. A valid render can safely replace malformed live
    // structured content; config-merge above remains strict because it needs a valid merge base.
    if (!parsed.ok) {
      rows.push(row(file, "overwrite"));
      continue;
    }
    const action: PlanAction = isDeepStrictEqual(rendered.value, parsed.value) ? "noop" : "overwrite";
    rows.push(row(file, action));
  }

  return { ok: true, rows };
}

function parseLiveConfig(
  file: RenderedFile,
  format: Exclude<ConfigFormat, "text">,
  content: string,
): { ok: true; value: unknown } | { ok: false; error: DiffError } {
  const parsed = parseConfigValue(format, content);
  return parsed.ok ? parsed : configFailure(file, "malformed-destination");
}

/**
 * DRIFT MEANS DIVERGENCE, NOT "WOULD WRITE". Only `overwrite` and `merge` describe a live surface that EXISTS
 * and disagrees with the blueprint — the two actions a drift report is actually about. A `create` row means the
 * destination is ABSENT (never provisioned), which is not drift: without this restriction, `status` on a
 * freshly-`init`ed project reports every tracked row as drifted and its `drifted` count is non-zero before a
 * single byte was ever written — a false positive on the most common first run, and one that lies to a machine
 * consumer reading `--json`, not just to the table.
 *
 * The narrowing lives HERE rather than in the CLI's rendering because `DiffRow.drift` is the one shared field
 * every consumer reads — `plan`, `status`, and the U7 `provision_status` MCP tool all build their output from
 * it. Fixing only the CLI's summary would leave the field itself lying to the next consumer.
 *
 * `scaffold` needs no separate guard now: a scaffold row is create-once, so `diffRendered` short-circuits it to
 * `scaffold-skip` (present) or emits `create` (absent) — it can never reach `overwrite`/`merge`. Its exclusion
 * from drift (KTD8) therefore falls out of the action check instead of being asserted twice.
 */
function row(file: RenderedFile, action: PlanAction): DiffRow {
  const drift = (action === "overwrite" || action === "merge") && file.driftTracked;
  return { role: file.role, harness: file.harness, destination: file.destination, action, drift };
}

function failure(
  file: RenderedFile,
  problem: "unreadable-destination" | "stale-scaffold",
  blockedBy?: BlockedReason,
): { ok: false; error: DiffError } {
  const error: DiffError = { problem, role: file.role, harness: file.harness, destination: file.destination };
  // Omitted entirely rather than set to `undefined` when the reader did not say, so a consumer never has to
  // distinguish "absent" from "explicitly unknown".
  return { ok: false, error: blockedBy ? { ...error, blockedBy } : error };
}

function configFailure(
  file: RenderedFile,
  problem: "malformed-destination" | "invalid-config-destination" | "malformed-rendered",
): { ok: false; error: DiffError } {
  return {
    ok: false,
    error: { problem, role: file.role, harness: file.harness, destination: file.destination, format: file.format },
  };
}
