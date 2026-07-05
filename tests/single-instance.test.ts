import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstanceLock, lockPath } from "../src/server/single-instance";

// Each test gets its own temp data dir; all are cleaned up afterward.
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "single-instance-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("single-instance lock — one daemon per data dir (KTD9)", () => {
  test("a second acquire on the same data dir throws while the first holds it", () => {
    const dir = tempDir();
    const release = acquireSingleInstanceLock(dir);
    try {
      // This is the real case the lock exists for: a different-port daemon on the same dataDir must
      // refuse to start rather than clobber the live token / run a second SQLite writer over one store.
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

  test("a stale lock from a DEAD holder pid is reclaimed, not honored", () => {
    const dir = tempDir();
    // 999999 is above macOS's default pid_max and not a live process anywhere realistic — so the holder
    // reads as dead and the lock is treated as stale (left by a crashed instance) and reclaimed.
    writeFileSync(lockPath(dir), "999999\n");
    const release = acquireSingleInstanceLock(dir); // reclaims without throwing
    release();
  });

  test("an empty pid file (holder mid-creation) is treated as live — not stolen", () => {
    const dir = tempDir();
    writeFileSync(lockPath(dir), ""); // exclusive-created but the pid isn't written yet
    // An empty pid must NOT be read as "stale/reclaimable" — that would steal the lock from an instance
    // that is still starting up. Fail closed: refuse.
    expect(() => acquireSingleInstanceLock(dir)).toThrow(/already running/i);
  });
});
