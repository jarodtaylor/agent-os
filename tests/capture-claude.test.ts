import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Breadcrumb } from "../src/contract/index";
import { extractClaudeCode } from "../src/capture/claude-code";
import { discoverTranscripts, tailAll, tailFile, type TailerDeps } from "../src/capture/tailer";
import { redact } from "../src/redact/apply";
import { openDb, type OpenedDb } from "../src/store/db";
import { createRepo, type Repo } from "../src/store/repo";

// Same isolated-real-file-db pattern as tests/store.test.ts: a temp dir per test holding a real sqlite file
// (never :memory:), swept recursively in afterEach. Transcript fixtures are written into the same temp dir.
const MACHINE = "machine-under-test";
const PROJECT = "/Users/jarod/proj";

let root: string;
let opened: OpenedDb;
let repo: Repo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "capture-"));
  opened = openDb(join(root, "test.db"));
  repo = createRepo(opened.db);
});

afterEach(() => {
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

function deps(r: Repo = repo): TailerDeps {
  return { repo: r, extractor: extractClaudeCode, machineId: MACHINE };
}

// ── Fixture builders (JSONL events, faithful to the Claude Code shape) ─────────

let seq = 0;
/** A base event with an increasing uuid + timestamp so trail order is deterministic across events. */
function ev(overrides: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return {
    uuid: `evt-${seq}`,
    sessionId: "sess-1",
    cwd: PROJECT,
    gitBranch: "main",
    timestamp: new Date(1_720_000_000_000 + seq * 1000).toISOString(),
    ...overrides,
  };
}
const userPrompt = (content: string, o: Record<string, unknown> = {}) =>
  ev({ type: "user", message: { role: "user", content }, ...o });
const assistant = (blocks: unknown[], o: Record<string, unknown> = {}) =>
  ev({ type: "assistant", message: { role: "assistant", content: blocks }, ...o });
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: "tu-1", name, input });
const toolResult = (result: unknown, o: { isError?: boolean } & Record<string, unknown> = {}) => {
  const { isError = false, ...rest } = o;
  return ev({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "…", is_error: isError }] },
    toolUseResult: result,
    ...rest,
  });
};

/** Serialize events to a `.jsonl` file. `trailingNewline:false` leaves the last line partial (crash sim). */
function writeJsonl(name: string, events: unknown[], opts: { trailingNewline?: boolean } = {}): string {
  const body = events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n");
  const path = join(root, name);
  writeFileSync(path, opts.trailingNewline === false ? body : `${body}\n`);
  return path;
}

const summaries = async (project = PROJECT): Promise<string[]> =>
  (await repo.queryBreadcrumbs(project, 0, "")).map((b) => b.summary);

// ── Scenario 1: resume from cursor after a restart, no duplicates ─────────────

describe("scenario 1 — resume from the capture cursor across a restart without duplicating", () => {
  test("a reopened db resumes at EOF and re-tailing writes nothing new", async () => {
    const dbFile = join(root, "restart.db");
    const path = writeJsonl("t.jsonl", [
      userPrompt("start U5"),
      assistant([toolUse("Read", { file_path: "/a/schema.ts" })]),
    ]);

    const first = openDb(dbFile);
    const w1 = await tailFile(deps(createRepo(first.db)), path);
    const rows1 = (await createRepo(first.db).queryBreadcrumbs(PROJECT, 0, "")).length;
    first.close();

    // Reopen the SAME file — the cursor persisted in it. A restart must not re-read already-tailed bytes.
    const second = openDb(dbFile);
    const w2 = await tailFile(deps(createRepo(second.db)), path);
    const rows2 = (await createRepo(second.db).queryBreadcrumbs(PROJECT, 0, "")).length;
    second.close();

    expect(w1).toBe(2);
    expect(w2).toBe(0); // cursor at EOF → nothing re-read
    expect(rows2).toBe(rows1);
  });

  test("even a FORCED re-read (cursor reset) dedupes on stable ids — no duplicate rows", async () => {
    const path = writeJsonl("t.jsonl", [userPrompt("directive one"), userPrompt("directive two")]);
    await tailFile(deps(), path);
    const before = (await repo.queryBreadcrumbs(PROJECT, 0, "")).length;

    // Rewind the cursor and tail again: the tailer re-derives crumbs with the SAME ids, and the store's
    // per-id idempotent append collapses them — the region is re-processed but no row is duplicated.
    await repo.writeCaptureCursor(path, 0);
    const reWritten = await tailFile(deps(), path);
    const after = (await repo.queryBreadcrumbs(PROJECT, 0, "")).length;

    expect(reWritten).toBeGreaterThan(0); // it really did re-process the region
    expect(after).toBe(before); // …yet added no rows (idempotent by id)
  });
});

