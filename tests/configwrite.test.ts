import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { AppliedButUnjournaledError, deepMerge, listUndo, MERGE_NOOP, mergeConfig, removeConfigKeys, undo } from "../src/configwrite/index";
import { backupsDir, journalPath } from "../src/configwrite/internal";

// Each test gets an isolated workspace: `configs/` holds the target files a caller mutates, `data/`
// is the injected dataDir where backups + the journal land. The two are separate dirs on purpose —
// it lets the "read-only directory" test freeze the config dir while backups still land in data.
let root: string;
let configsDir: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-"));
  configsDir = join(root, "configs");
  dataDir = join(root, "data");
  mkdirSync(configsDir);
});

afterEach(() => {
  // A test may have frozen configsDir to 0500 to force a write failure — thaw before cleanup.
  try {
    chmodSync(configsDir, 0o700);
  } catch {
    /* already gone */
  }
  rmSync(root, { recursive: true, force: true });
});

function seed(name: string, content: string): string {
  const path = join(configsDir, name);
  writeFileSync(path, content);
  return path;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function bakCount(): number {
  const dir = backupsDir(dataDir);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".bak")).length : 0;
}

// ── merge-don't-clobber across all three formats (R11, U14 scenario 1) ────────────

describe("merge preserves unrelated keys across formats", () => {
  test("JSON: unrelated + nested keys survive", () => {
    const target = seed("settings.json", JSON.stringify({ a: 1, nested: { x: 1 } }, null, 2) + "\n");
    mergeConfig(target, { b: 2, nested: { y: 2 } }, { dataDir });
    expect(JSON.parse(read(target))).toEqual({ a: 1, b: 2, nested: { x: 1, y: 2 } });
  });

  test("TOML: bare keys and existing table members survive", () => {
    const target = seed("config.toml", 'keep = 1\n[table]\ninner = "a"\n');
    mergeConfig(target, { added: 2, table: { inner2: "b" } }, { dataDir });
    expect(parseToml(read(target))).toEqual({ keep: 1, added: 2, table: { inner: "a", inner2: "b" } });
  });

  test("YAML: unrelated + nested keys survive", () => {
    const target = seed("config.yaml", "keep: 1\nnested:\n  x: 1\n");
    mergeConfig(target, { added: 2, nested: { y: 2 } }, { dataDir });
    expect(parseYaml(read(target))).toEqual({ keep: 1, added: 2, nested: { x: 1, y: 2 } });
  });
});

// ── backup discipline (R11, U14 scenario 2) ───────────────────────────────────────

test("a byte-exact backup is written 0600 before the target changes", () => {
  const original = JSON.stringify({ a: 1 }, null, 2) + "\n";
  const target = seed("settings.json", original);

  const result = mergeConfig(target, { b: 2 }, { dataDir });

  expect(result.backupPath).not.toBeNull();
  expect(existsSync(result.backupPath!)).toBe(true);
  expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
  // The backup holds the PRE-mutation bytes, exactly…
  expect(read(result.backupPath!)).toBe(original);
  // …while the target now holds the merged result.
  expect(JSON.parse(read(target))).toEqual({ a: 1, b: 2 });
});

// ── undo restores byte-identically (R11, VS4 seed, U14 scenario 3) ─────────────────

test("undo restores the target's exact bytes and original mode", () => {
  // Deliberately hand-formatted (4-space, trailing spaces) to prove the restore is raw bytes, not a
  // reserialize — our engine would otherwise rewrite this as 2-space JSON.
  const original = '{\n    "a": 1,\n    "keep": "me"\n}\n';
  const target = seed("settings.json", original);
  chmodSync(target, 0o644);

  const result = mergeConfig(target, { b: 2 }, { dataDir });
  expect(read(target)).not.toBe(original); // it really did change

  undo(result.undoId!, dataDir);

  expect(read(target)).toBe(original); // byte-identical
  expect(statSync(target).mode & 0o777).toBe(0o644); // original mode restored
});

// ── targetMode: publish a secret-bearing file owner-only (U8 gate fold) ─────────────

test("targetMode publishes a pre-existing looser file as 0600 (no readable window), and undo restores its original mode", () => {
  // A config a user / dotfile tool created 0644, into which a caller (the Codex installer) embeds a secret.
  const target = seed("config.toml", 'model = "x"\n');
  chmodSync(target, 0o644);

  const result = mergeConfig(target, { added: 1 }, { dataDir, targetMode: 0o600 });
  // PUBLISHED owner-only: the engine chmods the temp to targetMode BEFORE the rename and never tightens after,
  // so the token-bearing file is never on disk at 0644 (final mode == published mode, no transient window).
  expect(statSync(target).mode & 0o777).toBe(0o600);

  // The journal still recorded the ORIGINAL mode, so undo returns the file to its pre-install permissions.
  undo(result.undoId!, dataDir);
  expect(statSync(target).mode & 0o777).toBe(0o644);
});

test("without targetMode a pre-existing file's mode is preserved (non-secret configs are never force-tightened)", () => {
  const target = seed("settings.json", JSON.stringify({ a: 1 }, null, 2) + "\n");
  chmodSync(target, 0o644);
  mergeConfig(target, { b: 2 }, { dataDir });
  expect(statSync(target).mode & 0o777).toBe(0o644); // unchanged — the default preserves the caller's mode
});

// ── failure mid-write leaves the original intact (R11, U14 scenario 4) ─────────────

test("a write that fails mid-flight leaves the original file untouched and cleans up", () => {
  // Assumes a non-root runner: root ignores directory permission bits.
  const original = JSON.stringify({ a: 1 }, null, 2) + "\n";
  const target = seed("settings.json", original);

  // Freeze the config dir read-only: the backup (into dataDir) still succeeds, but writing the sibling
  // temp file fails — exercising the cleanup path that must remove the just-made backup.
  chmodSync(configsDir, 0o500);
  expect(() => mergeConfig(target, { b: 2 }, { dataDir })).toThrow();
  chmodSync(configsDir, 0o700); // thaw so we can inspect

  expect(read(target)).toBe(original); // original never touched
  expect(bakCount()).toBe(0); // the orphaned backup was rolled back
  expect(listUndo(dataDir)).toEqual([]); // nothing journaled for a write that didn't land
});

test("a corrupt existing config aborts before writing anything (fail closed)", () => {
  const corrupt = "{ this is not valid json";
  const target = seed("settings.json", corrupt);

  expect(() => mergeConfig(target, { a: 1 }, { dataDir })).toThrow(/failed to parse/);

  expect(read(target)).toBe(corrupt); // untouched
  expect(bakCount()).toBe(0);
  expect(listUndo(dataDir)).toEqual([]);
});

