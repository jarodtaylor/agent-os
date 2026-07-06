import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstanceLock } from "../src/server/single-instance";

// Each test gets its own temp data dir; all are cleaned up afterward.
const dirs: string[] = [];
// Spawned lock-holder children, killed in afterEach as a backstop: a child that never prints
// "ACQUIRED" would suspend the test body inside waitForLine until the 15s timeout, so in-body
// cleanup can't be relied on — afterEach still runs on timeout and reaps them.
const holders: Bun.Subprocess[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "single-instance-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const h of holders.splice(0)) {
    try {
      h.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const holderScript = join(import.meta.dir, "fixtures", "lock-holder.ts");

/**
 * Block until `needle` appears on the child's stdout — a deterministic readiness handshake, never a
 * sleep. Throws if the stream closes first (the child died before signaling).
 */
async function waitForLine(stream: ReadableStream<Uint8Array>, needle: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`child stream closed before printing "${needle}"`);
      buf += decoder.decode(value, { stream: true });
      if (buf.includes(needle)) return;
    }
  } finally {
    reader.releaseLock();
  }
}

describe("single-instance lock — one daemon per data dir (KTD9)", () => {
  // The core guarantee a pid-file can't cleanly cover: a holder that CRASHES (killed with no chance
  // to clean up) still releases the lock, because the OS drops the flock when the process dies. No
  // stale file to reclaim, no pid to consult — so no stale-reclaim TOCTOU and no pid-recycle
  // false-positive (open-findings U3-R3). This also proves cross-process mutual exclusion: while a
  // separate live process holds the lock, our acquire is refused.
  test("a crashed holder's lock auto-releases; a fresh acquire then succeeds", async () => {
    const dir = tempDir();
    const holder = Bun.spawn(["bun", "run", holderScript, dir], { stdout: "pipe" });
    holders.push(holder); // afterEach kills it even if this body suspends on a hang or an assertion throws
    await waitForLine(holder.stdout, "ACQUIRED");

    // A second LIVE process (us) is refused while the child holds it.
    expect(() => acquireSingleInstanceLock(dir)).toThrow(/already running/i);

    // SIGKILL: nothing runs on the child's way out, so a subsequent successful acquire proves the OS
    // released the lock, not a shutdown handler. Reap the child (await exited) BEFORE re-acquiring —
    // the kernel releases the flock during process teardown, and an immediate re-acquire could
    // otherwise race that teardown.
    holder.kill("SIGKILL");
    await holder.exited;

    const release = acquireSingleInstanceLock(dir);
    release();
  }, 15_000);

  test("a second acquire on the same data dir throws while the first holds it", () => {
    const dir = tempDir();
    const release = acquireSingleInstanceLock(dir);
    try {
      // The real case the lock exists for: a different-port daemon on the same dataDir must refuse
      // to start rather than clobber the live token / run a second SQLite writer over one store.
      // flock treats independent opens independently even within one process, so this holds.
      expect(() => acquireSingleInstanceLock(dir)).toThrow(/already running/i);
    } finally {
      release();
    }
  });

  test("releasing the lock lets a fresh acquire succeed", () => {
    const dir = tempDir();
    acquireSingleInstanceLock(dir)(); // acquire, then immediately release
    const release = acquireSingleInstanceLock(dir); // must not throw
    release();
  });
});
