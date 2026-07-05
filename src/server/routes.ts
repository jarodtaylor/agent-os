/**
 * The route surface. `GET /health` (liveness, EXEMPT from the security gate — U15's launchd supervisor
 * polls it) and `GET /status` (a gated, non-sensitive probe). U4 adds the brain surface, both gated by
 * construction (below): `GET /work-state?project=` and the `/mcp` Streamable-HTTP endpoint. `/work-state`
 * and the MCP `read_work_state` tool share ONE response path (`readWorkStateResponse`), so their payloads
 * are identical by construction; redaction happens inside that path (KTD2 choke-point).
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createMcpHandler } from "../mcp/server";
import type { Repo } from "../store/repo";
import { readWorkStateResponse } from "../workstate/response";

export interface RouteDeps {
  repo: Repo;
  /** The constructed `securityGate` — injected rather than built here, so this module never has to
   *  know anything about tokens or ports; it only decides WHICH route gets it. */
  gate: MiddlewareHandler;
  /** This machine's federation id, stamped onto records the MCP write path persists (v1: os.hostname()). */
  machineId: string;
  /** Injectable clock forwarded to the MCP tools + read path (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Chained (not sequential `app.get()` calls) so the returned value's inferred type carries the
 * full route schema — the shape U11's `hc<AppType>()` RPC client will need later.
 */
export function createRoutes({ repo, gate, machineId, now }: RouteDeps) {
  // One MCP handler for the process lifetime — it owns the transport-per-session map, so it must NOT be
  // rebuilt per request.
  const mcp = createMcpHandler({ repo, machineId, now });
  return new Hono()
    // Fail closed BY CONSTRUCTION: the gate runs on EVERY route via `use("*")`, and `/health` is the
    // ONE explicit exemption (liveness for launchd). This is order-independent — the content routes
    // below (/work-state, /mcp) are gated automatically and CANNOT ship ungated by forgetting a per-route
    // middleware, which is the whole point of a security spine. An unknown path is gated too: the gate
    // 403s a missing token before routing can 404 it.
    .use("*", (c, next) => (c.req.path === "/health" ? next() : gate(c, next)))
    .get("/health", (c) => c.json({ ok: true }))
    .get("/status", async (c) => {
      try {
        // A cheap, real read — proves the store is actually reachable rather than hardcoding a
        // reply. No brain data comes back to the caller either way (non-sensitive by design).
        await repo.hitRate();
        return c.json({ ok: true, store: "reachable", ts: Date.now() });
      } catch (err) {
        // Fail closed (503, never a false ok:true) AND leave a server-side breadcrumb — a persistently
        // unreachable store should surface in the process log, not vanish into a silent catch.
        console.error("[agent-os] /status store probe failed:", err);
        return c.json({ ok: false, store: "unreachable", ts: Date.now() }, 503);
      }
    })
    // The brain read surface for hook consumption (U6). Shares `readWorkStateResponse` with the MCP
    // `read_work_state` tool, so `GET /work-state` and the tool return byte-identical payloads (redaction
    // included). `null` (no resume state) serializes as `null` — the same body the tool returns.
    .get("/work-state", async (c) => {
      const project = c.req.query("project");
      if (!project) return c.json({ error: "project query param required" }, 400);
      const resp = await readWorkStateResponse(repo, project, {
        harness: c.req.header("x-agent-os-harness") ?? "http",
        tool: "GET /work-state",
        sessionId: c.req.header("x-agent-os-session") ?? undefined,
      });
      return c.json(resp);
    })
    // The Streamable-HTTP MCP endpoint. `c.req.raw` is the untouched Web Request (the gate reads only
    // headers, never the body), which the Fetch-native transport consumes and answers with a Response.
    .all("/mcp", (c) => mcp(c.req.raw));
}

/** Hono RPC type export for U11's future `hc<AppType>` client. */
export type AppType = ReturnType<typeof createRoutes>;