// ── idempotency: a no-op write has NO side effects (R11, U14 scenario 5) ────────────

test("double-provision is idempotent — no second write, backup, or journal entry", () => {
  const target = seed("settings.json", JSON.stringify({ a: 1 }, null, 2) + "\n");

  const first = mergeConfig(target, { b: 2 }, { dataDir });
  expect(first.noop).toBe(false);
  const afterFirst = read(target);

  // Re-merging the same patch is a true no-op: no write, no undo id, no backup.
  const second = mergeConfig(target, { b: 2 }, { dataDir });
  expect(second.noop).toBe(true);
  expect(second.undoId).toBeNull();
  expect(second.backupPath).toBeNull();

  // An empty patch is likewise a no-op.
  expect(mergeConfig(target, {}, { dataDir }).noop).toBe(true);

  expect(read(target)).toBe(afterFirst); // bytes unchanged across the repeats
  expect(listUndo(dataDir).length).toBe(1); // only the first, real write was journaled
  expect(bakCount()).toBe(1); // and only one backup exists
});

// ── array-replace is a documented, tested contract (guards the U6 hooks footgun) ────

test("array values are replaced wholesale, not appended or index-merged", () => {
  const target = seed("settings.json", JSON.stringify({ list: [1, 2, 3], keep: true }, null, 2) + "\n");
  mergeConfig(target, { list: [9] }, { dataDir });
  expect(JSON.parse(read(target))).toEqual({ list: [9], keep: true });
});

// ── new-file creation + its undo (deletes rather than restores) ─────────────────────

test("a new file is created, and its undo deletes it (idempotently)", () => {
  const target = join(configsDir, "new.json");
  expect(existsSync(target)).toBe(false);

  const result = mergeConfig(target, { a: 1 }, { dataDir });
  expect(result.created).toBe(true);
  expect(result.noop).toBe(false);
  expect(result.backupPath).toBeNull(); // nothing to back up
  expect(JSON.parse(read(target))).toEqual({ a: 1 });
  expect(listUndo(dataDir).length).toBe(1);

  undo(result.undoId!, dataDir);
  expect(existsSync(target)).toBe(false); // create undone by deletion

  expect(() => undo(result.undoId!, dataDir)).not.toThrow(); // idempotent double-undo
});

// ── format detection ────────────────────────────────────────────────────────────────

describe("format handling", () => {
  test(".yml is treated as YAML", () => {
    const target = seed("config.yml", "a: 1\n");
    mergeConfig(target, { b: 2 }, { dataDir });
    expect(parseYaml(read(target))).toEqual({ a: 1, b: 2 });
  });

  test("an explicit format overrides the (absent) extension", () => {
    const target = seed("rc", JSON.stringify({ a: 1 }) + "\n");
    mergeConfig(target, { b: 2 }, { dataDir, format: "json" });
    expect(JSON.parse(read(target))).toEqual({ a: 1, b: 2 });
  });

  test("an unknown extension with no override throws", () => {
    const target = seed("notes.txt", "hello");
    expect(() => mergeConfig(target, { a: 1 }, { dataDir })).toThrow(/cannot infer format/);
  });
});

// ── journal robustness + prototype-pollution guard (safety-utility hardening) ────────

test("listUndo skips malformed journal lines but keeps the good entries", () => {
  const target = seed("settings.json", JSON.stringify({ a: 1 }, null, 2) + "\n");
  const result = mergeConfig(target, { b: 2 }, { dataDir }); // one valid entry

  const path = journalPath(dataDir);
  appendFileSync(path, "this is not json\n"); // torn line
  appendFileSync(path, JSON.stringify({ id: "x" }) + "\n"); // JSON but fails schema

  const entries = listUndo(dataDir);
  expect(entries.length).toBe(1);
  expect(entries[0]!.id).toBe(result.undoId!);
  expect(() => undo(result.undoId!, dataDir)).not.toThrow(); // the good entry still resolves
});

test("deepMerge ignores prototype-pollution keys", () => {
  // Guards RUNTIME prototype pollution (the security property) — NOT disk-level key stripping. A nested
  // __proto__ under a fresh key can still serialize to a config file (harmless GIGO); what must never
  // happen is the actual prototype being mutated. JSON.parse makes __proto__ an own key here.
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "b": 2}');
  const merged = deepMerge({ a: 1 }, hostile) as Record<string, unknown>;

  expect(merged.a).toBe(1);
  expect(merged.b).toBe(2);
  expect((merged as { polluted?: unknown }).polluted).toBeUndefined(); // not inherited
  expect(({} as { polluted?: unknown }).polluted).toBeUndefined(); // Object.prototype untouched
});

// ── parse errors never leak file content / secrets into the thrown error (security S1) ──

test("a parse error never leaks file content into the thrown error", () => {
  const secret = "sk-ant-SECRET-do-not-leak";

  // TOML: a bare invalid line right after a secret-bearing line — the raw parser message would frame it.
  const toml = seed("config.toml", `token = "${secret}"\nthis is not valid toml\n`);
  let tomlErr = "";
  try {
    mergeConfig(toml, { added: 1 }, { dataDir });
  } catch (e) {
    tomlErr = (e as Error).message;
  }
  expect(tomlErr).toMatch(/failed to parse/);
  expect(tomlErr).not.toContain(secret);

  // YAML: an unclosed flow sequence right after a secret-bearing line.
  const yaml = seed("config.yaml", `token: ${secret}\nbroken: [unclosed\n`);
  let yamlErr = "";
  try {
    mergeConfig(yaml, { added: 1 }, { dataDir });
  } catch (e) {
    yamlErr = (e as Error).message;
  }
  expect(yamlErr).toMatch(/failed to parse/);
  expect(yamlErr).not.toContain(secret);
});

// ── the patch must be a plain object — fail closed before any file work (correctness C1) ──

describe("mergeConfig rejects a non-object patch before touching the file", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", [1, 2, 3]],
    ["a scalar", 42],
  ])("rejects %s without clobbering or writing", (_label, patch) => {
    const original = JSON.stringify({ keep: true }, null, 2) + "\n";
    const target = seed("settings.json", original);

    expect(() => mergeConfig(target, patch, { dataDir })).toThrow(/patch must be a plain object/);
    expect(read(target)).toBe(original); // untouched — no silent whole-config clobber
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });
});

// ── idempotency holds for TOML/YAML too, not just JSON — the no-op short-circuit depends on each
//    serializer's round-trip being byte-stable (TOML is Codex's config.toml, re-provisioned per session) ──

