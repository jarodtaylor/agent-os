/**
 * The route surface. `GET /health` (liveness, EXEMPT from the security gate — U15's launchd supervisor
 * polls it) and `GET /status` (a gated, non-sensitive probe). U4 adds the brain surface, both gated by
 * construction (below): `GET /work-state?project=` and the `/mcp` Streamable-HTTP endpoint. `/work-state`
 * and the MCP `read_work_state` tool share ONE response path (`readWorkStateResponse`), so their payloads
 * are identical by construction; redaction happens inside that path (KTD2 choke-point).
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import * as z from "zod";
import { Breadcrumb } from "../contract/index";
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

/** Upper bound for the `GET /work-state` `?limit=` param — the accept regex allows arbitrarily long digit
 *  strings, so clamp the parsed value here to keep the raw-trail read bounded regardless of the caller. */
const MAX_WORK_STATE_LIMIT = 1000;

/** Body of `POST /session-end` — ONLY the identity the server can't infer. Every content field
 *  (machineId, ts, kind, source, summary, sensitivity, id) is server-stamped, so no untrusted free text
 *  reaches the store and no capture-time secret classification is needed on this path. */
const SessionEndRequest = z.object({
  project: z.string().min(1),
  sessionId: z.string().min(1),
});

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
      // Optional ?limit= caps the raw trail — WorkStateReadOptions.limit is already plumbed through
      // readWorkStateResponse (U2-R6); this just exposes it. A missing/invalid value keeps the server
      // default, so existing callers are unaffected; the U6 SessionStart hook passes a small bound so it
      // fetches ~what it displays rather than the full default cap.
      const limitParam = c.req.query("limit");
      const parsedLimit = limitParam !== undefined && /^[1-9]\d*$/.test(limitParam) ? Number(limitParam) : undefined;
      // Clamp the upper bound: the regex accepts arbitrarily long digit strings (→ a huge int, or Infinity via
      // Number()), which would bypass the raw-trail memory cap or trip the DB LIMIT. This is a gated route, so
      // the clamp guards against a self-inflicted spike, not an attacker.
      const limit = parsedLimit !== undefined ? Math.min(parsedLimit, MAX_WORK_STATE_LIMIT) : undefined;
      try {
        const resp = await readWorkStateResponse(
          repo,
          project,
          {
            harness: c.req.header("x-agent-os-harness") ?? "http",
            tool: "GET /work-state",
            sessionId: c.req.header("x-agent-os-session") || undefined,
          },
          { limit, now: now?.() },
        );
        return c.json(resp);
      } catch (err) {
        // Fail closed with a JSON body (not Hono's bare-text default 500) so the U6 hook's res.json() still
        // parses on the failure path, and leave a labeled server-side breadcrumb — mirrors /status.
        console.error("[agent-os] /work-state failed:", err);
        return c.json({ error: "internal error" }, 500);
      }
    })
    // The Claude Code SessionEnd graceful-end MARKER (U6). NOT load-bearing — U5's tailer owns real
    // capture; this records only "this session ended cleanly", the one signal a crash can't leave behind.
    // KTD9: the server is the single SQLite writer, so the hook must NOT open the DB — it POSTs here. The
    // request carries ONLY identity (project + sessionId); every content field is server-stamped, so the
    // marker can carry no injected or secret text and needs no capture-time classification.
    .post("/session-end", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const parsed = SessionEndRequest.safeParse(body);
      if (!parsed.success) return c.json({ error: "project and sessionId are required" }, 400);
      const { project, sessionId } = parsed.data;
      // Assemble the full record server-side, then validate at the write boundary via the contract (U2-R1)
      // — the store never sees an unvalidated external write. `id` is stable, so a re-POST is an idempotent
      // no-op (writeBreadcrumb is ON CONFLICT DO NOTHING on id). `sensitivity: "path"` is the least-
      // restrictive level for a content-free structural marker; `summary`'s schema floor (`personal`) still
      // governs redaction, so this value is honest, not load-bearing.
      const marker = {
        id: `${sessionId}:session-end`,
        project,
        sessionId,
        machineId,
        source: "claude-code",
        kind: "session-end",
        summary: "Session ended (graceful).",
        ts: now?.() ?? Date.now(),
        sensitivity: "path",
      };
      try {
        await repo.writeBreadcrumb(Breadcrumb.parse(marker));
        return c.json({ ok: true });
      } catch (err) {
        console.error("[agent-os] /session-end write failed:", err);
        return c.json({ error: "internal error" }, 500);
      }
    })
    // The Streamable-HTTP MCP endpoint. `c.req.raw` is the untouched Web Request (the gate reads only
    // headers, never the body), which the Fetch-native transport consumes and answers with a Response.
    .all("/mcp", (c) => mcp(c.req.raw));
}

/** Hono RPC type export for U11's future `hc<AppType>` client. */
export type AppType = ReturnType<typeof createRoutes>;
