---
title: Supervising a single-instance server with launchd (install, reload, uninstall)
date: 2026-10-30
category: docs/solutions/design-patterns
module: install/launchd supervision
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - Running a long-lived local server under a macOS LaunchAgent with KeepAlive
  - The server guards itself with a single-instance lock (one writer per data dir)
  - An installer publishes a file it owns outright (not a config a foreign tool co-owns) and must reverse it later
  - An install step mutates external state (launchctl) after a journaled file write
tags: [launchd, launchagent, keepalive, supervision, single-instance, flock, installer, undo-journal, bun]
related_components: [install, configwrite, server]
---

# Supervising a single-instance server with launchd (install, reload, uninstall)

## Context
The brain server must survive crashes and logout/login, because a down server silently produces cold starts. The fix is a LaunchAgent with `RunAtLoad` + `KeepAlive` (`templates/com.agent-os.server.plist`), installed by `src/install/launchd.ts` through the config-write engine. The plist itself is a short template. Almost every defect found on the way was in the *failure paths*: what happens when launchd and our own single-instance lock disagree, when a reload fails halfway, or when the engine's write lands but its journal entry doesn't. Two review layers and the cross-model peer converged on those paths, not on the happy path, and the tests passed throughout. The code is correct now, but the reasons behind it are not visible from the code alone.

## Guidance

**1. Probe the single-instance lock before you bootstrap.** A server started by hand still holds the data dir's `flock` (`src/server/single-instance.ts`). Every launchd-spawned child then fails `acquireSingleInstanceLock` at boot and exits. `KeepAlive` respawns it forever, throttled only by launchd's default respawn interval, and the only trace is in `server.log`. Install therefore acquires and immediately releases the lock and refuses on contention (`src/install/launchd.ts:142-147`). It skips the probe when our own agent is already loaded, because then the holder is our supervised server and a reinstall must still work. The probe is safe for the lock's invariants (`docs/solutions/tooling-decisions/os-file-locking-in-bun-via-ffi.md`): the open does not truncate (the post-lock diagnostic rewrite is best-effort and not load-bearing), release is idempotent, and the lock file is never unlinked. The window between the probe and the bootstrap is inherent and acceptable, because the server's own boot re-acquires the lock.

**2. A file you own outright is uninstalled by replaying its journal, not by targeted removal.** `docs/solutions/design-patterns/building-installers-on-the-config-write-engine.md` says never to whole-file `undo` a config that a foreign process co-owns. That rule exists because such files always diverge. The plist is different: we are its only writer. Uninstall replays the undo entries for that path newest-first and stops after the entry that *created* it (`src/install/launchd.ts:191-194`). The stop matters. A later install/uninstall cycle leaves older entries in the journal, and replaying past the newest creation would try to "restore" a file that is already gone, which `undo` refuses to do. This gives three things for free:
- a plist that existed before ours is restored byte-identically;
- a hand-edited plist makes the identity-checked `undo` refuse, which is reported in `failed` and never clobbered;
- several reinstalls with different content unwind cleanly.

**3. A reload is bootout-then-bootstrap, so a failed reload has to put the old agent back, and say so if it can't.** Changing the definition means `launchctl bootout` (the server is now down) then `bootstrap`. If that bootstrap fails, roll back the plist *and* bootstrap the restored definition, or the routine reinstall has left the server down. Guard each recovery step separately and append any failure to the thrown error (`src/install/launchd.ts:160-170`). The first version wrapped both steps in one `catch {}`. Two independent reviewers (correctness, and the cross-model peer) caught it: a failed restart was invisible, and an `undo` that threw skipped the restart entirely.

**4. Revert an `AppliedButUnjournaledError` at install time.** When the engine's atomic rename succeeds but the journal append fails, the plist is live with no undo entry. Nothing later can reverse it, and `RunAtLoad` will start the failed install at the next login. `publishPlist` catches that error type, restores the backup or deletes a plist it created, but only while the file still holds the bytes we wrote. It then rethrows with the recovery outcome (`src/install/launchd.ts:101-123`). Other installers can tolerate this state as "applied, warn"; a RunAtLoad file cannot, because its next effect is to *execute*.

**5. Bake the runtime path from PATH, not `process.execPath`.** launchd's PATH is minimal, so the plist must name an absolute `bun`. Under a version manager, `process.execPath` is the version-pinned binary (e.g. mise's `.../bun/1.4.3/bin/bun`), and an upgrade plus prune deletes it from under the agent. The result is another silent KeepAlive loop. `Bun.which("bun")` returns the manager's stable path (`.../bun/latest/bin/bun`), so the default prefers it (`src/install/launchd.ts:58`).

## Why This Matters
Each of these failures is *silent* in exactly the way the supervision exists to prevent. A crash loop, a server left down after a reinstall, or a stale plist that starts at login all look like "installed" from the terminal. The tests passed through every one of these defects, because they only show up when launchd, the lock, or the journal fails, and the default fake never fails.

## When to Apply
- Any new LaunchAgent/LaunchDaemon (or systemd unit with `Restart=always`) wrapping a process that holds a single-instance lock. Probe before you load.
- Any installer step that changes external process state after a file write. Pair a rollback of the write with a restore of the prior process state, and report a failed restore.
- Any installer-owned file whose mere presence has an effect (autostart, cron, login items). Treat `AppliedButUnjournaledError` as "revert now", not "warn".

## Examples
Inject the launchctl runner so tests can fail exactly the step under test (`tests/launchd.test.ts`):

```ts
// Fail only the reload's first bootstrap: the previous plist must be restored AND the agent loaded again.
let failNext = true;
const flaky: Launchctl = (args) => {
  if (args[0] === "bootstrap" && failNext) { failNext = false; return { code: 5, stderr: "Bootstrap failed" }; }
  return lc.run(args);
};
expect(() => installLaunchd(opts(flaky, { port: 4400 }))).toThrow(/bootstrap failed/);
expect(lc.isLoaded()).toBe(true);
```

To force the unjournaled path, put a directory where the journal file goes (`<dataDir>/undo-journal.jsonl`). The append then fails after the rename has already published the plist.