describe("double-provision is a true no-op across formats (serializer round-trip is byte-stable)", () => {
  test.each([
    ["config.toml", 'keep = 1\n[table]\ninner = "a"\n', { added: 2, table: { inner2: "b" } }],
    ["config.yaml", "keep: 1\nnested:\n  x: 1\n", { added: 2, nested: { y: 2 } }],
  ] as const)("%s: re-merging the same patch neither rewrites nor re-backs-up", (name, seedContent, patch) => {
    const target = seed(name, seedContent);

    const first = mergeConfig(target, patch, { dataDir });
    expect(first.noop).toBe(false);
    const afterFirst = read(target);

    const second = mergeConfig(target, patch, { dataDir });
    expect(second.noop).toBe(true); // fails loudly if the serializer round-trip is not byte-stable
    expect(second.undoId).toBeNull();

    expect(read(target)).toBe(afterFirst);
    expect(listUndo(dataDir).length).toBe(1);
    expect(bakCount()).toBe(1);
  });
});

// ── undo is safe against later writes — never blindly clobbers (adversarial U14-F1) ──

test("undo refuses to roll back once a later write has diverged the target", () => {
  const target = seed("settings.json", JSON.stringify({ a: 1 }, null, 2) + "\n");

  const first = mergeConfig(target, { b: 2 }, { dataDir }); // write A → {a,b}
  mergeConfig(target, { c: 3 }, { dataDir }); // write B → {a,b,c}; target no longer matches A

  // Undoing A now would silently discard B — refuse instead of clobbering.
  expect(() => undo(first.undoId!, dataDir)).toThrow(/refusing to clobber|changed since/);
  expect(JSON.parse(read(target))).toEqual({ a: 1, b: 2, c: 3 }); // B survives untouched
});

test("undo of the latest write succeeds and restores the prior state", () => {
  const target = seed("settings.json", JSON.stringify({ a: 1 }, null, 2) + "\n");

  mergeConfig(target, { b: 2 }, { dataDir }); // A → {a,b}
  const second = mergeConfig(target, { c: 3 }, { dataDir }); // B → {a,b,c}

  undo(second.undoId!, dataDir); // undoing the latest is safe (target still matches B)
  expect(JSON.parse(read(target))).toEqual({ a: 1, b: 2 }); // back to A's state
});

test("undo is idempotent on the restore branch — a second undo is a clean no-op", () => {
  const target = seed("settings.json", JSON.stringify({ a: 1 }, null, 2) + "\n");
  const result = mergeConfig(target, { b: 2 }, { dataDir });

  undo(result.undoId!, dataDir); // target now holds the restored backup, not the post-image
  const afterFirst = read(target);
  expect(() => undo(result.undoId!, dataDir)).not.toThrow(); // currentHash === hash(backup) → no-op
  expect(read(target)).toBe(afterFirst); // unchanged
});

// ── symlinked config targets are refused (adversarial U14-F2: don't replace the link) ──

test("refuses to write through a symlinked target (fail closed)", () => {
  const real = seed("real.json", JSON.stringify({ a: 1 }, null, 2) + "\n");
  const link = join(configsDir, "link.json");
  symlinkSync(real, link);

  expect(() => mergeConfig(link, { b: 2 }, { dataDir })).toThrow(/symlink/);
  expect(JSON.parse(read(real))).toEqual({ a: 1 }); // the real file behind the link is untouched
});

// ── a torn journal tail can't swallow the next entry (adversarial G3-b) ──

test("recordUndo isolates a torn journal tail so a later entry still survives", () => {
  const target = seed("settings.json", JSON.stringify({ a: 1 }, null, 2) + "\n");
  const first = mergeConfig(target, { b: 2 }, { dataDir }); // one clean entry

  // Simulate a crash that left a partial, newline-less final line at the end of the journal.
  appendFileSync(journalPath(dataDir), '{"id":"torn","partial');

  // A later write must still produce a discoverable entry despite the torn tail.
  const target2 = seed("other.json", JSON.stringify({ x: 1 }, null, 2) + "\n");
  const second = mergeConfig(target2, { y: 2 }, { dataDir });

  const ids = listUndo(dataDir).map((e) => e.id);
  expect(ids).toContain(first.undoId!); // the earlier clean entry is intact
  expect(ids).toContain(second.undoId!); // and the later one survived the torn tail
});

// ══════════════════════════════════════════════════════════════════════════════════
// removeConfigKeys — targeted removal (U14 extension, issue #21): the reverse of merge,
// same backup → atomic-write → journal discipline, for uninstalling from a diverged live config.
// ══════════════════════════════════════════════════════════════════════════════════

describe("removeConfigKeys deletes keys at dotted paths across all three formats", () => {
  test("JSON: a nested key is removed, siblings + unrelated keys preserved", () => {
    const target = seed(
      "settings.json",
      JSON.stringify({ mcpServers: { "agent-os": { url: "x" }, other: { url: "y" } }, keep: 1 }, null, 2) + "\n",
    );
    const res = removeConfigKeys(target, ["mcpServers.agent-os"], { dataDir });
    expect(res.noop).toBe(false);
    expect(JSON.parse(read(target))).toEqual({ mcpServers: { other: { url: "y" } }, keep: 1 });
  });

  test("TOML: a nested table is removed, sibling table + bare key survive", () => {
    const target = seed("config.toml", 'keep = 1\n[mcp_servers.agent-os]\nurl = "x"\n\n[mcp_servers.other]\nurl = "y"\n');
    removeConfigKeys(target, ["mcp_servers.agent-os"], { dataDir });
    expect(parseToml(read(target))).toEqual({ keep: 1, mcp_servers: { other: { url: "y" } } });
  });

  test("YAML: a nested key is removed, siblings survive", () => {
    const target = seed("config.yaml", "keep: 1\nservers:\n  agent-os:\n    url: x\n  other:\n    url: y\n");
    removeConfigKeys(target, ["servers.agent-os"], { dataDir });
    expect(parseYaml(read(target))).toEqual({ keep: 1, servers: { other: { url: "y" } } });
  });
});

describe("removeConfigKeys handles array-element removal (the real uninstall need: strip OUR entry)", () => {
  test("a whole array element is removed by numeric index; the others shift down", () => {
    const target = seed("settings.json", JSON.stringify({ list: ["a", "b", "c"] }, null, 2) + "\n");
    removeConfigKeys(target, ["list.1"], { dataDir });
    expect(JSON.parse(read(target))).toEqual({ list: ["a", "c"] });
  });

  test("a key nested UNDER an array element is removed via a numeric path segment", () => {
    const target = seed(
      "settings.json",
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "m", drop: true }] } }, null, 2) + "\n",
    );
    removeConfigKeys(target, ["hooks.SessionStart.0.drop"], { dataDir });
    expect(JSON.parse(read(target))).toEqual({ hooks: { SessionStart: [{ matcher: "m" }] } });
  });

  test("an out-of-range index is a no-op (never throws, never touches a neighbor)", () => {
    const target = seed("settings.json", JSON.stringify({ list: ["a"] }, null, 2) + "\n");
    expect(removeConfigKeys(target, ["list.5"], { dataDir }).noop).toBe(true);
    expect(JSON.parse(read(target))).toEqual({ list: ["a"] });
  });
});

