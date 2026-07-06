// Test fixture (NOT a test file — no `.test.` in the name, so bun test ignores it).
// Spawned as a child process by tests/single-instance.test.ts to hold the single-instance lock
// from a REAL, separate process. It acquires the lock, prints a readiness line the parent blocks
// on, then hangs until the parent kills it — letting the test exercise cross-process mutual
// exclusion and OS-level auto-release on (SIG)KILL.
import { acquireSingleInstanceLock } from "../../src/server/single-instance";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: lock-holder.ts <dataDir>");
  process.exit(2);
}

acquireSingleInstanceLock(dataDir);
// Readiness signal — the parent waits for THIS exact line rather than sleeping, so the handshake
// is deterministic. Only printed once the lock is actually held.
console.log("ACQUIRED");

// Hold forever. A pending interval keeps the event loop alive; the parent ends us with SIGKILL,
// so nothing here runs on the way out — proving release is the OS's doing, not a shutdown handler.
setInterval(() => {}, 1 << 30);
