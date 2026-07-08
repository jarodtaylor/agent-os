/**
 * Claude Code SessionEnd hook (U6) — records a graceful-end MARKER via the gated `POST /session-end` so the
 * substrate can tell a clean end from a crash. It is NOT load-bearing: U5's tailer owns real capture, so if
 * this fails (server down, timeout, non-2xx) nothing is lost — the breadcrumb trail is already on disk.
 * SessionEnd can neither inject context nor block, so this is pure best-effort side effect: any failure is
 * swallowed (fetchWithTimeout returns null) and the hook exits 0.
 */
import { TOKEN_HEADER, baseUrl, fetchWithTimeout, readHookIdentity, readToken } from "./shared";

async function main(): Promise<void> {
  const { project, sessionId } = await readHookIdentity();
  if (!project || !sessionId) return; // both are needed to key the marker; otherwise nothing to record
  const token = readToken();
  if (!token) return; // server isn't up → skip; U5's tailer already captured the trail
  await fetchWithTimeout(`${baseUrl()}/session-end`, {
    method: "POST",
    headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
    body: JSON.stringify({ project, sessionId }),
  });
  // Response intentionally ignored — a non-2xx or a null (failed/timed-out) result both just mean "skip".
}

if (import.meta.main) {
  // Fail-open backstop (same discipline as session-start): a hook must never disrupt session teardown, so
  // any unforeseen throw is swallowed to stderr and the hook exits 0. The marker is not load-bearing anyway.
  main().catch((err) => console.error("[agent-os] session-end hook error (ignored):", err));
}
