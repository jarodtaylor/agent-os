/**
 * The ONE shared work-state read path (U4): `repo.readWorkState → redact → present → logAccess`. BOTH
 * the MCP `read_work_state` tool and the `GET /work-state` HTTP route call this, so their payloads are
 * identical BY CONSTRUCTION (VS parity) — not two hand-kept-in-sync implementations. Redaction runs
 * through the single choke-point (`../redact/apply`), and the access log is written here — the ONE place
 * substrate CONSUMPTION is recorded (repo reads deliberately don't self-log; see repo.ts decision #4).
 */
import { WorkState, type Breadcrumb, type Handoff, type Lane, type Sensitivity } from "../contract/index";
import { redact } from "../redact/apply";
import type { Repo } from "../store/repo";

/**
 * How current the curated view is (R6). `fresh` — the handoff IS the latest activity. `stale` — work
 * happened after the last handoff, so newer breadcrumbs ride along in `raw_trail_tail`. `uncurated` —
 * no curated handoff at all; the raw trail is the only resume signal (AE1). A `write_handoff` flips a
 * stale/uncurated project to fresh.
 */
export type Freshness = "fresh" | "stale" | "uncurated";

/**
 * The presented resume payload (R1). snake_case envelope per the plan; nested records keep their
 * contract (camelCase) shape — redacted, but structurally identical — so no parallel snake_case schema
 * can drift from the contract. `project` is echoed so the response is self-describing.
 */
export interface WorkStateResponse {
  project: string;
  lane: Lane;
  freshness: Freshness;
  last_activity: number;
  handoff: Handoff | null;
  raw_trail_tail: Breadcrumb[];
}

/** Who/what is consuming — labels the access-log row. NEVER affects the payload, so parity is preserved. */
export interface ConsumerContext {
  harness: string;
  tool: string;
  sessionId?: string;
}

/**
 * Default cap on the resume tail (U2-R6). Sized generously — the curated handoff is the primary payload
 * and the tail is "what happened since" — while bounding server memory + payload. A v1 default, not a
 * measured constant; tune when real resume needs / a payload ceiling are known.
 */
export const DEFAULT_TRAIL_CAP = 50;

export interface WorkStateReadOptions {
  /** Cap on `raw_trail_tail` (U2-R6). Defaults to `DEFAULT_TRAIL_CAP`. */
  limit?: number;
  /** Redaction threshold forwarded to the choke-point. Defaults to `secret`. */
  threshold?: Sensitivity;
  /** Wall-clock ms for the access-log row — injected so the shared path is deterministic in tests. */
  now?: number;
}

/**
 * Read → redact → present → log. Returns `null` when the project has no resume state (still logged: the
 * agent consumed the substrate even on a miss). The access log is written for EVERY call.
 */
export async function readWorkStateResponse(
  repo: Repo,
  project: string,
  consumer: ConsumerContext,
  opts: WorkStateReadOptions = {},
): Promise<WorkStateResponse | null> {
  const ws = await repo.readWorkState(project, opts.limit ?? DEFAULT_TRAIL_CAP);
  await repo.logAccess({
    sessionId: consumer.sessionId,
    harness: consumer.harness,
    tool: consumer.tool,
    project,
    ts: opts.now ?? Date.now(),
  });
  if (!ws) return null;
  return present(redact(ws, WorkState, { threshold: opts.threshold }));
}

/** Shape the redacted `WorkState` into the external response (snake_case envelope + derived freshness). */
function present(ws: WorkState): WorkStateResponse {
  const rawTrailTail = ws.rawTrailTail ?? [];
  const freshness: Freshness =
    ws.lane === "raw" ? "uncurated" : rawTrailTail.length > 0 ? "stale" : "fresh";
  return {
    project: ws.project,
    lane: ws.lane,
    freshness,
    last_activity: ws.lastActivity,
    handoff: ws.handoff ?? null,
    raw_trail_tail: rawTrailTail,
  };
}
