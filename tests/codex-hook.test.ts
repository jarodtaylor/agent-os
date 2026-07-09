import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "../src/server/routes";
import { generateToken, securityGate, writeTokenFile } from "../src/server/security";
import { openDb } from "../src/store/db";
import { createRepo, type Repo } from "../src/store/repo";
import { accessLog } from "../src/store/schema";

const REPO = join(import.meta.dir, ".."); // tests/ → repo root
const TEST_PORT = 43227; // an uncommon loopback port, distinct from tests/hooks.test.ts's 43217-43219
const PROJECT = "/tmp/agent-os-codex-hook-test-project";

/** Spawn the real `bun run hooks/codex-session-start.ts` subprocess with a stdin payload — the actual path
 *  Codex will invoke. `cwd` is an optional PROCESS cwd (distinct from any `cwd` key in `payload`), used only
 *  by the process.cwd()-fallback test below. */
async function runHook(payload: unknown, env: Record<string, string>, cwd?: string) {
  const proc = Bun.spawn(["bun", "run", join(REPO, "hooks", "codex-session-start.ts")], {
    cwd,
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

/** Stand up a real loopback server (token on disk in a temp dataDir) and run `body` against it — mirrors
 *  tests/hooks.test.ts's withServer exactly. */
async function withServer(seed: (repo: Repo) => Promise<void>, body: (dataDir: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-server-"));
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

describe("codex-session-start hook (subprocess)", () => {
  test("fail-open: no server/token → clean exit 0 with NO output (never blocks session start)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "codex-no-token-"));
    try {
      const { stdout, exitCode } = await runHook(
        { session_id: "s1", cwd: PROJECT },
        { AGENT_OS_DATA_DIR: empty, AGENT_OS_PORT: String(TEST_PORT) },
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("fail-open: a live token but no server listening → clean exit 0 with NO output (connection refused)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "codex-no-server-"));
    try {
      // A REAL token on disk (unlike the no-token case above), so the hook actually attempts the fetch
      // and gets it refused — distinct fail-open path from "no live token at all".
      writeTokenFile(dataDir, generateToken());
      const { stdout, exitCode } = await runHook(
        { session_id: "s1", cwd: PROJECT },
        { AGENT_OS_DATA_DIR: dataDir, AGENT_OS_PORT: String(TEST_PORT) },
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("happy path: reachable substrate → emits the PLAIN-TEXT summary, NOT the CC hook's JSON envelope", async () => {
    await withServer(
      async (repo) => {
        await repo.writeHandoff({
          project: PROJECT,
          sessionId: "prev-session",
          machineId: "m",
          source: "codex",
          cursor: { inFlight: "LEAK_CANARY_TOKEN", lastDecided: "shipped the flock lock", next: "open the U8 PR" },
          ts: Date.now(),
        });
      },
      async (dataDir) => {
        const { stdout, exitCode } = await runHook(
          { session_id: "fresh-session", cwd: PROJECT },
          { AGENT_OS_DATA_DIR: dataDir, AGENT_OS_PORT: String(TEST_PORT) },
        );
        expect(exitCode).toBe(0);
        const out = stdout.trim();
        // Plain text, NOT `{ hookSpecificOutput: { additionalContext: ... } }` — the CC hook's envelope.
        expect(out.startsWith("{")).toBe(false);
        expect(out).toContain("state (curated lane)");
        expect(out).toContain("Next: open the U8 PR");
        expect(out).toContain("Last decided: shipped the flock lock");
        // The secret-marked in-flight buffer must never reach the injected context (redacted server-side).
        expect(out).not.toContain("LEAK_CANARY_TOKEN");
      },
    );
  });

  test("the x-agent-os-harness: codex header reaches the server (VS6 per-harness hit rate)", async () => {
    await withServer(
      async () => {}, // no seed needed — logAccess fires on every /work-state hit, hit or miss
      async (dataDir) => {
        const { exitCode } = await runHook(
          { session_id: "harness-check-session", cwd: PROJECT },
          { AGENT_OS_DATA_DIR: dataDir, AGENT_OS_PORT: String(TEST_PORT) },
        );
        expect(exitCode).toBe(0);
        // Re-open the same store to confirm the access-log row landed with harness="codex" — the same
        // "reopen and inspect" technique tests/hooks.test.ts uses to confirm the session-end marker.
        const opened = openDb(join(dataDir, "store.db"));
        try {
          const rows = opened.db.select().from(accessLog).where(eq(accessLog.sessionId, "harness-check-session")).all();
          expect(rows.length).toBe(1);
          expect(rows[0]?.harness).toBe("codex");
        } finally {
          opened.close();
        }
      },
    );
  });

  test("falls back to process.cwd() when the stdin payload carries no cwd at all", async () => {
    // realpathSync: on macOS, os.tmpdir() (/var/folders/...) is itself a symlink into /private/var/...,
    // and a spawned child's process.cwd() reports the RESOLVED path. Canonicalize once here so the seeded
    // project key and the hook's process.cwd()-derived project key are the same string.
    const fallbackProject = realpathSync(mkdtempSync(join(tmpdir(), "codex-cwd-fallback-")));
    try {
      await withServer(
        async (repo) => {
          await repo.writeBreadcrumb({
            id: "cwd-fallback-1",
            project: fallbackProject,
            sessionId: "s",
            machineId: "m",
            source: "codex",
            kind: "note",
            summary: "fallback worked",
            ts: Date.now(),
            sensitivity: "personal",
          });
        },
        async (dataDir) => {
          // No `cwd` key in the payload — the hook must fall back to its OWN process.cwd(), which is
          // pinned to `fallbackProject` via the spawn option (distinct from the stdin payload).
          const { stdout, exitCode } = await runHook(
            { session_id: "s2" },
            { AGENT_OS_DATA_DIR: dataDir, AGENT_OS_PORT: String(TEST_PORT) },
            fallbackProject,
          );
          expect(exitCode).toBe(0);
          expect(stdout).toContain("fallback worked");
        },
      );
    } finally {
      rmSync(fallbackProject, { recursive: true, force: true });
    }
  });
});