// ── Scenario 2: a malformed line is skipped without killing the tail ──────────

describe("scenario 2 — a malformed JSONL line is skipped; surrounding lines still captured", () => {
  test("garbage between two valid events is dropped, both neighbors survive", async () => {
    const path = writeJsonl("t.jsonl", [
      userPrompt("before the garbage"),
      "{ this is not valid json ]",
      userPrompt("after the garbage"),
    ]);
    const written = await tailFile(deps(), path);

    expect(written).toBe(2);
    expect(await summaries()).toEqual(["before the garbage", "after the garbage"]);
    // The tail did not wedge on the bad line — the cursor advanced to the end of the file.
    expect(await repo.readCaptureCursor(path)).toBe(statSync(path).size);
  });
});

// ── Scenario 3: session → project mapping for a path containing symbols ───────

describe("scenario 3 — project mapping is correct (and lossless) for a path with symbols", () => {
  test("the event's cwd is authoritative — dashes/spaces/parens survive verbatim", async () => {
    const symbolic = "/Users/jarod/Code/my-proj (v2)/agents-os";
    // The transcript lives in a MANGLED dir whose de-mangling would be lossy; cwd must win regardless.
    const mangledDir = join(root, "-Users-jarod-Code-my-proj-v2-agents-os");
    mkdirSync(mangledDir, { recursive: true });
    const path = join(mangledDir, "session.jsonl");
    writeFileSync(path, `${JSON.stringify(userPrompt("work here", { cwd: symbolic }))}\n`);

    await tailFile(deps(), path);
    const crumbs = await repo.queryBreadcrumbs(symbolic, 0, "");
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]!.project).toBe(symbolic); // exact — no dash was mistaken for a separator
  });
});

// ── Scenario 4: crash simulation — no session-end marker still yields a trail ─

describe("scenario 4 — a transcript with no clean session end still yields a trail", () => {
  test("the trail is captured up to the last flushed activity", async () => {
    // No session-end event exists (the raw lane never depends on one). Every line is newline-flushed.
    const path = writeJsonl("crashed.jsonl", [
      userPrompt("implement the tailer"),
      assistant([toolUse("Write", { file_path: "/src/capture/tailer.ts" })]),
      assistant([toolUse("Bash", { command: "bun test", description: "run the suite" })]),
    ]);

    const written = await tailFile(deps(), path);
    const crumbs = await repo.queryBreadcrumbs(PROJECT, 0, "");

    expect(written).toBe(3);
    // Trail ends at the last activity, not at any "session-end" sentinel (there is none).
    expect(crumbs.at(-1)!.summary).toBe("Bash: run the suite");
    expect(crumbs.every((c) => c.kind !== "session-end")).toBe(true);
  });
});

// ── Scenario 5: summaries are human-readable, not raw dumps ────────────────────

