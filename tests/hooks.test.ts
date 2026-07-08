import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Breadcrumb } from "../src/contract/index";
import { TOKEN_HEADER } from "../src/paths";
import { createRoutes } from "../src/server/routes";
import { generateToken, securityGate, writeTokenFile } from "../src/server/security";
import { openDb } from "../src/store/db";
import { createRepo, type Repo } from "../src/store/repo";
import type { WorkStateResponse } from "../src/workstate/response";
import { formatAdditionalContext } from "../hooks/session-start";
import { fetchWithTimeout } from "../hooks/shared";

const NOW = 1_700_000_000_000;
const REPO = join(import.meta.dir, ".."); // tests/ → repo root
const TEST_PORT = 43217; // an uncommon loopback port for the real-server subprocess tests
const PROJECT = "/tmp/agent-os-hooks-test-project";

const crumb = (summary: string, i: number): Breadcrumb => ({
  id: `c${i}`,
  project: PROJECT,
  sessionId: "s",
  machineId: "m",
  source: "claude-code",
  kind: "note",
  summary,
  ts: NOW,
  sensitivity: "personal",
});

// ── formatAdditionalContext — the pure, tunable payload shaper ──────────────────────────────────────────

describe("formatAdditionalContext", () => {
  test("returns null when there is no work-state (nothing to inject)", () => {
    expect(formatAdditionalContext(null, NOW)).toBeNull();
  });

  test("curated: leads with freshness/lane + the clean cursor (next / last-decided), never in-flight", () => {
    const resp: WorkStateResponse = {
      project: PROJECT,
      lane: "curated",
      freshness: "fresh",
      last_activity: NOW - 3 * 3600_000,
      handoff: {
        project: PROJECT,
        sessionId: "s",
        machineId: "m",
        source: "claude-code",
        cursor: { inFlight: "REDACTED_BUFFER", lastDecided: "chose the flock lock", next: "open the U6 PR" },
        ts: NOW - 3 * 3600_000,
      },
      raw_trail_tail: [],
    };
    const out = formatAdditionalContext(resp, NOW)!;
    expect(out).toContain("fresh state (curated lane)");
    expect(out).toContain("3h ago");
    expect(out).toContain("Next: open the U6 PR");
    expect(out).toContain("Last decided: chose the flock lock");
    // The in-flight buffer is deliberately never surfaced (it is the secret-marked field).
    expect(out).not.toContain("REDACTED_BUFFER");
  });

  test("curated with newer crumbs: counts them rather than dumping (AE2)", () => {
    const resp: WorkStateResponse = {
      project: PROJECT,
      lane: "curated",
      freshness: "stale",
      last_activity: NOW,
      handoff: {
        project: PROJECT,
        sessionId: "s",
        machineId: "m",
        source: "claude-code",
        cursor: { inFlight: "x", lastDecided: "y", next: "z" },
        ts: NOW - 60_000,
      },
      raw_trail_tail: [crumb("did A", 1), crumb("did B", 2)],
    };
    expect(formatAdditionalContext(resp, NOW)!).toContain("+2 newer breadcrumbs since the handoff");
  });

  test("raw lane: previews the most-recent few summaries + a pointer, and caps the rest (AE1)", () => {
    const tail = Array.from({ length: 8 }, (_, i) => crumb(`step ${i}`, i));
    const resp: WorkStateResponse = {
      project: PROJECT,
      lane: "raw",
      freshness: "uncurated",
      last_activity: NOW - 90_000,
      handoff: null,
      raw_trail_tail: tail,
    };
    const out = formatAdditionalContext(resp, NOW)!;
    expect(out).toContain("uncurated state (raw lane)");
    expect(out).toContain("1m ago");
    expect(out).toContain("No curated handoff");
    expect(out).toContain("call read_work_state");
    expect(out).toContain("• step 7"); // newest previewed
    expect(out).toContain("• step 2"); // 6-item window → steps 2..7
    expect(out).not.toContain("• step 1"); // outside the window
    expect(out).toContain("and 2 earlier");
  });

  test("raw lane: excludes structural session-end/session-start markers from the preview + counts", () => {
    const resp: WorkStateResponse = {
      project: PROJECT,
      lane: "raw",
      freshness: "uncurated",
      last_activity: NOW,
      handoff: null,
      raw_trail_tail: [crumb("did A", 1), { ...crumb("Session ended (graceful).", 2), kind: "session-end" }, crumb("did B", 3)],
    };
    const out = formatAdditionalContext(resp, NOW)!;
    // The session-end marker is bookkeeping, not resume activity — it must never crowd the scarce preview.
    expect(out).not.toContain("Session ended (graceful).");
    expect(out).toContain("• did A");
    expect(out).toContain("• did B");
  });

  test("defensive: a malformed handoff/cursor or non-string crumb summary never throws or injects garbage", () => {
    // The wire payload is untrusted (the fetch cast is not a runtime check). A handoff that's present but
    // has no cursor, and a crumb whose summary isn't a string, must not throw and must not inject junk.
    const malformed = {
      project: PROJECT,
      lane: "raw",
      freshness: "uncurated",
      last_activity: NOW,
      handoff: {}, // present but NO cursor — the exact wrong-shape flagged in review
      raw_trail_tail: [crumb("real summary", 1), { kind: "note", summary: 42 }, { kind: "session-end", summary: "marker" }],
    } as unknown as WorkStateResponse;
    const out = formatAdditionalContext(malformed, NOW)!; // must not throw
    expect(out).not.toContain("Next:"); // malformed handoff (no cursor) → no cursor line, no throw
    expect(out).toContain("• real summary"); // the valid crumb is still previewed
    expect(out).not.toContain("42"); // a non-string summary is skipped, not stringified into the context
    expect(out).not.toContain("undefined"); // no undefined field injected
    expect(out).not.toContain("marker"); // session-end marker still filtered
  });
});

