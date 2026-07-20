/**
 * The Codex credential — ONE location, ONE reader (issue #24, resolving the DECISIONS #29 trigger).
 *
 * Codex's HTTP-MCP client can only send a STATIC header, so it authenticates with a stable token that
 * lives embedded in its own `~/.codex/config.toml` under `mcp_servers.agent-os.http_headers` — exactly
 * where it already stores every other MCP server's bearer (U8 decision A).
 *
 * U8 kept a SECOND copy in a `codex.token` file that the security gate read. That duplication was a
 * defect *generator*: the Codex adversarial gate no-shipped five times across five passes, each on a
 * different way the two copies could diverge (mint race, next-boot-only revocation, failed-install
 * strand, empty-file provenance, install/uninstall TOCTOU). This module removes the second copy, so
 * the gate now reads the credential from the very bytes Codex sends it from — they cannot disagree.
 *
 * Two readers, one extraction, deliberately different failure policies for their two callers:
 *   - `readCodexToken` (gate, uninstall verification) is FAIL-CLOSED: absent, unreadable, corrupt,
 *     malformed, or empty ⇒ `null` ⇒ no stable credential is accepted. A config we cannot read is a
 *     config that grants nothing.
 *   - the INSTALLER instead pre-flight-parses with its own `readToml`, which THROWS on corrupt TOML —
 *     refusing to install over a broken config is the loud, correct behavior there. It then calls
 *     `extractCodexToken` on that already-parsed object to reuse an existing token (see below).
 *
 * Reuse-don't-rotate: the installer mints only when no token is embedded yet. Minting unconditionally
 * would rotate the credential on every re-install, rewrite the config, and cut off a live Codex session
 * mid-flight — and it would break install idempotency (a second run must reproduce identical bytes).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readFileSync, statSync } from "node:fs";
import { TOKEN_HEADER } from "./paths";

/** Bound the per-request credential read the same way the inventory scanners bound theirs
 *  (`src/scan/internal.ts`). Codex's config is small (KB), so this never rejects a legitimate file; it caps
 *  the OOM surface of a pathological oversized one. Same 16 MiB ceiling, deliberately, so the two read
 *  boundaries stay identically disciplined. */
const MAX_CONFIG_BYTES = 16 * 1024 * 1024; // 16 MiB, matching src/scan/internal.ts

/** The brain's MCP server name in `~/.codex/config.toml` (mirrors Claude Code's `mcpServers.agent-os`).
 *  Lives here because it is half of the credential's ADDRESS — the gate, the installer's write, and the
 *  uninstaller's targeted removal must all name the same entry or they'd silently act on different keys. */
export const CODEX_SERVER_NAME = "agent-os";

/** Path to Codex's config — the SOLE home of the stable credential. `home` is injectable so tests never
 *  touch the real `~/.codex` (the installer already threads a temp home the same way). */
export function codexConfigPath(home?: string): string {
  return join(home ?? homedir(), ".codex", "config.toml");
}

/**
 * Pull the stable credential out of an ALREADY-PARSED config object: `mcp_servers.agent-os.http_headers`
 * keyed by `TOKEN_HEADER`. Pure and total — every shape that isn't a non-empty string at that exact path
 * (missing table, wrong type, empty/whitespace value) yields `null` rather than throwing, so both callers
 * can treat "no usable credential here" as one case.
 *
 * The lookup is exact-case on `TOKEN_HEADER`: we are the only writer of this entry and we always write
 * that one constant, so a case-insensitive scan would buy nothing and widen what counts as our key.
 */
export function extractCodexToken(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return null;
  const servers = (config as Record<string, unknown>).mcp_servers;
  if (typeof servers !== "object" || servers === null) return null;
  const entry = (servers as Record<string, unknown>)[CODEX_SERVER_NAME];
  if (typeof entry !== "object" || entry === null) return null;
  const headers = (entry as Record<string, unknown>).http_headers;
  if (typeof headers !== "object" || headers === null) return null;
  const token = (headers as Record<string, unknown>)[TOKEN_HEADER];
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the stable credential from a Codex config file — FAIL-CLOSED at every step (absent, unreadable,
 * corrupt TOML, or no usable token ⇒ `null`). This is the reader the security gate consults per request
 * AND the one `uninstallCodex` uses to VERIFY revocation, deliberately: a single reader means "what the
 * gate will accept" and "what uninstall proved is gone" are the same question, answered by the same code,
 * so the two can never drift apart the way the old two-location model let them.
 */
export function readCodexToken(configPath: string): string | null {
  let raw: string;
  try {
    // Stat-before-read, mirroring scan/internal.ts's bounded-read discipline — load-bearing on the auth hot
    // path, NOT cosmetic. The security gate calls this on EVERY request, and `readFileSync` on a FIFO or
    // character-device at config.toml BLOCKS INDEFINITELY (no writer ever comes), past the catch below,
    // stalling the Bun event loop and hanging the WHOLE daemon. A non-regular or oversized target is refused
    // WITHOUT reading. Silent (no warn, unlike the scanner's debug surface): this is the per-request gate path,
    // fail-closed to `null` is the whole signal, and a per-request warn on a persistently-odd config would spam.
    const stat = statSync(configPath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    raw = readFileSync(configPath, "utf8");
  } catch {
    return null; // absent (ENOENT) / unreadable ⇒ no credential
  }
  try {
    return extractCodexToken(parseToml(raw));
  } catch {
    // Corrupt TOML ⇒ no credential. Codex itself couldn't load this file either, so there is no session to cut off.
    return null;
  }
}