describe("scenario 5 — breadcrumbs are legible summaries, never raw dumps", () => {
  test("tool calls, edits and digests read as one-liners with no JSON payloads", async () => {
    const path = writeJsonl("t.jsonl", [
      assistant([toolUse("Bash", { command: "bun test ./x --coverage --bail", description: "Run the test suite" })]),
      toolResult({ stdout: " 164 pass\n 0 fail\n 500 expect() calls", stderr: "", interrupted: false }),
      assistant([toolUse("Edit", { file_path: "/Users/jarod/proj/src/contract/schema.ts", old_string: "a", new_string: "b" })]),
    ]);
    await tailFile(deps(), path);
    const all = await summaries();

    expect(all).toContain("Bash: Run the test suite"); // intent, not the raw command (refinement #2)
    expect(all).toContain("Edit schema.ts"); // lean basename, no hunk gist (refinement #3)
    expect(all).toContain("→ 164 pass, 0 fail"); // digest, not a stdout dump
    for (const s of all) {
      expect(s.length).toBeLessThanOrEqual(241); // clipped, never an unbounded dump
      expect(s).not.toContain('{"'); // no serialized JSON leaked into a summary
    }
  });

  test("many blocks in ONE assistant event keep emission order in the trail (zero-padded ids)", async () => {
    // 12 tool_use blocks share the event's single ts, so their trail order is decided purely by the id
    // suffix — which the store compares as a STRING. Only zero-padding keeps "#10"/"#11" after "#02"; a
    // raw integer suffix would sort them between "#01" and "#02". Files named f00..f11 so the expected
    // sequence is unambiguous.
    const blocks = Array.from({ length: 12 }, (_, n) => toolUse("Read", { file_path: `/p/f${String(n).padStart(2, "0")}.ts` }));
    const path = writeJsonl("t.jsonl", [assistant(blocks)]);
    await tailFile(deps(), path);

    const expected = Array.from({ length: 12 }, (_, n) => `Read f${String(n).padStart(2, "0")}.ts`);
    expect(await summaries()).toEqual(expected); // in-event order preserved: #10/#11 do NOT jump ahead of #02
  });

  test("an Edit RESULT is not digested — git carries the diff (refinement #3)", async () => {
    const path = writeJsonl("t.jsonl", [
      assistant([toolUse("Edit", { file_path: "/p/schema.ts", old_string: "a", new_string: "b" })]),
      toolResult({ filePath: "/p/schema.ts", structuredPatch: [{ lines: ["-a", "+b"] }], originalFile: "a" }),
    ]);
    await tailFile(deps(), path);
    // Exactly the lean edit crumb — the structuredPatch result produced NO additional observation crumb.
    expect(await summaries()).toEqual(["Edit schema.ts"]);
  });
});

// ── Scenario 6: a pasted API key persists secret-marked and redacts ───────────

describe("scenario 6 — a pasted API key is classified secret and redacts through the read path", () => {
  test("the stored crumb is secret and redact() masks its summary", async () => {
    const key = "sk-abcdefghijklmnop1234567890"; // matches sk-[A-Za-z0-9]{16,}
    const path = writeJsonl("t.jsonl", [userPrompt(`use my key ${key} to call the api`)]);
    await tailFile(deps(), path);

    const [crumb] = await repo.queryBreadcrumbs(PROJECT, 0, "");
    expect(crumb).toBeDefined();
    expect(crumb!.sensitivity).toBe("secret"); // capture-time classification escalated it

    // End-to-end: through the SAME choke-point read paths use. Breadcrumb.summary is schema-marked
    // `personal`, so this exercises the maxSensitivity(personal, secret) escalation the contract warns about.
    const masked = redact(crumb!, Breadcrumb);
    expect(masked.summary).toBe("[redacted:secret]");
    expect(masked.summary).not.toContain(key); // the key never survives the read boundary
  });
});

// ── Scenario 7 (spike): a test result is captured as a pass/fail digest ───────