// ── Hook scripts as subprocesses — the real "bun run <hook>" path CC will invoke ─────────────────────────

async function runHook(script: string, payload: unknown, env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", join(REPO, "hooks", script)], {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

/** Stand up a real loopback server (token on disk in a temp dataDir) and run `body` against it. */
async function withServer(seed: (repo: Repo) => Promise<void>, body: (dataDir: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "hooks-server-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const token = generateToken();
  writeTokenFile(dataDir, token);
  const opened = openDb(join(dataDir, "store.db"));
  const repo = createRepo(opened.db);
  await seed(repo);
  const gate = securityGate({ token, port: TEST_PORT });
  const server = Bun.serve({ hostname: "127.0.0.1", port: TEST_PORT, fetch: createRoutes({ repo, gate, machineId: "m" }).fetch });
  try {
    await body(dataDir);
  } finally {
    server.stop(true);
    opened.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("session-start hook (subprocess)", () => {
  test("fail-open: no server/token → clean exit 0 with NO output (never blocks session start)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "no-token-"));
    try {
      const { stdout, exitCode } = await runHook(
        "session-start.ts",
        { cwd: PROJECT, session_id: "s1", hook_event_name: "SessionStart", source: "startup" },
        { AGENT_OS_DATA_DIR: empty, AGENT_OS_PORT: String(TEST_PORT) },
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("fail-open: a live token but no server listening → clean exit 0 with NO output (connection refused)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "no-server-"));
    try {
      // A REAL token on disk (unlike the no-token case above), so the hook actually attempts the fetch
      // and gets it refused — distinct fail-open path from "no live token at all".
      writeTokenFile(dataDir, generateToken());
      const { stdout, exitCode } = await runHook(
        "session-start.ts",
        { cwd: PROJECT, session_id: "s1", hook_event_name: "SessionStart", source: "startup" },
        { AGENT_OS_DATA_DIR: dataDir, AGENT_OS_PORT: String(TEST_PORT) },
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("fail-open: a valid-JSON but WRONG-shape 200 is treated as nothing to inject", async () => {
    const port = 43218; // distinct fixed port — a raw stand-in server, not the real createRoutes app
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response(JSON.stringify({ unexpected: "shape" }), { headers: { "content-type": "application/json" } }),
    });
    const dataDir = mkdtempSync(join(tmpdir(), "wrong-shape-"));
    try {
      writeTokenFile(dataDir, generateToken());
      const { stdout, exitCode } = await runHook(
        "session-start.ts",
        { cwd: PROJECT, session_id: "s1", hook_event_name: "SessionStart", source: "startup" },
        { AGENT_OS_DATA_DIR: dataDir, AGENT_OS_PORT: String(port) },
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("");
    } finally {
      server.stop(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("happy path: reachable substrate → emits valid additionalContext with the resume cursor", async () => {
    await withServer(
      async (repo) => {
        await repo.writeHandoff({
          project: PROJECT,
          sessionId: "prev-session",
          machineId: "m",
          source: "claude-code",
          cursor: { inFlight: "LEAK_CANARY_TOKEN", lastDecided: "shipped the flock lock", next: "open the U6 PR" },
          ts: NOW,
        });
      },
      async (dataDir) => {
        const { stdout, exitCode } = await runHook(
          "session-start.ts",
          { cwd: PROJECT, session_id: "fresh-session", hook_event_name: "SessionStart", source: "startup" },
          { AGENT_OS_DATA_DIR: dataDir, AGENT_OS_PORT: String(TEST_PORT) },
        );
        expect(exitCode).toBe(0);
        const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
        expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
        expect(out.hookSpecificOutput.additionalContext).toContain("open the U6 PR");
        // The secret-marked in-flight buffer must never reach the injected context (redacted server-side).
        expect(out.hookSpecificOutput.additionalContext).not.toContain("LEAK_CANARY_TOKEN");
      },
    );
  });

  test("raw lane end-to-end: breadcrumb-only project (no handoff) previews via the real HTTP+DB stack", async () => {
    await withServer(
      async (repo) => {
        await repo.writeBreadcrumb(crumb("did A", 1));
        await repo.writeBreadcrumb(crumb("did B", 2));
        await repo.writeBreadcrumb(crumb("did C", 3));
      },
      async (dataDir) => {
        const { stdout, exitCode } = await runHook(
          "session-start.ts",
          { cwd: PROJECT, session_id: "fresh-session", hook_event_name: "SessionStart", source: "startup" },
          { AGENT_OS_DATA_DIR: dataDir, AGENT_OS_PORT: String(TEST_PORT) },
        );
        expect(exitCode).toBe(0);
        const out = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
        const ctx = out.hookSpecificOutput.additionalContext;
        expect(ctx).toContain("No curated handoff");
        expect(ctx).toContain("• ");
      },
    );
  });
});

describe("session-end hook (subprocess)", () => {
  test("happy path: POSTs a graceful-end marker the server records", async () => {
    await withServer(
      async () => {},
      async (dataDir) => {
        const { exitCode } = await runHook(
          "session-end.ts",
          { cwd: PROJECT, session_id: "ending-session", hook_event_name: "SessionEnd", reason: "prompt_input_exit" },
          { AGENT_OS_DATA_DIR: dataDir, AGENT_OS_PORT: String(TEST_PORT) },
        );
        expect(exitCode).toBe(0);
        // Re-open the same store to confirm the marker landed through POST /session-end.
        const opened = openDb(join(dataDir, "store.db"));
        try {
          const ws = await createRepo(opened.db).readWorkState(PROJECT);
          expect(ws?.rawTrailTail?.some((c) => c.kind === "session-end" && c.sessionId === "ending-session")).toBe(true);
        } finally {
          opened.close();
        }
      },
    );
  });

  test("fail-open: no server/token → clean exit 0, no throw", async () => {
    const empty = mkdtempSync(join(tmpdir(), "no-token-end-"));
    try {
      const { exitCode } = await runHook(
        "session-end.ts",
        { cwd: PROJECT, session_id: "s1", hook_event_name: "SessionEnd", reason: "other" },
        { AGENT_OS_DATA_DIR: empty, AGENT_OS_PORT: String(TEST_PORT) },
      );
      expect(exitCode).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("mcp-headers hook (subprocess)", () => {
  test("emits the live token as the X-Agent-OS-Token header", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-headers-"));
    try {
      const token = generateToken();
      writeTokenFile(root, token);
      const { stdout, exitCode } = await runHook("mcp-headers.ts", {}, { AGENT_OS_DATA_DIR: root });
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ [TOKEN_HEADER]: token });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fail-open: no token file → emits an empty token (valid JSON, CC marks the server unavailable)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mcp-headers-empty-"));
    try {
      const { stdout, exitCode } = await runHook("mcp-headers.ts", {}, { AGENT_OS_DATA_DIR: empty });
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ [TOKEN_HEADER]: "" });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ── fetchWithTimeout — the hooks' shared abort-based fetch ceiling ──────────────────────────────────────

describe("fetchWithTimeout", () => {
  test("aborts before a slow server responds, resolving null", async () => {
    const port = 43219; // distinct fixed port from the other raw-Bun.serve tests above
    // Cancelable via clearTimeout in `finally` (rather than a bare `await new Promise(setTimeout(...))`
    // in the handler) so a slow/never-cancelled server timer can't outlive this test.
    let handlerTimer: ReturnType<typeof setTimeout> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () =>
        new Promise<Response>((resolve) => {
          handlerTimer = setTimeout(() => resolve(new Response("too slow")), 500);
        }),
    });
    try {
      const start = Date.now();
      const res = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 50);
      expect(res).toBeNull();
      expect(Date.now() - start).toBeLessThan(500); // returned well before the slow server would have
    } finally {
      if (handlerTimer) clearTimeout(handlerTimer);
      server.stop(true);
    }
  });
});
