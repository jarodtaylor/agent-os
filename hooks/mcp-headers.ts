/**
 * MCP `headersHelper` (U6) — emits the brain MCP server's per-boot auth header as JSON on stdout.
 *
 * Claude Code runs this command FRESH on every MCP connection (session start + reconnect, and again on a
 * 401/403 retry as of CC v2.1.193), so the token is read at CALL TIME and is NEVER embedded in the static
 * `~/.claude.json`. That is exactly KTD6's discipline — "callers acquire the token by reading the token
 * file at call time" — applied to Claude Code's native MCP client, which can't read the file itself.
 *
 * Fail-open: a missing token file (server not running yet) yields an EMPTY token via `readToken` rather than
 * an error, so Claude Code simply marks the MCP server unavailable and the session still starts; the helper
 * re-runs on the next reconnect and picks up the real token once the server is up. The output is always a
 * valid JSON object of string headers (CC's contract), even on the failure path.
 */
import { TOKEN_HEADER, readToken } from "./shared";

if (import.meta.main) {
  // Fail-open: always emit a valid JSON headers object (CC's contract). readToken already swallows a missing
  // token file (→ ""); the try/catch guards any other unforeseen throw so CC never sees malformed output —
  // it just marks the server unavailable and re-runs this helper on the next connection.
  try {
    process.stdout.write(JSON.stringify({ [TOKEN_HEADER]: readToken() }));
  } catch {
    process.stdout.write(JSON.stringify({ [TOKEN_HEADER]: "" }));
  }
}
