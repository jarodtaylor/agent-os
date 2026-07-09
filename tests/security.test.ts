import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import type { ConnInfo } from "hono/conninfo";
import { tokenPath } from "../src/paths";
import { createRoutes } from "../src/server/routes";
import { generateToken, securityGate, writeTokenFile, type SecurityGateOptions } from "../src/server/security";
import { openDb, type OpenedDb } from "../src/store/db";
import { createRepo, type Repo } from "../src/store/repo";

// Every test gets a real temp-file store (mirrors tests/store.test.ts's pattern) so `/status`'s
// `repo.hitRate()` reachability check is genuine, not faked — and so this suite stays decoupled
// from any hand-maintained stand-in for the `Repo` interface.
const PORT = 4319;
const GOOD_HOST = `localhost:${PORT}`;

let root: string;
let opened: OpenedDb;
let repo: Repo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "security-"));
  opened = openDb(join(root, "test.db"));
  repo = createRepo(opened.db);
});

afterEach(() => {
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

/** A fixed-address peer getter — the injectable seam `securityGate` exposes specifically so tests
 *  never need a real socket (Hono's in-memory `app.request()` has none; the real `getConnInfo`
 *  throws if asked in that context). */
function fakeConn(address: string | undefined): (c: Context) => ConnInfo {
  return () => ({ remote: { address } });
}

/** Builds the real `createRoutes` composition (not a reinvented test-only shape) with a gate whose
 *  peer defaults to loopback — the one thing every test except scenario 1 wants to hold constant. */
function buildApp(overrides: Partial<SecurityGateOptions> = {}) {
  const token = overrides.token ?? generateToken();
  const gate = securityGate({
    token,
    extraTokens: overrides.extraTokens,
    port: overrides.port ?? PORT,
    getConn: overrides.getConn ?? fakeConn("127.0.0.1"),
  });
  return { app: createRoutes({ repo, gate, machineId: "test-machine" }), token };
}

// ── Scenario 1: non-loopback source rejected ──────────────────────────────────

describe("scenario 1 — non-loopback source rejected", () => {
  test("a non-loopback socket peer gets 403 even with a correct host + token", async () => {
    const { app, token } = buildApp({ getConn: fakeConn("8.8.8.8") });
    const res = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": token } });
    expect(res.status).toBe(403);
  });
});

// ── Scenario 2: bad Host header rejected ──────────────────────────────────────

describe("scenario 2 — bad Host header rejected", () => {
  test("a Host outside the allowlist gets 403 even from a loopback peer with the right token", async () => {
    const { app, token } = buildApp();
    const res = await app.request("/status", { headers: { host: "evil.example.com", "x-agent-os-token": token } });
    expect(res.status).toBe(403);
  });
});

describe("Host-header allowlist — exact accepted/rejected forms", () => {
  test.each(["localhost", `localhost:${PORT}`, "127.0.0.1", `127.0.0.1:${PORT}`, "[::1]", `[::1]:${PORT}`])(
    "accepts %s",
    async (host) => {
      const { app, token } = buildApp();
      const res = await app.request("/status", { headers: { host, "x-agent-os-token": token } });
      expect(res.status).toBe(200);
    },
  );

  test.each([
    "evil.example.com",
    "127.0.0.1.evil.com", // starts with the loopback literal but is a different hostname
    "localhost:9999", // right hostname, WRONG port
    "::1", // missing the required brackets (RFC 3986 Host syntax)
    "",
  ])("rejects %s", async (host) => {
    const { app, token } = buildApp();
    const res = await app.request("/status", { headers: { host, "x-agent-os-token": token } });
    expect(res.status).toBe(403);
  });
});

// ── Scenario 3: missing/wrong token rejected on /status; /health stays exempt ─

describe("scenario 3 — token gate on /status; /health stays exempt", () => {
  test("missing token on /status is rejected", async () => {
    const { app } = buildApp();
    const res = await app.request("/status", { headers: { host: GOOD_HOST } });
    expect(res.status).toBe(403);
  });

  test("wrong token on /status is rejected", async () => {
    const { app } = buildApp();
    const res = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": "not-the-token" } });
    expect(res.status).toBe(403);
  });

  test("the right token on /status is accepted and reports store reachability", async () => {
    const { app, token } = buildApp();
    const res = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": token } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; store: string };
    expect(body.ok).toBe(true);
    expect(body.store).toBe("reachable");
  });

  test("/health is exempt — 200 with no token and no host at all", async () => {
    const { app } = buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("/health is exempt even behind a hostile Host header — the gate is never applied to it", async () => {
    const { app } = buildApp();
    const res = await app.request("/health", { headers: { host: "evil.example.com" } });
    expect(res.status).toBe(200);
  });
});

// ── Fail-closed routing: the gate is default-on, not per-route (Codex adversarial-review finding) ──

describe("fail-closed routing — every non-/health path is gated by construction", () => {
  test("the sensitive /work-state route is gated: no token -> 403", async () => {
    // The gate runs via use("*"), not a per-route middleware, so U4's sensitive /work-state is gated by
    // construction — it can't ship ungated by forgetting a per-route middleware. No token -> 403 before
    // the route runs.
    const { app } = buildApp();
    const res = await app.request("/work-state", { headers: { host: GOOD_HOST } });
    expect(res.status).toBe(403);
  });

  test("an unregistered path clears the gate with a valid token and 404s (proves the gate ran, not the 404)", async () => {
    const { app, token } = buildApp();
    const res = await app.request("/no-such-route", { headers: { host: GOOD_HOST, "x-agent-os-token": token } });
    expect(res.status).toBe(404); // gate cleared; there is simply no such route
  });
});

// ── Scenario 4: a prior-boot token is rejected; the CURRENT token succeeds ───

describe("scenario 4 — per-boot token regeneration", () => {
  test("writeTokenFile overwrites a prior-boot token; the file always holds the CURRENT value", () => {
    const dataDir = join(root, "data-scenario-4");
    const priorToken = generateToken();
    writeTokenFile(dataDir, priorToken);

    const currentToken = generateToken();
    writeTokenFile(dataDir, currentToken);
    expect(currentToken).not.toBe(priorToken);
    expect(readFileSync(tokenPath(dataDir), "utf8")).toBe(currentToken);
  });

  test("a request bearing the prior-boot token is rejected while the current token is accepted", async () => {
    const priorToken = generateToken();
    const currentToken = generateToken();
    const { app } = buildApp({ token: currentToken });

    const withPrior = await app.request("/status", {
      headers: { host: GOOD_HOST, "x-agent-os-token": priorToken },
    });
    expect(withPrior.status).toBe(403);

    const withCurrent = await app.request("/status", {
      headers: { host: GOOD_HOST, "x-agent-os-token": currentToken },
    });
    expect(withCurrent.status).toBe(200);
  });
});

// ── Scenario 6: token file mode is 0600 ───────────────────────────────────────

// Scenario 5 ("/work-state matches the read_work_state MCP tool") is intentionally absent here: the
// sensitive route + the KTD2 redaction pass were deferred from U3 to U4 (decision #17), so it becomes a
// U4 cross-check. That is why the numbering runs 4 -> 6.
describe("scenario 6 — token file mode is 0600", () => {
  test("a freshly written token file is mode 0600", () => {
    const dataDir = join(root, "data-mode");
    writeTokenFile(dataDir, generateToken());
    expect(statSync(tokenPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  test("a stale file with a looser mode is forced back to 0600 on the next write, not inherited", () => {
    const dataDir = join(root, "data-mode-stale");
    mkdirSync(dataDir, { recursive: true });
    const path = tokenPath(dataDir);
    writeFileSync(path, "stale-token", { mode: 0o644 }); // simulate a loosely-permissioned leftover
    expect(statSync(path).mode & 0o777).toBe(0o644);

    writeTokenFile(dataDir, generateToken());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

// ── Timing-safe token compare ──────────────────────────────────────────────────

describe("timing-safe token compare", () => {
  test("the right token is accepted", async () => {
    const { app, token } = buildApp();
    const res = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": token } });
    expect(res.status).toBe(200);
  });

  test("an equal-length wrong token is rejected", async () => {
    const token = "a".repeat(36);
    const wrong = "b".repeat(36);
    const { app } = buildApp({ token });
    const res = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": wrong } });
    expect(res.status).toBe(403);
  });

  test("a length-mismatched token does not throw — it produces a clean 403, not a 500", async () => {
    const { app, token } = buildApp();
    expect(token.length).not.toBe(3); // sanity: genuinely a different length than "abc"
    const res = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": "abc" } });
    expect(res.status).toBe(403); // an unguarded timingSafeEqual would RangeError -> Hono 500
  });
});

// ── Dual-token accept: the stable Codex credential alongside the per-boot token (U8 decision A) ──

describe("dual-token accept — Codex stable credential (U8)", () => {
  test("BOTH the per-boot token and a registered stable token are accepted", async () => {
    const token = generateToken();
    const codexToken = generateToken();
    const { app } = buildApp({ token, extraTokens: [codexToken] });

    const withBoot = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": token } });
    expect(withBoot.status).toBe(200);

    const withCodex = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": codexToken } });
    expect(withCodex.status).toBe(200);
  });

  test("a token matching NEITHER the per-boot nor the stable token is still rejected", async () => {
    const { app } = buildApp({ token: generateToken(), extraTokens: [generateToken()] });
    const res = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": generateToken() } });
    expect(res.status).toBe(403);
  });

  test("an empty-string stable token does not create a zero-length buffer a missing header can match", async () => {
    // extraTokens:[""] is filtered out at construction, so a request with NO token header stays 403 — the
    // missing-header path must never coincidentally match a degenerate empty accepted credential.
    const { app } = buildApp({ token: generateToken(), extraTokens: [""] });
    const res = await app.request("/status", { headers: { host: GOOD_HOST } });
    expect(res.status).toBe(403);
  });
});

// ── IPv4-mapped loopback ────────────────────────────────────────────────────────

describe("IPv4-mapped loopback", () => {
  test("::ffff:127.0.0.1 is accepted as a loopback source", async () => {
    const { app, token } = buildApp({ getConn: fakeConn("::ffff:127.0.0.1") });
    const res = await app.request("/status", { headers: { host: GOOD_HOST, "x-agent-os-token": token } });
    expect(res.status).toBe(200);
  });
});

// ── Scenario 7: dev = prod — the server boots from source, no dev-server dependency ──

describe("scenario 7 — dev=prod: bun run src/server/index.ts", () => {
  test(
    "the spawned server serves /health and gates /status, with no bundle/dev-server involved",
    async () => {
      const port = await getFreePort();
      // Point the boot at a dir that does NOT exist yet, so the server itself must create it — that's
      // what makes the 0700 assertion below meaningful (mkdtemp would pre-create it at 0700 and mask it).
      const dataRoot = mkdtempSync(join(tmpdir(), "server-boot-"));
      const dataDir = join(dataRoot, "agent-os");
      const indexPath = join(import.meta.dir, "..", "src", "server", "index.ts");

      const proc = Bun.spawn({
        cmd: [process.execPath, "run", indexPath],
        env: { ...process.env, AGENT_OS_PORT: String(port), AGENT_OS_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        try {
          await waitForHealth(port);
        } catch (err) {
          // Surface the spawned server's stderr on a boot/health failure so CI shows WHY, not just an
          // opaque timeout. Kill first so reading the stderr stream doesn't block on a still-live process.
          proc.kill();
          console.error("[boot test] server stderr:", await new Response(proc.stderr).text());
          throw err;
        }

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ ok: true });

        const status = await fetch(`http://127.0.0.1:${port}/status`); // no token
        expect(status.status).toBe(403);

        // A gated request WITH the current token, over the REAL loopback socket — exercises the real
        // getConnInfo socket-peer path (127.0.0.1 passes the loopback check) that the in-memory
        // app.request() tests can't reach, and confirms the loopback bind actually serves gated traffic.
        const token = readFileSync(tokenPath(dataDir), "utf8");
        const authed = await fetch(`http://127.0.0.1:${port}/status`, { headers: { "x-agent-os-token": token } });
        expect(authed.status).toBe(200);
        expect(await authed.json()).toMatchObject({ ok: true, store: "reachable" });

        // The data dir the boot created holds the brain + token — it must be owner-only (0700).
        expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      } finally {
        proc.kill();
        await proc.exited;
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

// ── Single-instance boot: a second daemon on the same data dir refuses to start ──

describe("single-instance boot — one daemon per data dir, across different ports", () => {
  test(
    "a second boot (same dataDir, DIFFERENT port) exits non-zero and never clobbers the first token",
    async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "single-boot-"));
      const dataDir = join(dataRoot, "agent-os");
      const indexPath = join(import.meta.dir, "..", "src", "server", "index.ts");

      const portA = await getFreePort();
      const procA = Bun.spawn({
        cmd: [process.execPath, "run", indexPath],
        env: { ...process.env, AGENT_OS_PORT: String(portA), AGENT_OS_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        await waitForHealth(portA);
        const tokenA = readFileSync(tokenPath(dataDir), "utf8");

        // Second instance: SAME dataDir, DIFFERENT port. Bind-before-write can't catch this (no
        // EADDRINUSE) — the single-instance lock must. It should refuse and exit non-zero.
        const portB = await getFreePort();
        const procB = Bun.spawn({
          cmd: [process.execPath, "run", indexPath],
          env: { ...process.env, AGENT_OS_PORT: String(portB), AGENT_OS_DATA_DIR: dataDir },
          stdout: "pipe",
          stderr: "pipe",
        });
        const exitB = await procB.exited;
        expect(exitB).not.toBe(0); // couldn't acquire the single-instance lock

        // The live instance's token is untouched — B never published over it.
        expect(readFileSync(tokenPath(dataDir), "utf8")).toBe(tokenA);
      } finally {
        procA.kill();
        await procA.exited;
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

/** Ask the OS for a free port by briefly binding to port 0, then release it for the real spawn. */
async function getFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop();
  if (port === undefined) throw new Error("could not determine a free port for the dev=prod boot test");
  return port;
}

/** Poll `/health` until it answers (or throw past `timeoutMs`) — the spawned process needs a beat
 *  to open the store, mint the token, and start listening before it can serve anything. */
async function waitForHealth(port: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`);
}
