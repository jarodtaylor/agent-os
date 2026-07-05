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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import type { ConnInfo } from "hono/conninfo";
import { tokenPath } from "../paths";

const TOKEN_HEADER = "x-agent-os-token";

/** Socket-peer addresses this process accepts as "local". `::ffff:127.0.0.1` is the IPv4-mapped
 *  IPv6 form a dual-stack loopback connection can present as. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface SecurityGateOptions {
  /** The current boot's token — the only value the gate ever compares against. */
  token: string;
  /** The port this server is bound to, for the Host allowlist's `host:port` form. */
  port: number;
  /** Peer-address getter, injectable for tests. Defaults to Hono's real Bun socket-peer reader;
   *  swapping it is the only way to exercise a non-loopback source without a real socket. */
  getConn?: (c: Context) => ConnInfo;
}

/** The one middleware enforcing loopback + Host + per-boot token on every route it's applied to. */
export function securityGate(opts: SecurityGateOptions): MiddlewareHandler {
  const getConn = opts.getConn ?? getConnInfo;

  return async (c, next) => {
    const address = getConn(c).remote.address;
    if (!isLoopbackAddress(address)) {
      return c.json({ error: "forbidden", reason: "non-loopback source" }, 403);
    }

    if (!isAllowedHost(c.req.header("host"), opts.port)) {
      return c.json({ error: "forbidden", reason: "disallowed host" }, 403);
    }

    if (!tokenMatches(c.req.header(TOKEN_HEADER), opts.token)) {
      return c.json({ error: "forbidden", reason: "invalid or missing token" }, 403);
    }

    await next();
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address.toLowerCase());
}

/** Allows `localhost`/`127.0.0.1`/`[::1]`, bare or qualified with this server's own port. Anything
 *  else — including a public DNS name that merely resolves to 127.0.0.1, the rebind attack — is
 *  refused. IPv6 literals require the bracketed form (`[::1]`); a bare `::1` is not valid Host
 *  syntax (RFC 3986) and is deliberately not special-cased in. */
function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const allowed = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ]);
  return allowed.has(hostHeader.toLowerCase());
}

/**
 * Timing-safe compare with an explicit length guard. `crypto.timingSafeEqual` THROWS on mismatched
 * buffer lengths rather than returning false, so an unguarded call would turn a wrong-LENGTH token
 * into a 500 instead of a clean 403 — and falling back to `===` on a length mismatch would
 * reintroduce the timing side-channel this exists to close. A missing header is rejected before
 * either buffer is even built.
 */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Mint a fresh CSPRNG per-boot token. `randomUUID` is backed by the platform CSPRNG and gives a
 *  fixed-length, header-safe string for free. */
export function generateToken(): string {
  return randomUUID();
}

/**
 * Write `token` to `tokenPath(dataDir)` at mode `0600`, guaranteed — even if a stale file from a
 * prior boot exists with a looser mode. `writeFileSync(..., {mode})` only APPLIES `mode` when it
 * creates the file; on an already-existing file it leaves the current mode untouched. Removing the
 * file first forces every write down the "creates a new file" path, so the mode is never inherited.
 *
 * Self-sufficient on the directory too (`mkdirSync` with `recursive: true`, a no-op if it already
 * exists): the boot sequence in `server/index.ts` already opens the store first (which creates the
 * dataDir as a side effect), but this function doesn't lean on that ordering to be correct standalone
 * — e.g. in a test that writes a token without ever opening a store.
 */
export function writeTokenFile(dataDir: string, token: string): void {
  mkdirSync(dataDir, { recursive: true });
  const path = tokenPath(dataDir);
  rmSync(path, { force: true });
  writeFileSync(path, token, { mode: 0o600 });
}
