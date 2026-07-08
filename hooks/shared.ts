/**
 * Shared runtime helpers for the U6 Claude Code hooks (session-start, session-end, mcp-headers). One home
 * for the daemon-dialing contract so a hook can never drift from the server: the port comes from
 * `resolvePort`, the token header name from `TOKEN_HEADER`, and the per-boot token is read from its file at
 * CALL TIME (KTD6) — all from `../src/paths`, never embedded in any installed config.
 */
import { readFileSync } from "node:fs";
import { TOKEN_HEADER, resolveDataDir, resolvePort, tokenPath } from "../src/paths";

/** Re-exported so a hook imports the whole daemon-dialing contract from this one module. */
export { TOKEN_HEADER };

/** This harness's label — stamped on the access-log row (via the x-agent-os-harness header) so VS6's hit
 *  rate is computable per harness. */
export const HARNESS = "claude-code";

/** Shared fetch ceiling for the hooks — one home so tuning it can't drift between session-start and -end.
 *  Short by design: a resume hint (or a graceful-end marker) is never worth delaying session start/teardown. */
export const FETCH_TIMEOUT_MS = 1500;

/** The brain's loopback base URL, no trailing slash. Port is shared with the server through resolvePort. */
export function baseUrl(): string {
  return `http://127.0.0.1:${resolvePort()}`;
}

/** The current boot's token, read LIVE (KTD6), or "" when the token file is absent/unreadable — which is
 *  how a caller learns the server isn't up (or isn't this boot) without a doomed network round-trip. */
export function readToken(): string {
  try {
    return readFileSync(tokenPath(resolveDataDir()), "utf8").trim();
  } catch {
    return "";
  }
}

/** Read the hook payload from stdin and pull the two identity fields every CC hook carries (cwd → project,
 *  session_id). Missing/non-string fields become "". Each hook keeps its OWN presence guard afterward
 *  (session-start needs only project; session-end needs both), so that policy stays visible at the call site.
 *  Fails OPEN: an empty/unparseable payload yields two empty strings, never a throw. */
export async function readHookIdentity(): Promise<{ project: string; sessionId: string }> {
  const payload = await readStdinPayload();
  return {
    project: typeof payload.cwd === "string" ? payload.cwd : "",
    sessionId: typeof payload.session_id === "string" ? payload.session_id : "",
  };
}

/** `fetch` with an abort-based timeout, returning `null` on ANY failure (network error, timeout, abort) — the
 *  hooks' shared "substrate unreachable ⇒ nothing to do" primitive. Owns ONLY the timer + abort + catch-null;
 *  each caller interprets the Response (status, body) itself. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read + JSON-parse the hook payload from stdin. Returns `{}` on empty or invalid input, so the hooks fail
 *  OPEN — an unparseable payload degrades to "do nothing", never a throw that could disrupt the session. */
async function readStdinPayload(): Promise<Record<string, unknown>> {
  try {
    const text = await Bun.stdin.text();
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