// ── resolve-then-mutate: multiple paths into ONE array target the ORIGINALS, not shifted positions (#4) ──

describe("removeConfigKeys resolves every path before mutating (multi-path same-array correctness)", () => {
  test("two numeric paths into the SAME array remove exactly the ORIGINAL elements named", () => {
    // [a,b,c] minus original indices 0 and 2 = [b]. The old sequential-splice code left [b,c]: the second
    // splice mis-targeted after the first had shifted everything down. Resolve-then-splice-descending fixes it.
    const target = seed("settings.json", JSON.stringify({ list: ["a", "b", "c"] }, null, 2) + "\n");
    removeConfigKeys(target, ["list.0", "list.2"], { dataDir });
    expect(JSON.parse(read(target))).toEqual({ list: ["b"] });
  });

  test("adjacent indices 0 and 1 remove the two named originals, not a shifted pair", () => {
    // [a,b,c] minus original 0 and 1 = [c]. Sequential splicing removed a then (post-shift) c, wrongly leaving [b].
    const target = seed("settings.json", JSON.stringify({ list: ["a", "b", "c"] }, null, 2) + "\n");
    removeConfigKeys(target, ["list.0", "list.1"], { dataDir });
    expect(JSON.parse(read(target))).toEqual({ list: ["c"] });
  });

  test("mixed object-key and array-index paths in one call each hit their original target", () => {
    const target = seed(
      "settings.json",
      JSON.stringify({ mcpServers: { "agent-os": { url: "x" }, other: { url: "y" } }, list: ["a", "b", "c"] }, null, 2) + "\n",
    );
    removeConfigKeys(target, ["mcpServers.agent-os", "list.0", "list.2"], { dataDir });
    expect(JSON.parse(read(target))).toEqual({ mcpServers: { other: { url: "y" } }, list: ["b"] });
  });

  test("a path resolving THROUGH a sibling another path removes still lands (references fixed up front)", () => {
    // Remove arr[0] AND a key inside arr[2]. Under sequential mutation, splicing arr[0] shifts arr[2]→arr[1],
    // so `arr.2.z` would walk off the end and z would survive. Resolve-first captures arr[2]'s object in pass 1.
    const target = seed("settings.json", JSON.stringify({ arr: [{ x: 1 }, { y: 2 }, { z: 3, keep: 4 }] }, null, 2) + "\n");
    removeConfigKeys(target, ["arr.0", "arr.2.z"], { dataDir });
    expect(JSON.parse(read(target))).toEqual({ arr: [{ y: 2 }, { keep: 4 }] });
  });
});

// ── array-index segments are canonical-decimal only — Number()'s coercions never resolve to an index (#5) ──

describe("removeConfigKeys array-index segment canonicalization", () => {
  // Each non-canonical final segment reaches arrayIndex (the container IS an array) and must be a non-numeric
  // dead end — a no-op leaving the array untouched — NOT silently coerced by Number() into a real index
  // ("0x1"→1, "1e1"→10, "01"→1, " 1"→1, ""→0, "-1"→-1).
  test.each([
    ["empty string", ""],
    ["hex 0x1", "0x1"],
    ["exponential 1e1", "1e1"],
    ["negative -1", "-1"],
    ["leading-zero 01", "01"],
    ["whitespace ' 1'", " 1"],
  ])("segment (%s) is a no-op, never coerced to an index", (_label, segment) => {
    const target = seed("settings.json", JSON.stringify({ list: ["a", "b"] }, null, 2) + "\n");
    const res = removeConfigKeys(target, [`list.${segment}`], { dataDir });
    expect(res.noop).toBe(true); // nothing resolved → no write
    expect(JSON.parse(read(target))).toEqual({ list: ["a", "b"] }); // array untouched
  });

  test("canonical index '0' removes the first element", () => {
    const target = seed("settings.json", JSON.stringify({ list: ["a", "b"] }, null, 2) + "\n");
    removeConfigKeys(target, ["list.0"], { dataDir });
    expect(JSON.parse(read(target))).toEqual({ list: ["b"] });
  });

  test("a multi-digit canonical index ('10') resolves and removes that element", () => {
    const list = Array.from({ length: 11 }, (_, i) => `i${i}`); // i0..i10
    const target = seed("settings.json", JSON.stringify({ list }, null, 2) + "\n");
    removeConfigKeys(target, ["list.10"], { dataDir });
    expect(JSON.parse(read(target)).list).toEqual(Array.from({ length: 10 }, (_, i) => `i${i}`)); // i10 gone, rest intact
  });
});

test("undo of a removal restores the removed key byte-identically", () => {
  const original = JSON.stringify({ a: 1, gone: { x: 2 } }, null, 2) + "\n";
  const target = seed("settings.json", original);

  const res = removeConfigKeys(target, ["gone"], { dataDir });
  expect(JSON.parse(read(target))).toEqual({ a: 1 }); // removed

  undo(res.undoId!, dataDir);
  expect(read(target)).toBe(original); // the byte-exact backup re-adds exactly what was removed
});

test("a removal that fails mid-write leaves the original file untouched and cleans up", () => {
  // Assumes a non-root runner: root ignores directory permission bits. Mirrors the mergeConfig failure test —
  // proves removeConfigKeys shares the same rollback path (the extracted `publish` core).
  const original = JSON.stringify({ a: 1, gone: 2 }, null, 2) + "\n";
  const target = seed("settings.json", original);

  chmodSync(configsDir, 0o500); // the backup (into dataDir) still succeeds, but the sibling temp write fails
  expect(() => removeConfigKeys(target, ["gone"], { dataDir })).toThrow();
  chmodSync(configsDir, 0o700);

  expect(read(target)).toBe(original); // original never touched
  expect(bakCount()).toBe(0); // the orphaned backup was rolled back
  expect(listUndo(dataDir)).toEqual([]); // nothing journaled for a removal that didn't land
});

test("removing an absent key is a no-op; a double-remove is idempotent (no second write/backup/journal)", () => {
  const target = seed("settings.json", JSON.stringify({ a: 1, gone: 2 }, null, 2) + "\n");

  const first = removeConfigKeys(target, ["gone"], { dataDir });
  expect(first.noop).toBe(false);

  // The key is already gone → re-removing it is a true no-op.
  const second = removeConfigKeys(target, ["gone"], { dataDir });
  expect(second.noop).toBe(true);
  expect(second.undoId).toBeNull();
  expect(second.backupPath).toBeNull();

  // A never-present key is likewise a no-op.
  expect(removeConfigKeys(target, ["never-existed"], { dataDir }).noop).toBe(true);

  expect(listUndo(dataDir).length).toBe(1); // only the first, real removal was journaled
  expect(bakCount()).toBe(1);
});

