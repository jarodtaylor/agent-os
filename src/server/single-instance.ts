/**
 * Single-instance guard — one agent-os daemon per DATA DIR (KTD9: "one SQLite writer by construction").
 *
 * The server's bind-before-write ordering (index.ts) only stops a SAME-port race: a second boot that
 * loses the EADDRINUSE contest crashes before it can clobber the token. But `AGENT_OS_PORT` is
 * configurable while the store + token live under one `dataDir`, so a second daemon with the same
 * `AGENT_OS_DATA_DIR` and a DIFFERENT port would bind fine and then (a) overwrite the live token and
 * (b) run a second writer over one SQLite store. This lock is DATA-DIR-scoped, not port-scoped, so it
 * closes both: a second instance for a data dir already owned by a live process refuses to start.
 *
 * It is a personal-machine advisory lock (a pid file), not a distributed lock: it reliably catches the
 * real case — "I started a second instance while the first is running." A lock left by a CRASHED holder
 * is reclaimed (its pid is dead). The only residual is pid recycling or a crash in the microsecond
 * between create-and-write-pid; both are recoverable by deleting `agent-os.lock` by hand.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Path to the data dir's advisory lock file. */
export function lockPath(dataDir: string): string {
  return join(dataDir, "agent-os.lock");
}

/**
 * Acquire the data dir's single-instance lock. Throws if another LIVE instance already holds it. A
 * stale lock (its recorded pid is dead) is reclaimed. Returns a release fn to call on clean shutdown
 * (and in tests). `dataDir` must already exist — the boot sequence opens the store (which creates it)
 * first.
 */
export function acquireSingleInstanceLock(dataDir: string): () => void {
  const path = lockPath(dataDir);
  // Two attempts: the first may find a stale lock, reclaim it, and the second then creates cleanly.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" = O_CREAT|O_EXCL|O_WRONLY — an ATOMIC exclusive create that fails with EEXIST if the file
      // exists. Whoever wins this owns the data dir. Write our pid immediately so a peer can tell a
      // live holder (us) from a crashed one.
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;

      const raw = readFileSync(path, "utf8").trim();
      const holder = Number(raw);
      // Reclaim ONLY a lock whose recorded pid is a real, DEAD process. An empty/unparseable pid means
      // the owner is mid-creation (just did the exclusive open, hasn't written its pid yet) — treat it
      // as live and refuse, rather than stealing a lock out from under a starting instance.
      if (!raw || !Number.isInteger(holder) || isAlive(holder)) {
        throw new Error(
          `agent-os is already running for this data dir${raw ? ` (pid ${raw})` : ""}; refusing to start a second instance`,
        );
      }
      rmSync(path, { force: true }); // stale holder is dead — clear it and retry the create
    }
  }
  throw new Error(`could not acquire the single-instance lock at ${path}`);
}

/** Is `pid` a live process? `process.kill(pid, 0)` sends NO signal — it only probes existence. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // signal delivered → alive
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = alive but owned by another user (still alive).
    return (err as { code?: string }).code === "EPERM";
  }
}
