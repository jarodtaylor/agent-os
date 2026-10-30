/**
 * The shared read pipeline (KTD5) — front-gate, render, diff, preflight — used by every surface that reports on a
 * project WITHOUT writing it: the CLI's `plan`/`status` (U6) and the propose-only MCP tools (U7). One core, so the
 * operator's terminal and an agent's tool call can never disagree about what "changed" or "drifted" means, and a
 * refusal reads identically on both (issue #56).
 *
 * Every message here is content-free: paths, roles, harnesses, actions, and structural problem codes only
 * (decision #45 — no secret escapes any read path).
 */
import { posix } from "node:path";
import type { Manifest } from "../contract/index";
import { preflightRows } from "./apply";
import { loadBlueprint } from "./blueprint";
import { diffErrorText, diffRendered, type DiffRow } from "./diff";
import { readDestinationBounded, readFileBounded } from "./internal";
import { renderBlueprint, renderErrorText, type RenderIo } from "./render";
import { liveProvisionedTargets } from "./runs";

export type Gated = { ok: true; manifest: Manifest } | { ok: false; error: string };

/**
 * The KTD5 front-gate, translated from the loader's typed result into ONE operator-facing message per failure
 * mode. Every verb that reads a blueprint runs this — `status` included, which is the case the rule exists
 * for: a drift report that materialized a secret-bearing blueprint would be a read path a secret escapes on.
 * `undo` deliberately does NOT gate: it reverses journal entries and reads no blueprint, and gating it would
 * make a blueprint that later grew a secret impossible to un-apply.
 */
export function gate(blueprintRoot: string): Gated {
  const load = loadBlueprint(blueprintRoot);
  switch (load.kind) {
    case "loaded":
      return { ok: true, manifest: load.manifest };
    case "absent":
      return { ok: false, error: `no blueprint manifest at '${load.manifestPath}' — run \`init\` to create one` };
    case "schema-incompatible":
      return { ok: false, error: load.message };
    case "secret-hit":
      // Names the FILE, never the match: the whole point of the gate is that these bytes do not travel.
      return { ok: false, error: `blueprint file '${load.file}' failed the secret gate — refusing to provision (its content is not shown)` };
    case "invalid":
      return { ok: false, error: `blueprint file '${load.file}' is invalid (${load.problem})${load.detail ? `: ${load.detail}` : ""}` };
    default:
      return assertNever(load);
  }
}

export type Surveyed = { ok: true; rows: DiffRow[] } | { ok: false; error: string };

/**
 * Render + diff + preflight a project's blueprint against its live surfaces — the read half of the pipeline, shared by
 * `plan` and `status` so the two can never disagree about what "changed" means. `apply` does NOT call this:
 * it re-renders internally from the current blueprint (KTD7), which is what closes the stale-plan TOCTOU. So
 * this is a second CALL SITE of the same pure core, not a second implementation of it.
 */
export function survey(projectRoot: string, blueprintRoot: string, dataDir: string): Surveyed {
  const gated = gate(blueprintRoot);
  if (!gated.ok) return gated;

  const io: RenderIo = {
    readSource: (source) => readFileBounded(posix.join(blueprintRoot, source)),
    readDestination: (destination) => readFileBounded(posix.join(projectRoot, destination)),
  };
  const rendered = renderBlueprint(gated.manifest, io);
  if (!rendered.ok) return { ok: false, error: renderErrorText(rendered.error) };

  // The journal tells a deleted provisioned surface (drift) from one nothing ever wrote (not drift) — see `diff.ts`.
  // An unreadable journal THROWS out of the shared reader; refuse here with the typed failure rather than crash
  // past `--json`'s payload, and never fall back to "no history", which would hide missing-file drift (PR #61).
  let live: Set<string>;
  try {
    live = liveProvisionedTargets(projectRoot, dataDir);
  } catch {
    return { ok: false, error: "the provisioning history (undo journal) exists but cannot be read — refusing to report drift without it" };
  }
  const diffed = diffRendered(
    rendered.files,
    (destination) => readDestinationBounded(posix.join(projectRoot, destination)),
    (destination) => live.has(posix.join(projectRoot, destination)),
  );
  if (!diffed.ok) return { ok: false, error: diffErrorText(diffed.error) };
  // apply's own non-mutating preflight (resolution, shape guard, secret scan, compatibility, duplicate writers):
  // without it a dry run would advertise changes for a blueprint `apply` refuses before writing (PR #61). The
  // failure texts are already content-free — paths, surface labels, and fixed strings only.
  const { failures } = preflightRows(projectRoot, rendered.files, diffed.rows);
  if (failures.length > 0) {
    return { ok: false, error: `apply would refuse this blueprint: ${failures.map(({ path, error }) => `${path}: ${error}`).join("; ")}` };
  }
  return { ok: true, rows: diffed.rows };
}

/** The `plan` view of a survey: every row, and how many would change. Shared by the CLI and the MCP tool so an
 *  operator and an agent count "changes" the same way. */
export function planView(rows: DiffRow[]): { rows: DiffRow[]; changes: number } {
  return { rows, changes: rows.filter((row) => row.action !== "noop" && row.action !== "scaffold-skip").length };
}

/** The `status` (drift) view: scaffold rows are excluded outright (KTD8: a create-once surface cannot drift by
 *  definition, so listing it would train the reader to ignore the report). */
export function statusView(rows: DiffRow[]): { rows: DiffRow[]; drifted: number } {
  const tracked = rows.filter((row) => row.action !== "scaffold-skip");
  return { rows: tracked, drifted: tracked.filter((row) => row.drift).length };
}

function assertNever(value: never): never {
  throw new Error(`provision survey: unhandled variant ${String(value)}`);
}
