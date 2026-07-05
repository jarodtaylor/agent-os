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
 *  on this weeks-long daemon forever. A session idle this long is treated as abandoned. Tunable. */
const SESSION_IDLE_MS = 30 * 60 * 1000;

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
 * there is no server-side disconnect signal to hook. So each session tracks `lastSeen` and `evictIdle`
 * sweeps abandoned sessions on every NEW connection — the map self-bounds without a background timer, and
 * only genuinely idle sessions are dropped (an active session touches `lastSeen` on each request; an evicted
 * one simply re-initializes on its next call).
 */
export function createMcpHandler(deps: McpDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; lastSeen: number }>();

  const evictIdle = (): void => {
    const cutoff = now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastSeen <= cutoff) {
        sessions.delete(id);
        void s.transport.close().catch(() => {}); // best-effort stream cleanup; never block a new connection
      }
    }
  };

  return async (req: Request): Promise<Response> => {
    const sessionId = req.headers.get("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      existing.lastSeen = now();
      return existing.transport.handleRequest(req);
    }

    evictIdle(); // no clean disconnect signal exists (see above), so sweep abandoned sessions as new ones arrive

    // Annotated (not inferred) because the session callbacks below reference `transport` in its own
    // initializer; block bodies keep them returning void, not `Map.set`/`.delete`'s value.
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: now() });
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
