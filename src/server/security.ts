/**
 * securityGate — the one middleware standing between the network and every non-exempt route
 * (KTD6). Three checks, in order, each a fail-closed 403 with a clear (but token-silent) reason:
 *
 *   1. Loopback source, socket-peer ONLY. `X-Forwarded-For`/`X-Real-IP` are never consulted —
 *      they're ordinary request headers, so any caller can set them to whatever they like. The
 *      only trustworthy source is the raw socket Bun accepted the connection on. The peer getter
 *      is an INJECTABLE param (default: `getConnInfo` from `hono/bun`) so tests can supply a
 *      non-loopback address without a real socket — Hono's in-memory `app.request()` test helper
 *      has no real Bun server behind it, so the real `getConnInfo` throws in that context anyway.
 *   2. Host-header allowlist — an anti-DNS-rebinding check: a page open in the browser on a public
 *      site could script a `fetch("http://127.0.0.1:<port>/...")` and ride the loopback check for
 *      free (the browser really does connect loopback-to-loopback). Restricting Host to this
 *      server's own advertised names closes that gap.
 *   3. Per-boot token — `X-Agent-OS-Token` compared to the in-memory boot token with a
 *      timing-safe, length-safe compare.
 *
 * No CORS is configured anywhere in this server (no `Access-Control-Allow-Origin`, ever): the
 * token — never embedded in a browser-reachable page — is the actual backstop against a same-origin
 * browser script, not a reflected Origin header.
 *
 * The token is generated fresh on every server start (`generateToken`) and is the ONLY thing
 * `securityGate` trusts. `writeTokenFile` puts a copy on disk purely so a same-machine CLI caller
 * can read the CURRENT token; a prior boot's token is never honored (scenario 4).
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import type { ConnInfo } from "hono/conninfo";
import { TOKEN_HEADER, ensureDataDir, tokenPath } from "../paths";

/** Socket-peer addresses this process accepts as "local". `::ffff:127.0.0.1` is the IPv4-mapped
 *  IPv6 form a dual-stack loopback connection can present as. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface SecurityGateOptions {
  /** The current boot's token — always accepted (the primary credential). */
  token: string;
  /** Path to a STABLE credential file (Codex's `codex.token` — U8 decision A) the gate ALSO accepts, read
   *  FRESH per request (mtime-cached), NOT snapshotted. A harness whose MCP client can only send a static
   *  header (Codex) can't ride the per-boot token, so it authenticates with this stable token. Reading it live
   *  is what makes revocation LIVE: a deleted/rotated `codex.token` takes effect on the NEXT request, no
   *  restart — and a fresh install is likewise picked up live. Omitted ⇒ per-boot token only. */
  stableTokenPath?: string;
  /** The port this server is bound to, for the Host allowlist's `host:port` form. */
  port: number;
  /** Peer-address getter, injectable for tests. Defaults to Hono's real Bun socket-peer reader;
   *  swapping it is the only way to exercise a non-loopback source without a real socket. */
  getConn?: (c: Context) => ConnInfo;
}

/** The one middleware enforcing loopback + Host + per-boot token on every route it's applied to. */
export function securityGate(opts: SecurityGateOptions): MiddlewareHandler {
  const getConn = opts.getConn ?? getConnInfo;
  // Both depend only on construction-time opts, so build them ONCE per gate instance instead of
  // reallocating a Set and re-encoding the token buffer on every request (mirrors the module-scope
  // LOOPBACK_ADDRESSES). Precomputing the expected buffer does not weaken timing-safety — that is a
  // property of the compare, not of how the buffer was built.
  const allowedHosts = buildAllowedHosts(opts.port);
  // The per-boot token is constant for the process, so encode it ONCE (empty-string-guarded so a stray "" can't
  // become a zero-length buffer a missing header would match). The stable Codex token, by contrast, is read
  // from its file per request (mtime-cached) so its lifecycle is observed LIVE — see makeStableTokenReader.
  const perBootBuf = opts.token.length > 0 ? Buffer.from(opts.token, "utf8") : null;
  const readStableToken = makeStableTokenReader(opts.stableTokenPath);

  return async (c, next) => {
    const address = getConn(c).remote.address;
    if (!isLoopbackAddress(address)) return forbidden(c, "non-loopback source");
    if (!allowedHosts.has((c.req.header("host") ?? "").toLowerCase())) return forbidden(c, "disallowed host");
    // Assemble the accepted set per request: the constant per-boot token + the CURRENT stable token (null when
    // codex.token is absent/empty — i.e. revoked). Timing-safety is a property of the compare, not the build.
    const accepted: Buffer[] = [];
    if (perBootBuf) accepted.push(perBootBuf);
    const stableBuf = readStableToken();
    if (stableBuf) accepted.push(stableBuf);
    if (!tokenMatchesAny(c.req.header(TOKEN_HEADER), accepted)) return forbidden(c, "invalid or missing token");
    await next();
  };
}

