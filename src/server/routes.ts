/**
 * U3's route surface: `GET /health` (liveness, EXEMPT from the security gate — U15's launchd
 * supervisor polls it) and `GET /status` (the one gated, non-sensitive route this unit proves the
 * gate against). No brain data is served here — `GET /work-state` and its redaction pass are U4's
 * (see the U3 scope decision logged in docs/DECISIONS.md).
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Repo } from "../store/repo";

export interface RouteDeps {
  repo: Repo;
  /** The constructed `securityGate` — injected rather than built here, so this module never has to
   *  know anything about tokens or ports; it only decides WHICH route gets it. */
  gate: MiddlewareHandler;
}

/**
 * Chained (not sequential `app.get()` calls) so the returned value's inferred type carries the
 * full route schema — the shape U11's `hc<AppType>()` RPC client will need later.
 */
export function createRoutes({ repo, gate }: RouteDeps) {
  return new Hono()
    // Fail closed BY CONSTRUCTION: the gate runs on EVERY route via `use("*")`, and `/health` is the
    // ONE explicit exemption (liveness for launchd). This is order-independent — a future content route
    // (U4's /work-state) is gated automatically and CANNOT ship ungated by forgetting a per-route
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
    });
}

/** Hono RPC type export for U11's future `hc<AppType>` client. */
export type AppType = ReturnType<typeof createRoutes>;