describe("scenario 7 — a bun-test result becomes a digest breadcrumb carrying pass/fail", () => {
  test("the observation layer records counts, not just that Bash ran", async () => {
    const path = writeJsonl("t.jsonl", [
      assistant([toolUse("Bash", { command: "bun test", description: "run the full suite" })]),
      toolResult({ stdout: "bun test v1.3.14\n\n 163 pass\n 1 fail\n 512 expect() calls", stderr: "", interrupted: false }),
    ]);
    await tailFile(deps(), path);
    const all = await summaries();

    // The action crumb AND a distinct observation crumb both exist — direction + observation.
    expect(all).toContain("Bash: run the full suite");
    expect(all).toContain("→ 163 pass, 1 fail");
  });

  test("a non-zero exit / error result is digested as an error signal", async () => {
    const path = writeJsonl("t.jsonl", [
      assistant([toolUse("Bash", { command: "bun run build", description: "typecheck" })]),
      toolResult("Error: Exit code 1\nsrc/x.ts(9,3): error TS2322: Type mismatch", { isError: true }),
    ]);
    await tailFile(deps(), path);
    const digest = (await summaries()).find((s) => s.startsWith("→"));
    expect(digest).toBeDefined();
    expect(digest).toContain("Exit code 1");
  });

  test("an interrupted command is digested as interrupted", async () => {
    const path = writeJsonl("t.jsonl", [
      assistant([toolUse("Bash", { command: "sleep 999", description: "wait" })]),
      toolResult({ stdout: "", stderr: "", interrupted: true }),
    ]);
    await tailFile(deps(), path);
    expect(await summaries()).toContain("→ interrupted");
  });
});

// ── Noise filtering (refinement #5) ────────────────────────────────────────────

describe("noise filtering — command scaffolding and teammate pings are dropped", () => {
  test("only real user prompts survive", async () => {
    const path = writeJsonl("t.jsonl", [
      userPrompt("<command-name>/clear</command-name>"),
      userPrompt("<local-command-caveat>Caveat: messages below were generated…</local-command-caveat>"),
      userPrompt("<task-notification>teammate idle</task-notification>"),
      userPrompt("Okay, let's start U5."),
    ]);
    await tailFile(deps(), path);
    expect(await summaries()).toEqual(["Okay, let's start U5."]);
  });

  test("isMeta events are skipped", async () => {
    const path = writeJsonl("t.jsonl", [
      userPrompt("real prompt"),
      ev({ type: "user", isMeta: true, message: { role: "user", content: "meta bookkeeping" } }),
    ]);
    await tailFile(deps(), path);
    expect(await summaries()).toEqual(["real prompt"]);
  });
});

// ── Edge: empty file, partial trailing line, offset at EOF ─────────────────────

describe("edge cases — empty file, partial trailing line, offset at EOF", () => {
  test("an empty file writes nothing and never records a cursor", async () => {
    const path = writeJsonl("empty.jsonl", [], { trailingNewline: false });
    expect(await tailFile(deps(), path)).toBe(0);
    expect(await repo.readCaptureCursor(path)).toBeNull(); // distinct from an offset of 0
  });

  test("a partial trailing line is dropped, then captured once completed on the next pass", async () => {
    const complete = [userPrompt("first"), userPrompt("second")];
    const third = JSON.stringify(userPrompt("third"));
    const splitAt = Math.floor(third.length / 2);
    const head = third.slice(0, splitAt);
    const tail = third.slice(splitAt);

    // Two complete lines + a partial third (no trailing newline).
    const path = join(root, "partial.jsonl");
    writeFileSync(path, `${complete.map((e) => JSON.stringify(e)).join("\n")}\n${head}`);

    const w1 = await tailFile(deps(), path);
    expect(w1).toBe(2); // only the two COMPLETE lines
    const cursorAfterFirst = await repo.readCaptureCursor(path);
    expect(cursorAfterFirst).toBe(Buffer.byteLength(`${complete.map((e) => JSON.stringify(e)).join("\n")}\n`));

    // The partial line finishes arriving; the next pass picks up exactly the now-complete third line.
    appendFileSync(path, `${tail}\n`);
    const w2 = await tailFile(deps(), path);
    expect(w2).toBe(1);
    expect(await summaries()).toEqual(["first", "second", "third"]);
  });

  test("a second pass with the offset already at EOF writes nothing", async () => {
    const path = writeJsonl("t.jsonl", [userPrompt("only prompt")]);
    expect(await tailFile(deps(), path)).toBe(1);
    expect(await repo.readCaptureCursor(path)).toBe(statSync(path).size);
    expect(await tailFile(deps(), path)).toBe(0); // nothing new
  });
});