// ── double-remove idempotence holds for TOML/YAML too, not just JSON — the no-op short-circuit depends on each
//    serializer's round-trip being byte-stable on the REMOVE path (TOML is Codex's live config.toml). ──

describe("removeConfigKeys double-remove is a true no-op for TOML and YAML (per-serializer round-trip stability)", () => {
  test.each([
    ["config.toml", 'keep = 1\n[mcp_servers.agent-os]\nurl = "x"\n', "mcp_servers.agent-os"],
    ["config.yaml", "keep: 1\nservers:\n  agent-os:\n    url: x\n", "servers.agent-os"],
  ] as const)("%s: the second remove writes nothing, backs up nothing, journals nothing", (name, seedContent, path) => {
    const target = seed(name, seedContent);

    const first = removeConfigKeys(target, [path], { dataDir });
    expect(first.noop).toBe(false);
    const afterFirst = read(target);

    const second = removeConfigKeys(target, [path], { dataDir });
    expect(second.noop).toBe(true); // fails loudly if the serializer round-trip is not byte-stable after a remove
    expect(second.undoId).toBeNull();
    expect(second.backupPath).toBeNull();

    expect(read(target)).toBe(afterFirst);
    expect(listUndo(dataDir).length).toBe(1);
    expect(bakCount()).toBe(1);
  });
});

// ── absent-key removal is a TRUE no-op even on a FOREIGN-formatted file: removeKeys reports an actually-deleted
//    flag and publish short-circuits BEFORE serialize, so a delete that matches nothing never re-serializes (and
//    thus never reformats / strips comments from) a live config an owner also hand-edits (adversarial U14 gate). ──

describe("removeConfigKeys leaves a foreign-formatted file byte-for-byte unchanged when no target key resolves", () => {
  test("JSON: a 4-space-indent file with only foreign keys is NOT reformatted by removing an absent key", () => {
    // A settings.json a dotfile tool wrote 4-space (NOT our 2-space serializer output), holding none of ours.
    // Re-serializing it for a delete that removes nothing would rewrite it to canonical layout, spawn a backup
    // + journal entry, and falsely report it in `removed`. The no-op short-circuit prevents all of that.
    const foreign = JSON.stringify({ foreign: { a: 1 }, other: 2 }, null, 4) + "\n";
    const target = seed("settings.json", foreign);

    const res = removeConfigKeys(target, ["mcpServers.agent-os"], { dataDir });

    expect(res.noop).toBe(true);
    expect(res.undoId).toBeNull();
    expect(res.backupPath).toBeNull();
    expect(read(target)).toBe(foreign); // byte-for-byte unchanged — never reformatted
    expect(bakCount()).toBe(0); // no backup
    expect(listUndo(dataDir)).toEqual([]); // no journal entry
  });

  test("TOML: a commented, hand-formatted file with no agent-os key is left byte-for-byte intact", () => {
    // smol-toml DROPS comments on reserialize, so re-serializing for an absent-key delete would strip this
    // owner's comments + inline notes — the exact damage the no-op short-circuit prevents on Codex's config.toml.
    const foreign = '# my Codex config\nmodel = "gpt-5.5"  # inline note\n\n[tui]\ntheme = "dark"\n';
    const target = seed("config.toml", foreign);

    const res = removeConfigKeys(target, ["mcp_servers.agent-os"], { dataDir });

    expect(res.noop).toBe(true);
    expect(res.undoId).toBeNull();
    expect(res.backupPath).toBeNull();
    expect(read(target)).toBe(foreign); // comments + hand formatting survive untouched
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });

  test("a PRESENT key IS still removed from a commented TOML (the delete path is unchanged for a real match)", () => {
    // The short-circuit fires ONLY when nothing resolves. A key that DOES resolve is removed as before — comments
    // are lost to the inherent parse-reserialize (the byte-exact backup makes it reversible), so we assert only
    // the removal + noop:false here, NOT comment survival.
    const target = seed(
      "config.toml",
      '# my Codex config\nkeep = 1\n\n[mcp_servers.agent-os]\nurl = "x"\n\n[mcp_servers.other]\nurl = "y"\n',
    );

    const res = removeConfigKeys(target, ["mcp_servers.agent-os"], { dataDir });

    expect(res.noop).toBe(false); // a real match → a real write
    expect(parseToml(read(target))).toEqual({ keep: 1, mcp_servers: { other: { url: "y" } } }); // our table gone, sibling kept
  });
});

// ── missing-leaf exactness (#29): a path whose PARENT exists but whose final key does NOT must resolve to
//    nothing, so the removal never re-serializes (and thus never reformats) a foreign-formatted live config.
//    Distinct from the parent-ABSENT case above, which the walk already dead-ended before the final segment. ──

describe("removeConfigKeys missing-leaf exactness (#29 — parent present, leaf absent)", () => {
  test("JSON: a 4-space file whose mcpServers holds ONLY foreign servers is NOT reformatted by removing our absent leaf", () => {
    // The parent (`mcpServers`) EXISTS but our leaf (`agent-os`) does not — the parent-exists/leaf-absent case the
    // old unconditional object-delete got wrong: it queued a phantom delete, flipped `deleted` true, and
    // re-serialized this 4-space file to our 2-space layout for a removal that removed nothing.
    const foreign = JSON.stringify({ mcpServers: { other: { url: "y" } }, keep: 1 }, null, 4) + "\n";
    const target = seed("settings.json", foreign);

    const res = removeConfigKeys(target, ["mcpServers.agent-os"], { dataDir });

    expect(res.noop).toBe(true);
    expect(res.undoId).toBeNull();
    expect(res.backupPath).toBeNull();
    expect(read(target)).toBe(foreign); // byte-for-byte unchanged — never reformatted
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });

  test("TOML: a commented, hand-formatted file whose mcp_servers holds ONLY a foreign table is left byte-for-byte intact", () => {
    // Parent-present/leaf-absent on TOML: `mcp_servers` exists (a foreign table) but `agent-os` doesn't. smol-toml
    // DROPS comments on reserialize, so the old phantom delete would strip this owner's comments for a no-match delete.
    const foreign = '# my Codex config\nmodel = "gpt-5.5"  # inline note\n\n[mcp_servers.foreign]\nurl = "y"\n';
    const target = seed("config.toml", foreign);

    const res = removeConfigKeys(target, ["mcp_servers.agent-os"], { dataDir });

    expect(res.noop).toBe(true);
    expect(res.undoId).toBeNull();
    expect(res.backupPath).toBeNull();
    expect(read(target)).toBe(foreign); // comments + hand formatting survive untouched
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });

  test("one present + one absent-leaf path in the SAME call: the present key is removed, the absent leaf ignored (deleted-dominance)", () => {
    const target = seed(
      "settings.json",
      JSON.stringify({ mcpServers: { "agent-os": { url: "x" }, other: { url: "y" } } }, null, 2) + "\n",
    );

    // `mcpServers.agent-os` resolves (removed); `mcpServers.nope` is an absent leaf (skipped). Because at least one
    // path resolved, the write proceeds — and the absent leaf is simply a no-op, never a phantom delete.
    const res = removeConfigKeys(target, ["mcpServers.agent-os", "mcpServers.nope"], { dataDir });

    expect(res.noop).toBe(false);
    expect(JSON.parse(read(target))).toEqual({ mcpServers: { other: { url: "y" } } });
  });

  test("an own key whose value is null is still present and IS removed (hasOwn, not truthiness)", () => {
    const target = seed("settings.json", JSON.stringify({ gone: null, keep: 1 }, null, 2) + "\n");

    // `gone` is falsy but PRESENT — `hasOwn` resolves it; a truthiness check would wrongly skip it and no-op.
    const res = removeConfigKeys(target, ["gone"], { dataDir });

    expect(res.noop).toBe(false);
    expect(JSON.parse(read(target))).toEqual({ keep: 1 });
  });
});

