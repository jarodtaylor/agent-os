/**
 * Codex SessionStart hook (U8) — the DETERMINISTIC consumption path for Codex, mirroring the Claude Code
 * SessionStart hook (U6, `./session-start.ts`). Codex fires a SessionStart hook and injects a command
 * hook's STDOUT into the session as a `developer`-role message (verified from real rollout logs) — unlike
 * Claude Code's `hookSpecificOutput.additionalContext` JSON envelope, Codex wants PLAIN TEXT on stdout.
 * That is the ONE real difference from `./session-start.ts`: the fetch + shaping is identical (this hook
 * imports `formatAdditionalContext` rather than re-implementing it), so the two harnesses' resume
 * summaries can never drift apart in content — only in how they're serialized to their respective hosts.
 *
 * Fail-open is the #1 property (this runs on EVERY Codex session once installed): every failure mode — no
 * token, server down, non-200, timeout, bad/empty stdin, wrong-shape body, empty work-state — resolves to
 * "write nothing to stdout, exit 0", exactly like the CC hook.
 */
import { formatAdditionalContext, type WorkStateResponse } from "./session-start";
import { TOKEN_HEADER, baseUrl, fetchWithTimeout, readHookIdentity, readToken } from "./shared";

/** This harness's label — stamped on the access-log row (via the x-agent-os-harness header) so VS6's hit
 *  rate is computable per harness (Codex vs Claude Code). Deliberately NOT `shared.ts`'s `HARNESS`, which
 *  is hardcoded to "claude-code" for the CC hooks. */
const HARNESS = "codex";

/** Mirrors `./session-start.ts`'s FETCH_LIMIT (a separate constant, not imported, so the two hooks' fetch
 *  sizing can be tuned independently): how many recent breadcrumbs this hook pulls from the server for
 *  `formatAdditionalContext`'s raw-lane preview + volume counts. */
const FETCH_LIMIT = 20;

/** Fetch the work-state, or `null` on ANY failure (no token, server down, non-200, timeout, bad JSON, or a
 *  valid-JSON WRONG-shape body) — identical contract to the CC hook's `fetchWorkState`, just labeled with
 *  the codex harness header. Never throws — every failure mode is the same "nothing to inject" outcome. */
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
    // hook/server version skew) is treated as "nothing to inject", exactly like a down server — never
    // trusted into formatAdditionalContext, whose tail access would otherwise throw.
    return body && Array.isArray((body as { raw_trail_tail?: unknown }).raw_trail_tail) ? body : null;
  } catch {
    return null; // a malformed body is "nothing to inject", same as a down server
  }
}

async function main(): Promise<void> {
  const { project: cwdFromPayload, sessionId } = await readHookIdentity();
  // Codex may not pass `cwd` in the stdin payload the way Claude Code does. The hook always runs IN the
  // session's cwd regardless, so `process.cwd()` is a correct fallback identity for the project key.
  const project = cwdFromPayload || process.cwd();
  if (!project) return; // no cwd, from payload OR process → can't key a lookup; emit nothing (fail-open)
  const context = formatAdditionalContext(await fetchWorkState(project, sessionId));
  if (!context) return; // nothing to inject
  // PLAIN TEXT, not the CC hook's JSON envelope: Codex injects a SessionStart hook's stdout verbatim as a
  // developer-role message, so there is no wrapper to build — the shaped string IS the output.
  process.stdout.write(context);
}

if (import.meta.main) {
  // Fail-open backstop: a SessionStart hook must NEVER disrupt session start. Any unforeseen throw is
  // swallowed to STDERR — never stdout, which is the injected-message channel — and the hook exits 0.
  main().catch((err) => console.error("[agent-os] codex-session-start hook error (ignored):", err));
}
