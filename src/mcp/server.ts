/**
 * The Brain MCP server (U4): one Streamable-HTTP endpoint, transport-per-session keyed on `mcp-session-id`.
 * Uses the SDK's Fetch-native WebStandard transport, so it mounts directly on the existing Bun+Hono app —
 * one process (KTD9), behind the U3 security gate.
 *
 * The gate (loopback + Host allowlist + per-boot token) is the SINGLE Host/DNS-rebinding authority; the
 * SDK's own host/origin protection is deprecated in favour of exactly that external middleware, so it
 * stays off here — no double-validation, no second Host allowlist to keep in sync.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerBrainTools, type McpDeps } from "./tools";

/** Build a fresh `McpServer` with the Brain tools registered — one per session (each transport owns one). */
export function createBrainMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "agent-os-brain", version: "0.1.0" });
  registerBrainTools(server, deps);
  return server;
}

/** Evict a session idle longer than this (ms). The SDK only fires `onsessionclosed` on an explicit HTTP
 *  DELETE — which `Client.close()` does NOT send (verified in the installed SDK) — so a harness that just
 *  disconnects (process exit, CLI restart, network drop) would otherwise leak its transport + `McpServer`
 *  on this weeks-long daemon forever. Deliberately GENEROUS (2h): a long working session can go a while
 *  between brain-tool calls, and reaping it mid-session would fragment its continuity across a new
 *  session id — the size cap below is the hard memory backstop, so the TTL can favour not reaping a
 *  quiet-but-active session. Tunable. */
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

/** Hard ceiling on concurrently-tracked sessions — the backstop the TTL alone can't give: a fast
 *  reconnect/crash loop mints new sessions faster than the idle sweep reaps them (none is TTL-idle yet),
 *  so at this ceiling the least-recently-seen is dropped to bound memory regardless of reconnect rate.
 *  Never reached in normal single-user use. */
const MAX_SESSIONS = 256;

/**
 * A Fetch handler for the MCP endpoint. Keyed on `mcp-session-id`: a known session reuses its transport; an
 * initialize request (no session id) spins up a fresh transport + server, and the transport assigns and
 * stores the id via `onsessioninitialized`; a request bearing an UNKNOWN session id gets a transient
 * transport that rejects it (404) per the Streamable-HTTP spec.
 *
 * A per-session `McpServer` (not one shared server) is deliberate: `connect` binds a server to exactly one
 * transport, so sharing would collapse concurrent sessions onto one stream. The security gate runs BEFORE
 * this handler (routes.ts `use("*")`), so only authenticated loopback traffic can ever reach it — an
 * unauthenticated request can't spin up transports.
 *
 * Session lifetime: `onsessionclosed` only fires on an explicit DELETE, which real clients rarely send, and
 * there is no server-side disconnect signal to hook. So each session tracks `lastSeen`: a new connection
 * first `sweepIdle`s sessions past the TTL, and each insert `enforceCap`s a hard size ceiling (drop the
 * least-recently-seen). The cap runs AT INSERTION, not pre-connect, so concurrent initializes can't bypass
 * it. The map self-bounds without a background timer; an active session touches `lastSeen` on each request,
 * and an evicted one simply re-initializes on its next call.
 */
export function createMcpHandler(deps: McpDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; lastSeen: number }>();

  // Drop a session and best-effort-close its transport. Non-blocking (never stall a new connection), but
  // LOGGED rather than swallowed — a recurring cleanup failure on the weeks-long daemon should surface in
  // the process log, not vanish (mirrors /status's "leave a server-side breadcrumb" discipline).
  const dropSession = (id: string, transport: WebStandardStreamableHTTPServerTransport): void => {
    sessions.delete(id);
    void transport.close().catch((err) => console.error("[agent-os] session cleanup failed:", err));
  };

  const sweepIdle = (): void => {
    const cutoff = now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastSeen <= cutoff) dropSession(id, s.transport); // free abandoned sessions — the common case
    }
  };

  // Enforce the hard cap by dropping the least-recently-seen until at/under it. Called AT INSERTION
  // (onsessioninitialized), which runs synchronously per new session — so a burst of concurrent initializes
  // can't bypass it. A pre-connect check could: all of them would clear it (map still under cap) before any
  // of them inserts, then each adds a session. Enforcing at the insert point is correct by construction.
  const enforceCap = (): void => {
    while (sessions.size > MAX_SESSIONS) {
      let oldestId: string | undefined;
      let oldestSeen = Infinity;
      for (const [id, s] of sessions) {
        if (s.lastSeen < oldestSeen) {
          oldestSeen = s.lastSeen;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      dropSession(oldestId, sessions.get(oldestId)!.transport);
    }
  };

  return async (req: Request): Promise<Response> => {
    const sessionId = req.headers.get("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      existing.lastSeen = now();
      return existing.transport.handleRequest(req);
    }

    sweepIdle(); // no clean disconnect signal exists (see above), so free abandoned sessions as new ones arrive

    // Annotated (not inferred) because the session callbacks below reference `transport` in its own
    // initializer; block bodies keep them returning void, not `Map.set`/`.delete`'s value.
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: now() });
        enforceCap(); // hard-bound the map AT the insert point (concurrent-init-safe — see enforceCap)
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    const server = createBrainMcpServer(deps);
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
