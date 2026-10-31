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
The brain server must survive crashes and logout/login, because a down server silently produces cold starts. The fix is a LaunchAgent with `RunAtLoad` + `KeepAlive` (`templates/com.agent-os.server.plist`), installed by `src/install/launchd.ts` through the config-write engine. The plist itself is a short template. Almost every defect found on the way was in the *failure paths*: what happens when launchd and our own single-instance lock disagree, when a reload fails halfway, or when the engine's write lands but its journal entry doesn't. Two review layers, the cross-model review peer, and the cross-model adversarial gate converged on those paths, not on the happy path, and the tests passed throughout. The code is correct now, but the reasons behind it are not visible from the code alone.

## Guidance

**1. Probe the single-instance lock before you bootstrap.** A server started by hand still holds the data dir's `flock` (`src/server/single-instance.ts`). Every launchd-spawned child then fails `acquireSingleInstanceLock` at boot and exits. `KeepAlive` respawns it forever, throttled only by launchd's default respawn interval, and the only trace is in `server.log`. Install therefore acquires and immediately releases the lock and refuses on contention (`installLaunchd` in `src/install/launchd.ts`). It skips the probe when our own agent is already loaded, because then the holder is our supervised server and a reinstall must still work. The probe is safe for the lock's invariants (`docs/solutions/tooling-decisions/os-file-locking-in-bun-via-ffi.md`): the open does not truncate (the post-lock diagnostic rewrite is best-effort and not load-bearing), release is idempotent, and the lock file is never unlinked. The window between the probe and the bootstrap is inherent and acceptable, because the server's own boot re-acquires the lock.

**2. A file you own outright is uninstalled by replaying its journal, not by targeted removal.** `docs/solutions/design-patterns/building-installers-on-the-config-write-engine.md` says never to whole-file `undo` a config that a foreign process co-owns. That rule exists because such files always diverge. The plist is different: we are its only writer. Uninstall replays the undo entries for that path newest-first and stops after the entry that *created* it (`uninstallLaunchd`). It does not simply take the next entry each time: each step undoes the next-older entry whose written bytes match what is on disk *now*. The journal is not one straight chain. An uninstall that died partway leaves it mid-chain, and a reinstall after that starts a branch, and a "replay the next N entries" loop gets refused by `undo`'s identity check and strands a RunAtLoad plist. Following the chain by content needs no extra state, and every step stays identity-checked. (Two adversarial-gate rounds found the fixed-slice version's failure modes one at a time.) This gives three things for free:
- a plist that existed before ours is restored byte-identically;
- a hand-edited plist makes the identity-checked `undo` refuse, which is reported in `failed` and never clobbered;
- several reinstalls with different content unwind cleanly.

**Keep that journal where the file's path is keyed, not where the server's data lives.** The plist path is fixed by the home dir, but the server's data dir is configurable. If the journal lived in the data dir, a reinstall with a different data dir would start a second journal whose oldest entry is a *backup* of the first plist. Uninstall with the new dir would then restore that RunAtLoad plist and report success, and the "uninstalled" server would start at the next login. The install journal therefore lives under `~/Library/Application Support/agent-os`, derived from `home` (`installStateDir`). The cross-model gate caught this; no in-process reviewer did.

**3. A reload is bootout-then-bootstrap, so a failed reload leaves the server down. Make that loud, and don't try to be clever about it.** Changing the definition means `launchctl bootout` (the server is now down) then `bootstrap`. On failure, install stops the new agent and checks that it actually stopped, restores the previous plist, and throws an error that says the server is DOWN and names every rollback step that failed (the rollback block at the end of `installLaunchd`). It deliberately does **not** auto-restart the previous agent. The first version did, and each review round found an edge in that restart: a failed restart was swallowed, a thrown `undo` made it restart the *new* failed plist as if it were the old one, and the restored agent's readiness was probed on the new port. Two rounds of the adversarial gate stalled on that branch alone. Install is a command run by hand at a terminal, so a loud error is not a silent cold start, and removing the restart removed the whole class of bugs.

**A zero exit from `launchctl bootstrap` only means launchd accepted the job, not that the server came up.** A child that dies at boot (taken port, bad path, crash) still bootstraps cleanly, and KeepAlive then loops on it. Install therefore waits, with a time limit, for `/health` to report `supervisor: "launchd"` (`becameHealthy`). On timeout it rolls back as in point 3. The no-op path ("same bytes, already loaded") checks health too, so a loaded but broken agent is reported rather than called "installed". This was the gate's high finding: tests with a fake launchctl model "bootstrapped" as "running", so only an explicit readiness probe can tell the two apart.

**4. Revert an `AppliedButUnjournaledError` at install time.** When the engine's atomic rename succeeds but the journal append fails, the plist is live with no undo entry. Nothing later can reverse it, and `RunAtLoad` will start the failed install at the next login. `publishPlist` catches that error type, restores the backup or deletes a plist it created, but only while the file still holds the bytes we wrote. It then rethrows with the recovery outcome (`publishPlist`). Other installers can tolerate this state as "applied, warn"; a RunAtLoad file cannot, because its next effect is to *execute*.

**5. Bake the runtime path from PATH, not `process.execPath`.** launchd's PATH is minimal, so the plist must name an absolute `bun`. Under a version manager, `process.execPath` is the version-pinned binary (e.g. mise's `.../bun/1.4.3/bin/bun`), and an upgrade plus prune deletes it from under the agent. The result is another silent KeepAlive loop. `Bun.which("bun")` returns the manager's stable path (`.../bun/latest/bin/bun`), so the default prefers it (`resolve` in `src/install/launchd.ts`).

## Why This Matters
Each of these failures is *silent* in exactly the way the supervision exists to prevent. A crash loop, a server left down after a reinstall, or a stale plist that starts at login all look like "installed" from the terminal. The tests passed through every one of these defects, because they only show up when launchd, the lock, or the journal fails, and the default fake never fails.

## When to Apply
- Any new LaunchAgent/LaunchDaemon (or systemd unit with `Restart=always`) wrapping a process that holds a single-instance lock. Probe before you load.
- Any installer step that changes external process state after a file write. Pair a rollback of the write with a restore of the prior process state, and report a failed restore.
- Any installer-owned file whose mere presence has an effect (autostart, cron, login items). Treat `AppliedButUnjournaledError` as "revert now", not "warn".

## Examples
Inject the launchctl runner and the health probe so tests can fail exactly the step under test (`tests/launchd.test.ts`):

```ts
// A reload whose new server never answers /health: stopped, previous plist restored, and the error says DOWN.
await installLaunchd(opts(lc.run));
const before = readFileSync(plistPath(home));
await expect(installLaunchd(opts(lc.run, { port: 4400, healthy: async () => false })))
  .rejects.toThrow(/did not become healthy.*server is DOWN/);
expect(readFileSync(plistPath(home)).equals(before)).toBe(true);
expect(lc.isLoaded()).toBe(false);
```

To force the unjournaled path, put a directory where the journal file goes (`<dataDir>/undo-journal.jsonl`). The append then fails after the rename has already published the plist.
