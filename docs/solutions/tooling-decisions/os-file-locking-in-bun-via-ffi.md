---
title: OS advisory file locking in Bun via FFI (libc flock)
date: 2026-07-06
category: docs/solutions/tooling-decisions
module: server/single-instance lock
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - You need a real OS-level lock (single-instance daemon guard, cross-process mutex) in a Bun process
  - Bun/Node exposes no native binding for a POSIX/libc primitive you need
  - A pid-file or mtime-heuristic lock's staleness edges (stale-reclaim TOCTOU, pid-recycle) are unacceptable
tags: [bun, ffi, flock, file-locking, single-instance, dlopen, advisory-lock]
related_components: [server, sqlite-store]
---

# OS advisory file locking in Bun via FFI (libc flock)

## Context
agent-os needs a single-instance daemon guard — one writer per data dir (KTD9), so a second boot (even on a different port) can't clobber the token or run a second SQLite writer. A pid-file lock catches the common double-run but has irreducible edges: a stale-reclaim TOCTOU under simultaneous crash-recovery, and a pid-recycle false-positive that refuses a legitimate restart. The durable question this answers: **how do you get a real OS lock inside a Bun process, since neither Bun nor Node ships one?**

Note the mechanism choice up front: popular Node "lockfile" libraries (`proper-lockfile` et al.) are themselves pid/mtime **heuristic** locks — the same edge-class you're trying to escape. A real OS advisory lock means going to libc directly. In Bun that means FFI.

## Guidance

**Bind libc `flock(2)` via `bun:ffi` `dlopen`.** Use a candidate-list fallback for the library path — macOS exposes libc through `libSystem.dylib`; Linux through `libc.so.6`:

```ts
import { dlopen, FFIType, suffix } from "bun:ffi";
const candidates = process.platform === "darwin"
  ? ["libSystem.dylib", "/usr/lib/libSystem.B.dylib"]
  : ["libc.so.6", `libc.${suffix}`];
// dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
```

- **The flock operation constants are identical on macOS and Linux** (`LOCK_SH=1`, `LOCK_EX=2`, `LOCK_NB=4`, `LOCK_UN=8`) — no per-platform table needed. (errno values are the opposite — they *differ* per platform; see the errno gotcha.)
- **Open the lock file non-truncating** (`"a"`, mode `0600`) so a losing acquirer's `open()` never clobbers a live holder's file before `flock` even arbitrates. Then `flock(fd, LOCK_EX | LOCK_NB)`: `0` = acquired, non-zero = held.
- **Hold the fd for the process lifetime.** The lock lives on the open file description, so the OS releases it automatically when the process exits — clean *or* crashed, including `SIGKILL`. This is exactly what closes the pid-file's edges: no pid is recorded (no recycle false-positive) and there is no reclaim step (no stale-reclaim TOCTOU).
- **Never unlink the lock file on release.** `unlink` + recreate hands two processes two *different inodes* and therefore two "successful" exclusive locks → two writers over one store. Just `close()` the fd and leave the file. (Corollary: never advise "`rm` the lock to recover" for a *running* daemon.)

**Two traps that bite hardest:**

1. **Bind lazily and guarded — never at import time.** A top-level `dlopen` that throws takes out *every* module (and test file) that transitively imports yours, with a confusing stack. Bind on first use; cache the bound function (or `null`) after the first attempt.
2. **Fail closed with two *distinct* errors.** (a) bind/`dlopen` fails → you can't guarantee single-writer → refuse to boot with a distinct "could not bind the lock primitive" error; (b) `flock` returns non-zero → already held → refuse with the contention error. Don't let a bind failure masquerade as contention.

**Two smaller gotchas:**

- **errno is not cheaply readable across the FFI boundary.** Under `LOCK_NB` you get a bare `-1`/non-zero, so any non-zero reads as "held." Correct on a local FS; it *misreports* on a filesystem that doesn't support flock (NFS / synced folders / some container mounts). Word the failure message to name both causes ("…already running, **or** this filesystem may not support locking"). Full errno-awareness (distinguish `EWOULDBLOCK` from `ENOLCK`/`ENOTSUP`/`EINTR`) needs per-platform errno tables **and** a `bun:ffi` `cc` shim — a libc call in the FFI trampoline can clobber errno before you read it — so it's a separate unit, not a one-liner.
- **Make the release fn idempotent.** Latch a `closed` flag; a bare second `close(fd)` would close whatever unrelated fd later reused that number.

## Why This Matters
A real OS lock is the only thing that makes a single-instance guard safe across crashes without pid heuristics — and the two traps are silent footguns of very different severity: the unlink-on-release trap causes **database corruption** (two writers), and the bind-at-import trap breaks **unrelated test files**. Getting these right once and writing them down means the next "Bun lacks an OS primitive" need — the `launchd`/supervision work, a Linux/VPS port, or any future cross-process coordination — starts from a known-good pattern instead of rediscovering the inode trap the hard way.

## When to Apply
- Building any single-instance / one-writer guarantee in a Bun (or Bun-first) process.
- Reaching for an OS/libc primitive Bun doesn't wrap — flock is the worked example, but the FFI `dlopen` + candidate-path + lazy-guarded-bind + fail-closed shape generalizes.
- Choosing between a "lockfile" npm package and a real OS lock: if you need true atomic mutual exclusion with crash-safe auto-release, the library heuristics won't give it to you — go to libc.

## Examples

**Acquire (the shape, condensed):**
```ts
export function acquireSingleInstanceLock(dataDir: string): () => void {
  const flock = resolveFlock();                 // lazy, guarded, cached FFI bind
  const fd = openSync(lockPath(dataDir), "a", 0o600); // non-truncating, 0600
  if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {     // 0 = got it; non-zero = held
    closeSync(fd);
    throw new Error("…already running, or this filesystem may not support locking");
  }
  let released = false;                          // idempotent release
  return () => { if (released) return; released = true; try { closeSync(fd); } catch {} };
  // NB: index.ts intentionally DISCARDS this fn — process exit is the release.
}
```

**Test the guarantee cross-process, not in-process** — the one edge a pid-file can't cover is a *crashed* holder auto-releasing. Drive it with a real subprocess and a deterministic handshake:
```ts
const holder = Bun.spawn(["bun", "run", holderScript, dir], { stdout: "pipe" });
await waitForLine(holder.stdout, "ACQUIRED");    // readiness handshake — never a sleep
expect(() => acquireSingleInstanceLock(dir)).toThrow(/already running/i); // 2nd live proc refused
holder.kill("SIGKILL");                          // SIGKILL: nothing runs on the way out
await holder.exited;                             // REAP before re-acquiring — avoid racing kernel teardown
acquireSingleInstanceLock(dir)();                // now succeeds → proves OS auto-release
```
Register the spawned holder in an `afterEach` cleanup list too — if the child hangs before signalling, the test body suspends and its own `finally` never runs.

## Related
- `src/server/single-instance.ts` — the implementation this documents.
- DECISIONS #23 (flock unit: pid-file → real OS lock, pulled ahead of U6) and #24 (errno-awareness deferred; Codex no-ship partially adopted).
- Deferred GitHub issue: "flock: make the lock errno-aware" (label `deferred`) — the errno gotcha's tracked fast-follow, with its VPS/network-FS/observed-misdiagnosis trigger.
- Prior art: the pid-file → flock promotion trigger (open-finding U3-R3).