// ── fail-closed presence (#30): the ONE `statTarget` decision. An INDETERMINATE lookup (EACCES on an
//    unreadable parent) must THROW, never read as absence — a removal would fake a clean no-op leaving our
//    registration live; a merge would route an unreadable existing config to the create path. A dangling
//    symlink is caught as a symlink (refusal), never as absence. ──

describe("removeConfigKeys / mergeConfig fail closed on an indeterminate presence lookup (#30)", () => {
  test("removeConfigKeys THROWS when the target's parent dir is unreadable (EACCES is indeterminate, never a clean no-op)", () => {
    // Assumes a non-root runner: root ignores directory permission bits. 0o000 (no search bit) makes lstat(target)
    // fail EACCES — indeterminate, NOT ENOENT-absent. Old code's existsSync-false read that as absence and returned
    // a clean noop:true (leaving our registration live); the unified statTarget rethrows the EACCES instead.
    const dir = join(configsDir, "locked-remove");
    mkdirSync(dir);
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ mcpServers: { "agent-os": { url: "x" } } }, null, 2) + "\n");
    chmodSync(dir, 0o000);
    try {
      expect(() => removeConfigKeys(target, ["mcpServers.agent-os"], { dataDir })).toThrow();
      expect(bakCount()).toBe(0); // threw at the presence check — before any backup/journal side effect
      expect(listUndo(dataDir)).toEqual([]);
    } finally {
      chmodSync(dir, 0o700); // restore so afterEach's recursive rm can traverse back in
    }
  });

  test("mergeConfig THROWS on an unreadable-parent target instead of clobber-creating it (fail-closed presence)", () => {
    // existsSync-false would have routed this UNREADABLE existing config to the create path; statTarget rethrows the
    // indeterminate EACCES so we never temp+rename-clobber a file we could not read. (Both regimes throw here — the
    // old write also failed EACCES — so this pins the CONTRACT; #30's behavior change is proven by the removal test above.)
    const dir = join(configsDir, "locked-merge");
    mkdirSync(dir);
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ a: 1 }, null, 2) + "\n");
    chmodSync(dir, 0o000);
    try {
      expect(() => mergeConfig(target, { b: 2 }, { dataDir })).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("removeConfigKeys throws the symlink refusal on a DANGLING symlink target (caught as a symlink, not read as absence)", () => {
    // A dangling symlink: lstat SUCCEEDS (so statTarget classifies it as a symlink and refuses), while existsSync
    // FOLLOWS it to the missing target and reports false. Presence must key off lstat, so this refuses — it must
    // never be mistaken for ENOENT-absence (which would silently no-op and leave the live symlinked target behind).
    const link = join(configsDir, "dangling.json");
    symlinkSync(join(configsDir, "no-such-target.json"), link);
    expect(existsSync(link)).toBe(false); // existsSync follows the link → false; must NOT read as absence

    expect(() => removeConfigKeys(link, ["anything"], { dataDir })).toThrow(/symlink/);
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });
});

test("removing from a target that doesn't exist is a no-op that creates nothing", () => {
  const target = join(configsDir, "absent.json");
  expect(existsSync(target)).toBe(false);

  const res = removeConfigKeys(target, ["anything"], { dataDir });
  expect(res.noop).toBe(true);
  expect(res.created).toBe(false);
  expect(existsSync(target)).toBe(false); // a removal must NEVER create a file
  expect(listUndo(dataDir)).toEqual([]);
});

test("removeConfigKeys refuses a symlinked target (shares the engine's fail-closed guard)", () => {
  const realFile = seed("real.json", JSON.stringify({ a: 1, gone: 2 }, null, 2) + "\n");
  const link = join(configsDir, "link.json");
  symlinkSync(realFile, link);

  expect(() => removeConfigKeys(link, ["gone"], { dataDir })).toThrow(/symlink/);
  expect(JSON.parse(read(realFile))).toEqual({ a: 1, gone: 2 }); // the real file behind the link is untouched
});

test("a __proto__ / constructor segment in a remove path is refused (no prototype walk)", () => {
  const target = seed("settings.json", JSON.stringify({ a: 1 }, null, 2) + "\n");

  // Forbidden segments are skipped, so the removal resolves to nothing — a no-op — and never mutates the prototype.
  expect(removeConfigKeys(target, ["__proto__.polluted", "constructor.x"], { dataDir }).noop).toBe(true);
  expect(JSON.parse(read(target))).toEqual({ a: 1 });
  expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
});

// ══════════════════════════════════════════════════════════════════════════════════
// mergeConfig callback patch — the RMW reads the engine's OWN parse (closes the double-read)
// ══════════════════════════════════════════════════════════════════════════════════

