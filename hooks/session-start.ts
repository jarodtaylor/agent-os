/**
 * Claude Code SessionStart hook (U6) — the DETERMINISTIC consumption path (KTD5). On startup|resume|clear
 * (the matcher the installer registers) it dials the brain, fetches the project's work-state through the
 * gated `GET /work-state`, and emits it as `hookSpecificOutput.additionalContext` so a FRESH session picks
 * up where the last one left off with nothing pasted (R1). This is the "readable ≠ read" crux: the hook
 * FORCES the context in, rather than hoping the agent chooses to call a tool.
 *
 * Fail-open is the #1 property: this runs on EVERY matching Claude Code session once installed, so a down
 * server, a missing token, a slow/failed request, an empty work-state, OR a valid-JSON wrong-shape response
 * all resolve to "emit nothing, exit 0" — and the entrypoint additionally wraps main() in a catch so even an
 * unforeseen throw can never block or slow session start.
 */
import type { WorkStateResponse } from "../src/workstate/response";
import { HARNESS, TOKEN_HEADER, baseUrl, fetchWithTimeout, readHookIdentity, readToken } from "./shared";

/** How many recent breadcrumb summaries to inline when the raw trail is the ONLY resume signal (AE1). */
const RAW_PREVIEW = 6;
/** How many recent breadcrumbs the hook pulls from the server. It previews RAW_PREVIEW; the remainder feed
 *  the volume counts ("+N newer", "…N earlier"). A payload-shape knob — kept modest so the per-session fetch
 *  + redaction stays proportional to what's displayed rather than the server's full default cap. */
const FETCH_LIMIT = 20;
/** Per-line cap on the curated cursor fields injected into context. Cursor.next/lastDecided carry NO contract
 *  length bound, so this is the one injected surface without a cap — clip it here, mirroring RAW_PREVIEW/
 *  FETCH_LIMIT, so an oversized handoff can't bloat every session's injected context. */
const CURSOR_MAX = 200;

/**
 * Shape a work-state response into the injected context. A LEAN summary — the curated cursor
 * (next / last-decided, length-capped) plus freshness/lane, and for an uncurated project a short preview of
 * the most recent NON-marker breadcrumbs with a pointer to `read_work_state` — never a dump of the (up-to-50)
 * raw trail. Pure and exported so the exact shape is unit-tested and cheap to tune; `now` is injectable for
 * deterministic relative-age assertions. Returns `null` when there is nothing worth injecting.
 */
export function formatAdditionalContext(resp: WorkStateResponse | null, now: number = Date.now()): string | null {
  if (!resp) return null;
  const lines: string[] = [
    `[Agent OS] Resuming this project — ${resp.freshness} state (${resp.lane} lane), last active ${relativeAge(resp.last_activity, now)}.`,
  ];
  if (resp.handoff) {
    // next / last-decided are the clean curated resume signals (length-capped). The handoff's in-flight
    // buffer is schema-marked `secret` and already redacted server-side, so it is never surfaced here.
    if (resp.handoff.cursor.next) lines.push(`Next: ${clip(resp.handoff.cursor.next)}`);
    if (resp.handoff.cursor.lastDecided) lines.push(`Last decided: ${clip(resp.handoff.cursor.lastDecided)}`);
  }
  // Exclude STRUCTURAL markers (session-end/session-start) from the preview + counts: they're bookkeeping for
  // crash-vs-clean-end detection, not resume activity, and the session-end marker is the most-recent crumb on
  // every clean end — left in, it would crowd the scarce RAW_PREVIEW slots. Still stored + visible via read_work_state.
  const tail = resp.raw_trail_tail.filter((c) => c.kind !== "session-end" && c.kind !== "session-start");
  if (tail.length > 0) {
    if (resp.lane === "raw") {
      // Uncurated: the trail is the ONLY resume signal (AE1). Inline the most-recent few summaries (already
      // redacted server-side), hand the agent the exact project key, then point at read_work_state for the rest.
      const recent = tail.slice(-RAW_PREVIEW);
      lines.push(`No curated handoff — most recent activity (call read_work_state({ project: ${JSON.stringify(resp.project)} }) for the full trail):`);
      for (const c of recent) lines.push(`  • ${c.summary}`);
      const earlier = tail.length - recent.length;
      if (earlier > 0) lines.push(`  … and ${earlier} earlier.`);
    } else {
      // Curated primary with newer NON-marker crumbs riding along (AE2): count them; the handoff is the payload.
      lines.push(`(+${tail.length} newer breadcrumb${tail.length === 1 ? "" : "s"} since the handoff — call read_work_state({ project: ${JSON.stringify(resp.project)} }) for detail.)`);
    }
  }
  return lines.join("\n");
}

/** Clip an injected cursor field to CURSOR_MAX chars with an ellipsis — bounds the one uncapped surface. */
function clip(s: string): string {
  return s.length > CURSOR_MAX ? `${s.slice(0, CURSOR_MAX)}…` : s;
}

/** Coarse human relative age: "just now", "5m ago", "3h ago", "2d ago". */
function relativeAge(ts: number, now: number): string {
  const min = Math.floor(Math.max(0, now - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Fetch the work-state, or `null` on ANY failure (no token, server down, non-200, timeout, bad JSON, or a
 *  valid-JSON WRONG-shape body). Never throws — every failure mode is the same "nothing to inject" outcome. */
async function fetchWorkState(project: string, sessionId: string): Promise<WorkStateResponse | null> {
  const token = readToken();
  if (!token) return null; // no live token → the server isn't up (or isn't this boot); nothing to inject
  const res = await fetchWithTimeout(`${baseUrl()}/work-state?project=${encodeURIComponent(project)}&limit=${FETCH_LIMIT}`, {
    headers: { [TOKEN_HEADER]: token, "x-agent-os-harness": HARNESS, "x-agent-os-session": sessionId },
  });
  if (!res || !res.ok) return null; // unreachable, timed out, or non-200 → nothing to inject
  try {
    const body = (await res.json()) as WorkStateResponse | null;
    // Coarse shape guard: a valid-JSON but WRONG-shape 200 (a foreign process squatting the port, or
    // hook/server version skew) is treated as "nothing to inject", exactly like a down server — never trusted
    // into formatAdditionalContext, whose tail access would otherwise throw and break the fail-open contract.
    return body && Array.isArray((body as { raw_trail_tail?: unknown }).raw_trail_tail) ? body : null;
  } catch {
    return null; // a malformed body is "nothing to inject", same as a down server
  }
}

async function main(): Promise<void> {
  const { project, sessionId } = await readHookIdentity();
  if (!project) return; // no cwd → can't key a lookup; emit nothing (fail-open)
  const context = formatAdditionalContext(await fetchWorkState(project, sessionId));
  if (!context) return; // nothing to inject
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }),
  );
}

if (import.meta.main) {
  // Fail-open backstop: a SessionStart hook must NEVER disrupt session start. Any unforeseen throw (a
  // wrong-shape body slipping the guard, an stdout write error) is swallowed to STDERR — never stdout, which
  // is the additionalContext channel — and the hook exits 0.
  main().catch((err) => console.error("[agent-os] session-start hook error (ignored):", err));
}