// ── Error: missing fields don't crash the tail ────────────────────────────────

describe("error cases — events with missing fields degrade gracefully", () => {
  test("events missing message / timestamp are skipped, valid neighbors captured", async () => {
    const noMessage = ev({ type: "user" }); // no message at all
    const noTimestamp = { type: "user", sessionId: "s", cwd: PROJECT, message: { content: "no ts" } }; // undated
    const good = userPrompt("a real directive");
    const path = writeJsonl("t.jsonl", [noMessage, noTimestamp, good]);

    const written = await tailFile(deps(), path);
    expect(written).toBe(1);
    expect(await summaries()).toEqual(["a real directive"]);
  });

  test("a transient store write failure propagates and leaves the cursor un-advanced (at-least-once)", async () => {
    const path = writeJsonl("t.jsonl", [userPrompt("must persist or retry")]);
    // A store whose breadcrumb write fails transiently (think SQLITE_BUSY) — cursor I/O still works.
    const failing: TailerDeps = {
      machineId: MACHINE,
      extractor: extractClaudeCode,
      repo: { ...repo, writeBreadcrumb: async () => { throw new Error("SQLITE_BUSY"); } },
    };
    // The failure must surface, NOT be swallowed…
    await expect(tailFile(failing, path)).rejects.toThrow("SQLITE_BUSY");
    // …and the cursor must stay put so the next pass re-derives + re-writes the same (idempotent) crumb.
    expect(await repo.readCaptureCursor(path)).toBeNull();
  });

  test("the extractor returns [] (never throws) on junk shapes", () => {
    const ctx = { sourcePath: "/x/y.jsonl", byteOffset: 0 };
    expect(extractClaudeCode(null, ctx)).toEqual([]);
    expect(extractClaudeCode(42, ctx)).toEqual([]);
    expect(extractClaudeCode({ type: "mode", sessionId: "s" }, ctx)).toEqual([]);
    expect(extractClaudeCode({ type: "assistant", timestamp: "2026-07-05T00:00:00Z", sessionId: "s", cwd: "/p" }, ctx)).toEqual([]);
  });
});

// ── tailAll + discoverTranscripts ─────────────────────────────────────────────

describe("tailAll + discoverTranscripts", () => {
  test("discoverTranscripts finds *.jsonl one level deep, ignoring other files", () => {
    const projRoot = join(root, "projects");
    const dirA = join(projRoot, "-Users-jarod-a");
    const dirB = join(projRoot, "-Users-jarod-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, "s1.jsonl"), "");
    writeFileSync(join(dirA, "notes.md"), ""); // not a transcript
    writeFileSync(join(dirB, "s2.jsonl"), "");

    const found = discoverTranscripts(projRoot).sort();
    expect(found).toEqual([join(dirA, "s1.jsonl"), join(dirB, "s2.jsonl")].sort());
  });

  test("discoverTranscripts on a missing root returns []", () => {
    expect(discoverTranscripts(join(root, "does-not-exist"))).toEqual([]);
  });

  test("tailAll tails several files and sums what it wrote", async () => {
    const p1 = writeJsonl("a.jsonl", [userPrompt("in file a", { cwd: "/proj/a" })]);
    const p2 = writeJsonl("b.jsonl", [userPrompt("in file b", { cwd: "/proj/b" })]);
    const total = await tailAll(deps(), [p1, p2]);
    expect(total).toBe(2);
    expect(await summaries("/proj/a")).toEqual(["in file a"]);
    expect(await summaries("/proj/b")).toEqual(["in file b"]);
  });
});