/**
 * A reader for the stable credential file that re-reads ONLY when the file's mtime changes — so the common
 * case (an unchanged token) costs a single `stat`, not a full read+decode, on every request, while a rotate or
 * delete is observed on the NEXT request (LIVE revocation). Absent / unreadable / empty ⇒ `null` (no stable
 * token accepted): that is exactly how uninstall's `rm codex.token` revokes Codex access with no restart, and
 * how a fresh install is picked up live (the file appears → its mtime differs from the NaN seed → it's read).
 * The atomic temp+rename the writers use changes `mtimeMs`, so a rewrite is never missed. An undefined `path`
 * (a per-boot-only gate) short-circuits to a constant `null` with no per-request syscall.
 */
function makeStableTokenReader(path: string | undefined): () => Buffer | null {
  if (path === undefined) return () => null;
  let cachedMtimeMs = Number.NaN; // NaN !== anything → the first call always reads
  let cachedBuf: Buffer | null = null;
  return () => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // Absent/unreadable → revoked. Reset the cache so a later re-create is re-read (its mtime !== NaN).
      cachedMtimeMs = Number.NaN;
      cachedBuf = null;
      return null;
    }
    if (mtimeMs !== cachedMtimeMs) {
      cachedMtimeMs = mtimeMs;
      try {
        const raw = readFileSync(path, "utf8").trim();
        cachedBuf = raw.length > 0 ? Buffer.from(raw, "utf8") : null;
      } catch {
        cachedBuf = null;
      }
    }
    return cachedBuf;
  };
}

/** One fail-closed 403 shape for every gate rejection, so a future check can't emit a differently
 *  shaped body. `reason` is safe to return — it never contains the expected token. */
function forbidden(c: Context, reason: string) {
  return c.json({ error: "forbidden", reason }, 403);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address.toLowerCase());
}

/** The Host values this server answers to: `localhost`/`127.0.0.1`/`[::1]`, bare or qualified with
 *  this server's own port. Anything else — including a public DNS name that merely resolves to
 *  127.0.0.1, the rebind attack — is refused by the gate's `.has()` lookup. IPv6 literals require the
 *  bracketed form (`[::1]`); a bare `::1` is not valid Host syntax (RFC 3986) and is deliberately not
 *  special-cased in. Built once per gate instance (it depends only on the bound port). */
function buildAllowedHosts(port: number): Set<string> {
  const names = ["localhost", "127.0.0.1", "[::1]"];
  return new Set([...names, ...names.map((n) => `${n}:${port}`)]);
}

/**
 * Timing-safe compare against EVERY accepted token, with an explicit length guard. `crypto.timingSafeEqual`
 * THROWS on mismatched buffer lengths rather than returning false, so each candidate is length-checked first
 * (a length mismatch is not the secret — every token is a fixed-length UUID); an unguarded call would turn a
 * wrong-LENGTH token into a 500 instead of a clean 403, and a `===` fallback would reintroduce the timing
 * side-channel this exists to close. We test ALL buffers WITHOUT early-out on a match, so the work never
 * depends on WHICH token matched or its position. A missing header is rejected before any buffer is built;
 * `expectedBufs` is precomputed once at gate construction.
 */
function tokenMatchesAny(provided: string | undefined, expectedBufs: Buffer[]): boolean {
  if (provided === undefined) return false;
  const providedBuf = Buffer.from(provided, "utf8");
  let matched = false;
  for (const buf of expectedBufs) {
    if (providedBuf.length === buf.length && timingSafeEqual(providedBuf, buf)) matched = true;
  }
  return matched;
}

/** Mint a fresh CSPRNG per-boot token. `randomUUID` is backed by the platform CSPRNG and gives a
 *  fixed-length, header-safe string for free. */
export function generateToken(): string {
  return randomUUID();
}

/**
 * Publish `token` to `tokenPath(dataDir)` at mode `0600`, atomically (temp-write + rename — see the
 * body for why that beats a direct overwrite on both the partial-read and the mode-inheritance fronts).
 * Self-sufficient on the directory too (`mkdirSync` recursive + `chmodSync` to 0700, which tightens a
 * reused dir), so it stays correct standalone — e.g. a test that writes a token without ever opening a
 * store — without leaning on the boot ordering in `server/index.ts`.
 */
export function writeTokenFile(dataDir: string, token: string): void {
  ensureDataDir(dataDir); // owner-only 0700 (create + tighten a reused dir) — see ../paths
  const path = tokenPath(dataDir);
  // Atomic publish: write a fresh 0600 temp file, then rename it over the target. `rename` is atomic,
  // so a concurrent reader never observes a partial or empty token, and the result adopts the temp's
  // inode + 0600 mode regardless of any prior file's mode (this subsumes the old rm-first fix for
  // writeFileSync's mode only applying on create).
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, token, { mode: 0o600 });
  renameSync(tmp, path);
}
