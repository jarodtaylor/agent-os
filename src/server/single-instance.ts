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
 * MECHANISM: a real OS advisory lock — `flock(fd, LOCK_EX | LOCK_NB)` on a held-open fd, bound from
 * libc via Bun FFI. The lock lives on the open file description, so:
 *   - It auto-releases when the process exits — CLEAN OR CRASHED (even SIGKILL) — because the OS drops
 *     the fd. There is no pid recorded and no stale file to reclaim, which is exactly why this closes
 *     the two edges the previous pid-file guard couldn't: the stale-reclaim TOCTOU (no reclaim step)
 *     and the pid-recycle false-positive (no pid consulted). See open-findings U3-R3 / decision #23.
 *   - We deliberately HOLD the fd for the whole process lifetime (never close it on the happy path) —
 *     closing it would release the lock. index.ts discards the returned release fn on purpose.
 *   - We do NOT unlink the lock file on release. A fresh holder may already have it open; unlink +
 *     recreate would hand two processes two different inodes and two "successful" exclusive locks.
 *     (Same reason: never "rm agent-os.lock to recover" while the daemon runs — a recreated file is a
 *     new inode, so a second instance would lock it and you'd get two SQLite writers over one store.)
 *
 * launchd (U15) remains the PRODUCTION single-instance guarantee (one supervised daemon); this lock is
 * defense-in-depth against a manual double-run and the authority during crash recovery.
 */
import { dlopen, FFIType, suffix } from "bun:ffi";
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

// flock(2) operations — identical constant values on macOS (sys/file.h) and Linux, so no per-platform
// table is needed. LOCK_NB makes the acquire non-blocking: it returns immediately rather than waiting
// for the current holder to release.
const LOCK_EX = 2;
const LOCK_NB = 4;

type FlockFn = (fd: number, operation: number) => number;

// Guarded, lazy, one-time FFI bind. NOT a top-level `dlopen` — a bind failure must not throw at import
// time and take out every unrelated module (and test file) that transitively imports this one. Cached
// after the first attempt: the function on success, `null` on failure (so we don't re-`dlopen` per call).
let boundFlock: FlockFn | null | undefined;

function resolveFlock(): FlockFn {
  if (boundFlock === undefined) boundFlock = bindFlock();
  if (boundFlock === null) {
    // Distinct from the "already running" refusal: here we simply cannot obtain the OS primitive that
    // enforces single-writer, so we fail closed rather than boot an unguarded second-writer risk.
    throw new Error(
      "could not bind the OS file lock (flock) via FFI; agent-os cannot guarantee a single writer and refuses to start",
    );
  }
  return boundFlock;
}

// macOS exposes libc symbols through libSystem; Linux through libc. `suffix` covers odd Linux layouts.
function flockLibCandidates(): string[] {
  return process.platform === "darwin"
    ? ["libSystem.dylib", "/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", `libc.${suffix}`];
}

// Exported so a test can drive the fail-closed path with a REAL dlopen failure (a bogus candidate) —
// no `bun:ffi` mock, which doesn't take effect outside the test runner anyway. Returns null when no
// candidate library exposes a bindable `flock`; resolveFlock turns that null into the distinct throw.
export function bindFlock(candidates: string[] = flockLibCandidates()): FlockFn | null {
  for (const path of candidates) {
    try {
      const { symbols } = dlopen(path, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      return symbols.flock as FlockFn;
    } catch {
      // try the next candidate library path
    }
  }
  return null;
}

/** Path to the data dir's advisory lock file (internal — no external caller since the tests moved to real subprocesses). */
function lockPath(dataDir: string): string {
  return join(dataDir, "agent-os.lock");
}

/**
 * Acquire the data dir's single-instance lock. Throws if another instance already holds it, and throws
 * a DISTINCT error if the OS lock primitive can't be bound at all. Returns a release fn (closes the fd,
 * releasing the lock) for clean shutdown and tests. `dataDir` must already exist — the boot sequence
 * calls `ensureDataDir` up front, before this lock and before the store opens.
 */
export function acquireSingleInstanceLock(dataDir: string): () => void {
  const flock = resolveFlock();
  // "a" = O_CREAT | O_WRONLY | O_APPEND: create the lock file if absent WITHOUT truncating (a live
  // holder's fd is unaffected by our open), mode 0600 so a data-dir lock isn't world-readable.
  const fd = openSync(lockPath(dataDir), "a", 0o600);

  if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    // Under LOCK_NB a non-zero return is overwhelmingly EWOULDBLOCK — another live process (any port)
    // holds this dataDir's lock. FFI gives no cheap errno, so we FAIL CLOSED on any non-zero and let
    // the message name both likely causes rather than over-asserting contention (over-asserting would
    // send a user to kill a phantom process or "rm" the lock — now an inode-divergence corruption
    // path). The rare non-contention cases (ENOLCK / unsupported-FS / EINTR) are unreachable on a
    // local macOS/Linux data dir; telling them apart needs errno-awareness (a bun:ffi `cc` shim +
    // per-platform errno table) — a tracked fast-follow, deferred. See DECISIONS / GitHub issues.
    closeSync(fd);
    throw new Error(
      "could not acquire the single-instance lock for this data dir — another agent-os is already running, or this data dir's filesystem may not support file locking; refusing to start",
    );
  }

  // Best-effort DIAGNOSTIC content — never load-bearing (the lock is the flock, not this text). Records
  // who holds it, replacing the debugging signal the old pid file carried. Truncate first so the file
  // shows the CURRENT holder, not an append trail across restarts.
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, `pid=${process.pid} started=${new Date().toISOString()}\n`);
  } catch {
    // diagnostics are optional; a write failure must not fail an otherwise-acquired lock
  }

  // Hold the fd (and thus the lock) for the process lifetime; the OS releases it on exit. The release
  // fn exists for clean shutdown/tests; index.ts intentionally does not call it. Latch it: a bare
  // second closeSync(fd) would close whatever unrelated fd later reused this number, so guard on a flag.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      closeSync(fd);
    } catch {
      // fd already gone (e.g. mid process-exit) — nothing to release
    }
  };
}