describe("mergeConfig callback patch (current) => patch", () => {
  test("the callback receives the current parsed config and its result is merged", () => {
    const target = seed("settings.json", JSON.stringify({ list: [1, 2], keep: true }, null, 2) + "\n");

    // Read-modify-write the array from the value the callback is HANDED — not a separate pre-read — so a
    // concurrent write landing before the engine's read is included, not reverted.
    const res = mergeConfig(
      target,
      (current: unknown) => {
        const list = ((current as { list?: number[] }).list ?? []).slice();
        list.push(3);
        return { list };
      },
      { dataDir },
    );

    expect(res.noop).toBe(false);
    expect(JSON.parse(read(target))).toEqual({ list: [1, 2, 3], keep: true });
  });

  test("the callback receives undefined for a target that doesn't exist yet", () => {
    const target = join(configsDir, "created-via-callback.json");
    let received: unknown = "sentinel";

    mergeConfig(
      target,
      (current: unknown) => {
        received = current;
        return { created: true };
      },
      { dataDir },
    );

    expect(received).toBeUndefined(); // no pre-existing config → undefined, mirroring readJson
    expect(JSON.parse(read(target))).toEqual({ created: true });
  });

  test("a callback returning a non-object is rejected after parse, before any write", () => {
    const original = JSON.stringify({ keep: true }, null, 2) + "\n";
    const target = seed("settings.json", original);

    expect(() =>
      mergeConfig(target, () => null as unknown as Record<string, unknown>, { dataDir }),
    ).toThrow(/patch must be a plain object/);

    expect(read(target)).toBe(original); // untouched — no partial write from a bad callback
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// mergeConfig replaceSubtrees — wholesale-replace an owned subtree (install stale-key cleanup)
// ══════════════════════════════════════════════════════════════════════════════════

describe("mergeConfig replaceSubtrees", () => {
  test("a stale key on a pre-existing owned entry does NOT survive the replace; siblings do", () => {
    const target = seed(
      "claude.json",
      JSON.stringify(
        { mcpServers: { "agent-os": { url: "old", headers: { token: "STALE" } }, other: { url: "keep" } } },
        null,
        2,
      ) + "\n",
    );

    mergeConfig(target, { mcpServers: { "agent-os": { url: "new", headersHelper: "cmd" } } }, {
      dataDir,
      replaceSubtrees: ["mcpServers.agent-os"],
    });

    expect(JSON.parse(read(target))).toEqual({
      mcpServers: { "agent-os": { url: "new", headersHelper: "cmd" }, other: { url: "keep" } },
    });
  });

  test("WITHOUT replaceSubtrees the stale key survives — proving the option is what drops it", () => {
    const target = seed(
      "claude.json",
      JSON.stringify({ mcpServers: { "agent-os": { url: "old", headers: { token: "STALE" } } } }, null, 2) + "\n",
    );

    mergeConfig(target, { mcpServers: { "agent-os": { url: "new", headersHelper: "cmd" } } }, { dataDir });

    // A plain deepMerge re-merges the agent-os subtree, so the stale `headers` lingers (the exact bug #21 fixes).
    expect((JSON.parse(read(target)) as { mcpServers: { "agent-os": { headers?: unknown } } }).mcpServers["agent-os"].headers).toEqual({
      token: "STALE",
    });
  });

  test("replaceSubtrees stays idempotent — re-merging the same value is a true no-op", () => {
    const target = seed("claude.json", JSON.stringify({ mcpServers: { "agent-os": { url: "x" } } }, null, 2) + "\n");
    const patch = { mcpServers: { "agent-os": { url: "x" } } };

    // base already equals the patch → strip-then-remerge reproduces identical bytes → no-op (no churn on re-install).
    expect(mergeConfig(target, patch, { dataDir, replaceSubtrees: ["mcpServers.agent-os"] }).noop).toBe(true);
    expect(listUndo(dataDir)).toEqual([]);
    expect(bakCount()).toBe(0);
  });

  test("a callback patch composes with replaceSubtrees — callback sees the engine's own read; owned subtree replaced fresh", () => {
    const target = seed(
      "claude.json",
      JSON.stringify(
        { mcpServers: { "agent-os": { url: "old", headers: { token: "STALE" } }, other: { url: "keep" } }, list: [1, 2] },
        null,
        2,
      ) + "\n",
    );

    // A primitive captured AT call time — safe from the in-place subtree strip the engine runs AFTER the callback.
    let sawStaleTokenInRead = false;
    const res = mergeConfig(
      target,
      (current: unknown) => {
        const cur = current as { mcpServers?: { "agent-os"?: { headers?: { token?: string } } }; list?: number[] };
        sawStaleTokenInRead = cur.mcpServers?.["agent-os"]?.headers?.token === "STALE";
        const list = (cur.list ?? []).slice();
        list.push(3); // RMW a sibling array from the SAME read the engine merges
        return { mcpServers: { "agent-os": { url: "new", headersHelper: "cmd" } }, list };
      },
      { dataDir, replaceSubtrees: ["mcpServers.agent-os"] },
    );

    expect(res.noop).toBe(false);
    expect(sawStaleTokenInRead).toBe(true); // the callback received the engine's own parsed read (stale key present)
    expect(JSON.parse(read(target))).toEqual({
      // replaceSubtrees dropped the stale `headers`; the sibling `other` and the RMW `list` all composed correctly.
      mcpServers: { "agent-os": { url: "new", headersHelper: "cmd" }, other: { url: "keep" } },
      list: [1, 2, 3],
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// MERGE_NOOP — a transform (or static patch) may ABSTAIN, forcing ZERO filesystem effects (FIX B). This is
// what lets the uninstall hook stripper drop its old presence pre-check: a single engine read whose callback
// abstains when nothing of ours is present, instead of a separate pre-read that could race.
// ══════════════════════════════════════════════════════════════════════════════════

describe("mergeConfig MERGE_NOOP abstain (zero filesystem effects)", () => {
  test("a callback returning MERGE_NOOP leaves an EXISTING foreign-formatted file byte-for-byte (no serialize/backup/journal)", () => {
    // A file a foreign tool wrote 4-space (NOT our 2-space serializer output). A callback that abstains must
    // leave it untouched — publish skips serialize/backup/write/journal entirely, so the foreign layout is never
    // rewritten to our canonical form (the exact damage the uninstall stripper's abstain now prevents at source).
    const foreign = JSON.stringify({ foreign: { a: 1 }, other: 2 }, null, 4) + "\n";
    const target = seed("settings.json", foreign);

    const res = mergeConfig(target, () => MERGE_NOOP, { dataDir });

    expect(res.noop).toBe(true);
    expect(res.undoId).toBeNull();
    expect(res.backupPath).toBeNull();
    expect(read(target)).toBe(foreign); // byte-for-byte unchanged — never reserialized
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });

  test("a callback returning MERGE_NOOP on an ABSENT target creates nothing (abstain short-circuits before the create path)", () => {
    const target = join(configsDir, "absent.json");
    expect(existsSync(target)).toBe(false);

    const res = mergeConfig(target, () => MERGE_NOOP, { dataDir });

    expect(res.noop).toBe(true);
    expect(res.created).toBe(false);
    expect(existsSync(target)).toBe(false); // abstain must NEVER create a file (the short-circuit precedes create)
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });

  test("a STATIC MERGE_NOOP patch abstains identically — no write, no create (a patch may abstain)", () => {
    // The static-patch guard must let MERGE_NOOP through (not reject it as a non-object patch), and publish must
    // then abstain exactly as for the callback form.
    const foreign = JSON.stringify({ a: 1 }, null, 4) + "\n";
    const target = seed("settings.json", foreign);

    const res = mergeConfig(target, MERGE_NOOP, { dataDir });

    expect(res.noop).toBe(true);
    expect(read(target)).toBe(foreign); // unchanged
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// AppliedButUnjournaledError — the atomic rename LANDED but journaling failed (FIX C): a DISTINCT typed error
// so a caller counts the mutation applied (recover from the backup), never as an unapplied failure.
// ══════════════════════════════════════════════════════════════════════════════════

test("a post-commit journal failure throws AppliedButUnjournaledError with the write already applied and the backup kept", () => {
  const original = JSON.stringify({ a: 1 }, null, 2) + "\n";
  const target = seed("settings.json", original);

  // Sabotage journaling WITHOUT breaking the write or the backup: make the undo-journal path a DIRECTORY, so
  // recordUndo's appendFileSync hits EISDIR AFTER the atomic rename has already committed. Backups land in a
  // sibling dir (dataDir/backups), so the byte-exact backup still succeeds — isolating a journal-ONLY failure.
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(journalPath(dataDir));

  let thrown: unknown;
  try {
    mergeConfig(target, { b: 2 }, { dataDir });
  } catch (e) {
    thrown = e;
  }

  expect(thrown).toBeInstanceOf(AppliedButUnjournaledError);
  const err = thrown as AppliedButUnjournaledError;
  expect(err.targetPath).toBe(target);
  expect(err.backupPath).not.toBeNull(); // an existing target → its backup is the recovery path
  // The mutation is LIVE despite the journal failure — a caller must NOT retry it as unapplied.
  expect(JSON.parse(read(target))).toEqual({ a: 1, b: 2 });
  // The backup is KEPT (not rolled back), so the applied write stays recoverable.
  expect(existsSync(err.backupPath!)).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════════════════
// YAML anchor/alias shared-identity guard (adversarial: in-place removal corrupts untargeted paths). A YAML
// `&anchor`/`*alias` makes the parser hand back the SAME JS object under two paths (`a: &x {…}` + `b: *x` → a
// and b are ONE object). removeKeys mutates the parsed tree IN PLACE, so deleting `a.owned` (or splicing an
// aliased array) would ALSO strip `b`'s copy on serialize — untargeted data silently lost. Copy-on-write that
// would make this safe is deferred (issue #32); until then removal semantics FAIL CLOSED on an aliased document.
// ══════════════════════════════════════════════════════════════════════════════════

describe("removeConfigKeys refuses removal on YAML with anchors/aliases (shared identity would corrupt untargeted paths)", () => {
  test("object alias: removing a key under an anchored+aliased node THROWS before any write", () => {
    // `a` and `b` resolve to the SAME object. Deleting `a.owned` in place would strip `b.owned` too, so refuse.
    const original = "a: &x {owned: 1, keep: 2}\nb: *x\n";
    const target = seed("config.yaml", original);

    expect(() => removeConfigKeys(target, ["a.owned"], { dataDir })).toThrow(/anchors\/aliases/);
    expect(read(target)).toBe(original); // untouched — refused right after parse, before backup/write/journal
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });

  test("array alias: removing an element from an anchored+aliased array THROWS before any write", () => {
    // The array is shared between `a` and `b`; an in-place splice under `a` would drop `b`'s element too.
    const original = "a: &x [1, 2, 3]\nb: *x\n";
    const target = seed("config.yaml", original);

    expect(() => removeConfigKeys(target, ["a.0"], { dataDir })).toThrow(/anchors\/aliases/);
    expect(read(target)).toBe(original);
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });

  test("a self-referential (cyclic) alias throws the refusal promptly instead of hanging the detector", () => {
    // `x.self` points back to `x`. The seen-set walk must not recurse into an already-seen node — seeing it
    // again IS the shared-identity signal — so the detector terminates and throws rather than looping forever.
    const original = "x: &a\n  self: *a\n";
    const target = seed("config.yaml", original);

    expect(() => removeConfigKeys(target, ["x.self"], { dataDir })).toThrow(/anchors\/aliases/);
    expect(read(target)).toBe(original);
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });

  test("alias-FREE YAML removal is unaffected — the guard never false-positives on an ordinary document", () => {
    // No anchors → no shared identity → the guard is a no-op and removal proceeds exactly as before.
    const target = seed("config.yaml", "keep: 1\nservers:\n  agent-os:\n    url: x\n  other:\n    url: y\n");
    const res = removeConfigKeys(target, ["servers.agent-os"], { dataDir });
    expect(res.noop).toBe(false);
    expect(parseYaml(read(target))).toEqual({ keep: 1, servers: { other: { url: "y" } } });
  });
});

describe("mergeConfig replaceSubtrees is guarded on aliased YAML, but a plain merge is not (replaceSubtrees runs removeKeys; deepMerge does not)", () => {
  test("replaceSubtrees on aliased YAML THROWS (its removeKeys strip mutates the shared tree in place)", () => {
    // replaceSubtrees strips `a.owned` from the shared node before re-adding it — the same in-place delete that
    // corrupts `b`. Guarded identically to removeConfigKeys.
    const original = "a: &x {owned: 1, keep: 2}\nb: *x\n";
    const target = seed("config.yaml", original);

    expect(() => mergeConfig(target, { a: { owned: 9 } }, { dataDir, replaceSubtrees: ["a.owned"] })).toThrow(
      /anchors\/aliases/,
    );
    expect(read(target)).toBe(original);
    expect(bakCount()).toBe(0);
    expect(listUndo(dataDir)).toEqual([]);
  });

  test("a plain merge (NO replaceSubtrees) on the SAME aliased file still writes — deepMerge builds new trees, never mutating base in place", () => {
    const original = "a: &x {owned: 1, keep: 2}\nb: *x\n";
    const target = seed("config.yaml", original);

    const res = mergeConfig(target, { added: 3 }, { dataDir }); // legitimate write, not a removal → unguarded
    expect(res.noop).toBe(false);

    const parsed = parseYaml(read(target)) as { a: unknown; b: unknown; added: unknown };
    expect(parsed.added).toBe(3);
    // The aliased data survives intact on BOTH paths — the plain merge neither dropped nor corrupted it.
    expect(parsed.a).toEqual({ owned: 1, keep: 2 });
    expect(parsed.b).toEqual({ owned: 1, keep: 2 });
  });
});
