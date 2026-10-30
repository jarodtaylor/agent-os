import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLaunchd, LAUNCHD_LABEL, plistPath, renderPlist, uninstallLaunchd, type Launchctl } from "../src/install/launchd";
import { SUPERVISOR_ENV } from "../src/paths";
import { createRoutes } from "../src/server/routes";
import { acquireSingleInstanceLock } from "../src/server/single-instance";

// Fixture-home ONLY, and launchctl is a fake — these tests never touch ~/Library/LaunchAgents or the real launchd domain.
const REPO = join(import.meta.dir, ".."); // the real repo, so renderPlist reads the real template
const BUN = "/opt/bun/bin/bun";
const UID = 501;
const TARGET = `gui/${UID}/${LAUNCHD_LABEL}`;

let root: string;
let home: string;
let dataDir: string;

/** A fake launchd: tracks whether the agent is loaded and records every call. */
function fakeLaunchctl(opts: { bootstrapFails?: boolean } = {}) {
  const calls: string[][] = [];
  let loaded = false;
  const run: Launchctl = (args) => {
    calls.push(args);
    if (args[0] === "print") return { code: loaded ? 0 : 113, stderr: "" };
    if (args[0] === "bootout") {
      loaded = false;
      return { code: 0, stderr: "" };
    }
    if (args[0] === "bootstrap") {
      if (opts.bootstrapFails) return { code: 5, stderr: "Bootstrap failed: 5: Input/output error" };
      loaded = true;
      return { code: 0, stderr: "" };
    }
    return { code: 1, stderr: "unexpected" };
  };
  return { run, calls, verbs: () => calls.map((c) => c[0]).filter((v) => v !== "print"), isLoaded: () => loaded };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "launchd-"));
  home = join(root, "home");
  dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const opts = (launchctl: Launchctl, extra: { port?: number } = {}) => ({
  home,
  dataDir,
  repoRoot: REPO,
  port: extra.port ?? 4319,
  bunPath: BUN,
  launchctl,
  uid: UID,
});

describe("renderPlist", () => {
  test.skipIf(process.platform !== "darwin")("the rendered plist passes plutil -lint", () => {
    const path = join(root, "rendered.plist");
    writeFileSync(path, renderPlist({ repoRoot: REPO, dataDir: "/data & stuff <x>", port: 4319, bunPath: BUN }));
    const res = Bun.spawnSync(["plutil", "-lint", path]);
    expect(res.exitCode).toBe(0);
  });

  test("bakes the absolute bun, server entry, port, data dir, supervisor marker and keep-alive", () => {
    const xml = renderPlist({ repoRoot: REPO, dataDir: "/d", port: 4400, bunPath: BUN });
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain(`<string>${BUN}</string>`);
    expect(xml).toContain(`<string>${join(REPO, "src", "server", "index.ts")}</string>`);
    expect(xml).toContain("<key>AGENT_OS_PORT</key>\n\t\t<string>4400</string>");
    expect(xml).toContain(`<key>${SUPERVISOR_ENV}</key>\n\t\t<string>launchd</string>`);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).not.toContain("{{");
  });

  test("XML-escapes values so a path with & or < stays well-formed", () => {
    const xml = renderPlist({ repoRoot: REPO, dataDir: "/a&b<c", port: 4319, bunPath: BUN });
    expect(xml).toContain("<string>/a&amp;b&lt;c</string>");
  });
});

