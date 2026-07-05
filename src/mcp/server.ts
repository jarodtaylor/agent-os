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
 */
export function createMcpHandler(deps: McpDeps): (req: Request) => Promise<Response> {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  return async (req: Request): Promise<Response> => {
    const sessionId = req.headers.get("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) return existing.handleRequest(req);

    // Annotated (not inferred) because the session callbacks below reference `transport` in its own
    // initializer; block bodies keep them returning void, not `Map.set`/`.delete`'s value.
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
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