describe("installLaunchd", () => {
  test("fresh install writes the plist, creates the log dir, and bootstraps the agent", () => {
    const lc = fakeLaunchctl();
    const res = installLaunchd(opts(lc.run));
    expect(res.plist.created).toBe(true);
    expect(res.bootstrapped).toBe(true);
    expect(existsSync(plistPath(home))).toBe(true);
    expect(existsSync(join(dataDir, "logs"))).toBe(true);
    expect(lc.calls).toContainEqual(["bootstrap", `gui/${UID}`, plistPath(home)]);
    expect(lc.isLoaded()).toBe(true);
  });

  test("is idempotent: a second install with the same inputs writes nothing and does not reload", () => {
    const lc = fakeLaunchctl();
    installLaunchd(opts(lc.run));
    const before = readFileSync(plistPath(home));
    const res = installLaunchd(opts(lc.run));
    expect(res.plist.noop).toBe(true);
    expect(res.bootstrapped).toBe(false);
    expect(lc.verbs()).toEqual(["bootstrap"]); // only the first install loaded it
    expect(readFileSync(plistPath(home)).equals(before)).toBe(true);
  });

  test("a changed definition reloads the agent (bootout, then bootstrap)", () => {
    const lc = fakeLaunchctl();
    installLaunchd(opts(lc.run));
    const res = installLaunchd(opts(lc.run, { port: 4400 }));
    expect(res.plist.noop).toBe(false);
    expect(lc.verbs()).toEqual(["bootstrap", "bootout", "bootstrap"]);
  });

  test("an unchanged plist whose agent is not loaded gets bootstrapped", () => {
    const lc = fakeLaunchctl();
    installLaunchd(opts(lc.run));
    lc.run(["bootout", TARGET]); // agent stopped out-of-band
    const res = installLaunchd(opts(lc.run));
    expect(res.plist.noop).toBe(true);
    expect(res.bootstrapped).toBe(true);
  });

  test("a failed bootstrap rolls back the plist it created and throws", () => {
    const lc = fakeLaunchctl({ bootstrapFails: true });
    expect(() => installLaunchd(opts(lc.run))).toThrow(/bootstrap failed/);
    expect(existsSync(plistPath(home))).toBe(false);
  });

  test("a failed reload restores the previous plist and starts it again, so the server is not left down", () => {
    const lc = fakeLaunchctl();
    installLaunchd(opts(lc.run));
    const before = readFileSync(plistPath(home));
    let failNext = true;
    const flaky: Launchctl = (args) => {
      if (args[0] === "bootstrap" && failNext) {
        failNext = false;
        lc.calls.push(args);
        return { code: 5, stderr: "Bootstrap failed" };
      }
      return lc.run(args);
    };
    expect(() => installLaunchd(opts(flaky, { port: 4400 }))).toThrow(/bootstrap failed/);
    expect(readFileSync(plistPath(home)).equals(before)).toBe(true);
    expect(lc.isLoaded()).toBe(true);
  });

  test("refuses while an unsupervised server holds the data dir's lock, writing nothing", () => {
    mkdirSync(dataDir, { recursive: true });
    const release = acquireSingleInstanceLock(dataDir);
    try {
      const lc = fakeLaunchctl();
      expect(() => installLaunchd(opts(lc.run))).toThrow(/already running outside launchd/);
      expect(existsSync(plistPath(home))).toBe(false);
      expect(lc.verbs()).toEqual([]);
    } finally {
      release();
    }
  });
});

describe("uninstallLaunchd", () => {
  test("stops the agent and removes the plist it created", () => {
    const lc = fakeLaunchctl();
    installLaunchd(opts(lc.run));
    const out = uninstallLaunchd(opts(lc.run));
    expect(out).toEqual({ removed: [plistPath(home)], failed: [], warnings: [] });
    expect(lc.calls).toContainEqual(["bootout", TARGET]);
    expect(lc.isLoaded()).toBe(false);
    expect(existsSync(plistPath(home))).toBe(false);
  });

  test("replays every reinstall back to the created write", () => {
    const lc = fakeLaunchctl();
    installLaunchd(opts(lc.run));
    installLaunchd(opts(lc.run, { port: 4400 }));
    expect(uninstallLaunchd(opts(lc.run)).failed).toEqual([]);
    expect(existsSync(plistPath(home))).toBe(false);
  });

  test("restores a pre-existing plist byte-identically", () => {
    const original = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>\n";
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(home), original);
    const lc = fakeLaunchctl();
    installLaunchd(opts(lc.run));
    uninstallLaunchd(opts(lc.run));
    expect(readFileSync(plistPath(home), "utf8")).toBe(original);
  });

  test("uninstall → reinstall → uninstall stops at the newest created write", () => {
    const lc = fakeLaunchctl();
    installLaunchd(opts(lc.run));
    installLaunchd(opts(lc.run, { port: 4400 }));
    uninstallLaunchd(opts(lc.run));
    installLaunchd(opts(lc.run));
    expect(uninstallLaunchd(opts(lc.run))).toEqual({ removed: [plistPath(home)], failed: [], warnings: [] });
    expect(existsSync(plistPath(home))).toBe(false);
  });

  test("a hand-edited plist is reported as failed, never clobbered", () => {
    const lc = fakeLaunchctl();
    installLaunchd(opts(lc.run));
    writeFileSync(plistPath(home), "edited by hand\n");
    const out = uninstallLaunchd(opts(lc.run));
    expect(out.failed.map((f) => f.path)).toEqual([plistPath(home)]);
    expect(readFileSync(plistPath(home), "utf8")).toBe("edited by hand\n");
  });

  test("nothing installed is a clean no-op", () => {
    const lc = fakeLaunchctl();
    expect(uninstallLaunchd(opts(lc.run))).toEqual({ removed: [], failed: [], warnings: [] });
    expect(lc.verbs()).toEqual([]);
  });
});

describe("/health supervision status", () => {
  const app = (supervisor?: "launchd" | "none") =>
    createRoutes({ repo: {} as never, gate: async () => new Response(null, { status: 403 }), machineId: "m", supervisor });

  test("reports launchd when supervised", async () => {
    expect(await (await app("launchd").request("/health")).json()).toEqual({ ok: true, supervisor: "launchd" });
  });

  test("defaults to none", async () => {
    expect(await (await app().request("/health")).json()).toEqual({ ok: true, supervisor: "none" });
  });
});
