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

// Pure-extractor helpers: assert kind/summary/sensitivity straight off `extractClaudeCode` with no DB
// round-trip. Sensitivity is fixed at extraction (the store persists it unchanged), so these are exact for
// the classification/floor/ordering checks that don't need the read path.
const CTX = { sourcePath: "/x/y.jsonl", byteOffset: 0 };
const extract = (event: unknown) => extractClaudeCode(event, CTX);
/** The single crumb a lone `tool_use` block produces. */
const tuCrumb = (name: string, input: Record<string, unknown>) => extract(assistant([toolUse(name, input)]))[0]!;

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
    // The full crumb-kind sequence for this fixture — a real invariant (prompt → edit → tool-call), unlike the
    // former `every(kind !== "session-end")` which was vacuous (that kind is never emitted on the raw lane).
    expect(crumbs.map((c) => c.kind)).toEqual(["user-prompt", "file-edit", "tool-call"]);
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

  test("a STRING result is digested via the string-result surface (is_error is NOT consulted on this branch)", async () => {
    const path = writeJsonl("t.jsonl", [
      assistant([toolUse("Bash", { command: "bun run build", description: "typecheck" })]),
      // A string toolUseResult hits `resultDigest`'s FIRST branch, which never looks at is_error — so it
      // digests as an error signal even though the sibling tool_result block here is NOT flagged is_error.
      // (The is_error-driven OBJECT branch is covered separately below.)
      toolResult("Error: Exit code 1\nsrc/x.ts(9,3): error TS2322: Type mismatch"),
    ]);
    await tailFile(deps(), path);
    const digest = (await summaries()).find((s) => s.startsWith("→"));
    expect(digest).toBe("→ Error: Exit code 1"); // exact: firstLine of the string, `→ `-prefixed, clipped
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

// ── A: toolSummary — every tool family + the two default branches ──────────────

describe("A — toolSummary covers every tool family with exact one-liners", () => {
  test("file-edit families are lean basenames; MultiEdit shares Edit's return", () => {
    const edit = tuCrumb("Edit", { file_path: "/a/b/foo.ts", old_string: "x", new_string: "y" });
    const multi = tuCrumb("MultiEdit", { file_path: "/a/b/foo.ts", edits: [{ old_string: "x", new_string: "y" }] });
    expect(edit).toMatchObject({ kind: "file-edit", summary: "Edit foo.ts" });
    expect(multi).toMatchObject({ kind: "file-edit", summary: "Edit foo.ts" }); // identical shape — locks the shared return
    expect(multi.summary).toBe(edit.summary);
    expect(tuCrumb("Write", { file_path: "/a/b/bar.ts" })).toMatchObject({ kind: "file-edit", summary: "Write bar.ts" });
    expect(tuCrumb("NotebookEdit", { notebook_path: "/a/b/analysis.ipynb" })).toMatchObject({ kind: "file-edit", summary: "Edit analysis.ipynb" });
  });

  test("read + search families — Read / Glob / Grep", () => {
    expect(tuCrumb("Read", { file_path: "/p/schema.ts" })).toMatchObject({ kind: "tool-call", summary: "Read schema.ts" });
    expect(tuCrumb("Glob", { pattern: "**/*.ts" })).toMatchObject({ kind: "tool-call", summary: "Glob **/*.ts" });
    expect(tuCrumb("Grep", { pattern: "TODO" })).toMatchObject({ kind: "tool-call", summary: "Grep TODO" });
  });

  test("delegation families — Agent / Task / Skill", () => {
    expect(tuCrumb("Agent", { subagent_type: "Explore", description: "find the bug" }).summary).toBe("Agent[Explore]: find the bug");
    expect(tuCrumb("Task", { description: "ship the feature" }).summary).toBe("Task: ship the feature");
    expect(tuCrumb("Skill", { skill: "review" }).summary).toBe("Skill: review"); // note: Skill applies no clip
  });

  test("messaging + tool-discovery families — SendMessage / ToolSearch", () => {
    expect(tuCrumb("SendMessage", { to: "reviewer", content: "please look" }).summary).toBe("SendMessage → reviewer: please look");
    expect(tuCrumb("ToolSearch", { query: "notebook edit" }).summary).toBe("ToolSearch: notebook edit");
  });

  test("the two default branches — an mcp__ prefix and an unknown tool name", () => {
    expect(tuCrumb("mcp__context7__query-docs", { query: "zod discriminated union" }).summary).toBe("mcp__context7__query-docs: zod discriminated union");
    expect(tuCrumb("mcp__context7__resolve-library-id", { libraryName: "zod" }).summary).toBe("mcp__context7__resolve-library-id: zod"); // the `?? i.libraryName` fallback
    expect(tuCrumb("TotallyUnknownTool", { whatever: 1 })).toMatchObject({ kind: "tool-call", summary: "TotallyUnknownTool" }); // bare name
  });
});

// ── B: resultDigest branches (agent / object-isError / bare scalar) ────────────

describe("B — resultDigest branch coverage", () => {
  test("a subagent result digests to an agent verdict pointer (string / array / empty content / agentId)", () => {
    const [strC] = extract(toolResult({ agentType: "code-reviewer", content: "LGTM ship it\nsecond line" }));
    expect(strC).toMatchObject({ kind: "note", summary: "→ agent[code-reviewer]: LGTM ship it", sensitivity: "personal" });

    const [arrC] = extract(toolResult({ agentType: "reviewer", content: [{ type: "text", text: "first block" }, { type: "text", text: "second block" }] }));
    expect(arrC!.summary).toBe("→ agent[reviewer]: first block second block"); // array-content blocks joined with a space

    const [doneC] = extract(toolResult({ agentType: "reviewer" }));
    expect(doneC!.summary).toBe("→ agent[reviewer] done"); // absent content → " done" fallback (a space, no colon)

    const [idC] = extract(toolResult({ agentId: "sub-1", content: "did the thing" }));
    expect(idC!.summary).toBe("→ agent[?]: did the thing"); // agentId triggers the branch; agentType absent → "?"
  });

  test("the is_error OBJECT branch digests a Bash-shaped result as an error signal", () => {
    // { stdout, stderr, interrupted } with the SIBLING tool_result block flagged is_error → the object branch
    // (distinct from the string-result surface above).
    const [crumb] = extract(toolResult({ stdout: "", stderr: "boom: compile failed\nmore detail", interrupted: false }, { isError: true }));
    expect(crumb).toMatchObject({ kind: "note", summary: "→ error: boom: compile failed", sensitivity: "personal" });

    // Fallback sub-branch: stderr empty → the digest detail comes from stdout's first line (`stderr || stdout`).
    const [fromStdout] = extract(toolResult({ stdout: "fatal: not a git repo\ntrace", stderr: "", interrupted: false }, { isError: true }));
    expect(fromStdout!.summary).toBe("→ error: fatal: not a git repo");
  });

  test("a bare-scalar result (0 / false) passes the call-site guard but yields no digest crumb", () => {
    // `ev.toolUseResult != null` is TRUE for 0 and false, so branch 2 calls resultDigest — which declines
    // (not a string, not an object) and returns null, so no crumb is emitted.
    expect(extract(toolResult(0))).toEqual([]);
    expect(extract(toolResult(false))).toEqual([]);
  });
});

// ── C: assistant text-block narration ─────────────────────────────────────────

describe("C — an assistant text block becomes a note, ordered among tool_use blocks", () => {
  test("mixed text + tool_use: text → note (personal), slot order preserved", async () => {
    const path = writeJsonl("t.jsonl", [assistant([
      { type: "text", text: "Now I'll run the tests." },
      toolUse("Bash", { command: "bun test", description: "run tests" }),
    ])]);
    await tailFile(deps(), path);
    const crumbs = await repo.queryBreadcrumbs(PROJECT, 0, "");
    expect(crumbs.map((c) => c.kind)).toEqual(["note", "tool-call"]); // text (slot 0) precedes tool_use (slot 1)
    expect(crumbs[0]).toMatchObject({ kind: "note", summary: "Now I'll run the tests.", sensitivity: "personal" });
    expect(crumbs[1]!.summary).toBe("Bash: run tests");
  });
});

// ── D: secret classification (the security-critical set) ──────────────────────

describe("D — secret shapes classify as secret and redact through the read path", () => {
  // [label, secret] — each embedded in a user prompt. A MISS here is a real code bug: report it, don't weaken.
  const SECRETS: Array<[string, string]> = [
    ["classic sk- key", "OPENAI_FIXTURE_REDACTED"],
    ["Anthropic sk-ant- key", "ANTHROPIC_FIXTURE_REDACTED"],
    ["OpenAI project sk-proj- key (dashed — Codex #2)", "OPENAI_PROJ_FIXTURE_REDACTED"],
    ["OpenAI service-account sk-svcacct- key", "OPENAI_SVCACCT_FIXTURE_REDACTED"],
    ["Stripe sk_live_ key", `sk_live_${"0123456789".repeat(2)}`],
    ["GitHub ghp_ token", `ghp_${"0123456789".repeat(3)}abcd`],
    ["GitHub github_pat_ token", "GITHUB_PAT_FIXTURE_REDACTED"],
    ["AWS AKIA key", "AKIAIOSFODNN7EXAMPLE"], // AKIA + exactly 16 [0-9A-Z]
    ["Google AIza key", `AIza${"0123456789".repeat(3)}01234`], // AIza + exactly 35 chars
    ["Slack xox token", "SLACK_FIXTURE_REDACTED"],
    // Synthetic JWT — clearly fake (header {"alg":"none"}, payload {"synthetic":true}, obvious sig) but still
    // matches the JWT shape the classifier keys on, so it exercises the pattern without a real-looking token.
    ["JWT (synthetic)", "eyJhbGciOiJub25lIn0.eyJzeW50aGV0aWMiOnRydWV9.NOT_A_REAL_TOKEN_synthetic_fixture_0000"],
    ["postgres conn-string", "postgres://user:pass@db.example.com:5432/app"],
    ["Authorization Bearer header", "Authorization: Bearer abc123.def456.ghi789"],
    ["PEM private-key header", "-----BEGIN RSA PRIVATE KEY-----"],
    ["prefixed-identifier assignment (boundary regression)", "DATABASE_PASSWORD=hunter2"],
  ];
  for (const [label, secret] of SECRETS) {
    test(`classifies ${label} as secret and redact() masks it`, async () => {
      const path = writeJsonl("t.jsonl", [userPrompt(`context ${secret} here`)]);
      await tailFile(deps(), path);
      const [crumb] = await repo.queryBreadcrumbs(PROJECT, 0, "");
      expect(crumb).toBeDefined();
      expect(crumb!.sensitivity).toBe("secret"); // capture-time classification escalated it
      const masked = redact(crumb!, Breadcrumb);
      expect(masked.summary).toBe("[redacted:secret]"); // secret-effective → masked at the default threshold
      expect(masked.summary).not.toContain(secret);
    });
  }

  test("a secret in a Bash command (no description) escalates the crumb but never leaks into the summary", async () => {
    const secret = `ghp_${"0123456789".repeat(3)}abcd`;
    // No description → the summary is the command's FIRST line only; the secret sits on line 2, so it is
    // absent from the summary — yet toolCrumb classifies on the RAW input, so the crumb is still secret.
    const path = writeJsonl("t.jsonl", [assistant([toolUse("Bash", { command: `echo starting\nexport TOKEN=${secret}` })])]);
    await tailFile(deps(), path);
    const [crumb] = await repo.queryBreadcrumbs(PROJECT, 0, "");
    expect(crumb!.summary).toBe("Bash: echo starting");
    expect(crumb!.summary).not.toContain(secret);
    expect(crumb!.sensitivity).toBe("secret");
  });

  test("a secret in a Write payload escalates the file-edit crumb but never leaks into the summary", async () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    const path = writeJsonl("t.jsonl", [assistant([toolUse("Write", { file_path: "/p/.env", content: `SESSION_KEY=${secret}\n` })])]);
    await tailFile(deps(), path);
    const [crumb] = await repo.queryBreadcrumbs(PROJECT, 0, "");
    expect(crumb!.summary).toBe("Write .env"); // lean basename — the payload (and its secret) is never in the summary
    expect(crumb!.summary).not.toContain(secret);
    expect(crumb!.sensitivity).toBe("secret"); // file-edit floor is "path", escalated to secret on the raw input
  });
});

// ── E: non-secret sensitivity floors ──────────────────────────────────────────

describe("E — non-secret sensitivity floors", () => {
  test("file-edit crumbs (Edit / Write) floor at 'path' when no secret is present", () => {
    expect(tuCrumb("Edit", { file_path: "/p/foo.ts", old_string: "a", new_string: "b" }).sensitivity).toBe("path");
    expect(tuCrumb("Write", { file_path: "/p/bar.ts", content: "plain content, no secret" }).sensitivity).toBe("path");
  });

  test("tool-call / note / user-prompt crumbs floor at 'personal' when no secret is present", () => {
    expect(tuCrumb("Bash", { command: "ls -la", description: "list files" }).sensitivity).toBe("personal");
    expect(tuCrumb("Read", { file_path: "/p/x.ts" }).sensitivity).toBe("personal");
    expect(extract(assistant([{ type: "text", text: "let me think about this" }]))[0]!.sensitivity).toBe("personal");
    expect(extract(userPrompt("a normal directive"))[0]!.sensitivity).toBe("personal");
  });
});

// ── F: multi-byte UTF-8 byte accuracy (tailer core invariant) ──────────────────

describe("F — the cursor is a BYTE offset, so multi-byte content resumes exactly", () => {
  test("a multi-byte line advances the cursor by byte length, and a later line resumes without desync", async () => {
    const line1 = JSON.stringify(userPrompt("deploy 🚀 the café build")); // 🚀 = 4 bytes, é = 2 bytes
    const line2 = JSON.stringify(userPrompt("second 🎉 prompt"));
    // Split line2 inside its ASCII header (`{"uuid":`) so no surrogate pair is bisected — the emoji stays whole
    // in `tail`. A naive UTF-16 `.length` cursor would mis-place the resume because line1 is multi-byte.
    const head = line2.slice(0, 8);
    const tail = line2.slice(8);

    const path = join(root, "utf8.jsonl");
    writeFileSync(path, `${line1}\n${head}`); // line1 complete + a partial line2

    const w1 = await tailFile(deps(), path);
    expect(w1).toBe(1); // only the complete line1
    const consumed = `${line1}\n`;
    expect(await repo.readCaptureCursor(path)).toBe(Buffer.byteLength(consumed)); // BYTES, not UTF-16 units
    expect(Buffer.byteLength(consumed)).toBeGreaterThan(consumed.length); // proof: multi-byte really is present
    expect(await summaries()).toEqual(["deploy 🚀 the café build"]);

    appendFileSync(path, `${tail}\n`); // the rest of line2 arrives
    const w2 = await tailFile(deps(), path);
    expect(w2).toBe(1);
    expect(await summaries()).toEqual(["deploy 🚀 the café build", "second 🎉 prompt"]); // resumed exactly, no desync
    expect(await repo.readCaptureCursor(path)).toBe(Buffer.byteLength(`${line1}\n${line2}\n`)); // final byte EOF
  });
});

// ── G: tailer resilience ──────────────────────────────────────────────────────

describe("G — tailer resilience (nonexistent / dir-trap / truncation / mid-sweep / empty machineId)", () => {
  test("tailFile on a nonexistent path returns 0 and does not throw", async () => {
    expect(await tailFile(deps(), join(root, "nope", "ghost.jsonl"))).toBe(0);
  });

  test("tailAll over a nonexistent path returns 0 and does not throw", async () => {
    expect(await tailAll(deps(), [join(root, "nope", "ghost.jsonl")])).toBe(0);
  });

  test("discoverTranscripts skips a DIRECTORY named *.jsonl and still returns real transcripts", () => {
    const projRoot = join(root, "projects");
    const good = join(projRoot, "-good");
    const trap = join(projRoot, "-trap");
    mkdirSync(good, { recursive: true });
    mkdirSync(join(trap, "notafile.jsonl"), { recursive: true }); // a directory whose name ends in .jsonl
    writeFileSync(join(good, "real.jsonl"), "");
    const found = discoverTranscripts(projRoot);
    expect(found).toContain(join(good, "real.jsonl")); // the good file still surfaces
    expect(found).not.toContain(join(trap, "notafile.jsonl")); // the .jsonl directory is filtered out (isFile)
  });

  test("a file truncated below the cursor resets and re-tails the new, shorter content", async () => {
    const path = writeJsonl("t.jsonl", [userPrompt("original line one is fairly long"), userPrompt("original line two is fairly long")]);
    expect(await tailFile(deps(), path)).toBe(2);
    const cursorAfter = await repo.readCaptureCursor(path);

    const shortLine = JSON.stringify(userPrompt("brand new short line"));
    writeFileSync(path, `${shortLine}\n`); // rewrite SHORTER than the persisted cursor (rotate/rewrite)
    expect(statSync(path).size).toBeLessThan(cursorAfter!); // precondition: really shrank below the cursor

    expect(await tailFile(deps(), path)).toBe(1); // reset to 0, re-tailed the reclaimed range
    expect(await summaries()).toContain("brand new short line"); // the new content was NOT lost
    expect(await repo.readCaptureCursor(path)).toBe(statSync(path).size); // cursor reset to the new EOF
  });

  test("a faulting file mid-sweep does not abort tailAll — files ordered after it still tail", async () => {
    const pGood = writeJsonl("good1.jsonl", [userPrompt("good one", { cwd: "/good1" })]);
    const pPoison = writeJsonl("poison.jsonl", [userPrompt("poison", { cwd: "/poison" })]);
    const pGood2 = writeJsonl("good2.jsonl", [userPrompt("good two", { cwd: "/good2" })]);
    // A store whose breadcrumb write throws for exactly the poison project — a deterministic per-file fault.
    const poisonDeps: TailerDeps = {
      machineId: MACHINE,
      extractor: extractClaudeCode,
      repo: { ...repo, writeBreadcrumb: async (b) => { if (b.project === "/poison") throw new Error("boom"); return repo.writeBreadcrumb(b); } },
    };
    const total = await tailAll(poisonDeps, [pGood, pPoison, pGood2]);
    expect(total).toBe(2); // good1 + good2; the poison file aborted only itself
    expect(await summaries("/good1")).toEqual(["good one"]);
    expect(await summaries("/good2")).toEqual(["good two"]); // ordered AFTER poison — the sweep continued
    expect(await summaries("/poison")).toEqual([]); // poison's crumb never landed
    expect(await repo.readCaptureCursor(pPoison)).toBeNull(); // its cursor stayed un-advanced (retried next sweep)
  });

  test("tailFile with an empty machineId throws and leaves the cursor un-advanced", async () => {
    const path = writeJsonl("t.jsonl", [userPrompt("would be dropped")]);
    const badDeps: TailerDeps = { repo, extractor: extractClaudeCode, machineId: "" };
    await expect(tailFile(badDeps, path)).rejects.toThrow(/empty machineId/);
    expect(await repo.readCaptureCursor(path)).toBeNull(); // never reached the cursor write
  });

  test("tailAll with an empty machineId swallows the throw — 0 crumbs, cursor un-advanced, no throw", async () => {
    const path = writeJsonl("t.jsonl", [userPrompt("healthy line")]);
    const badDeps: TailerDeps = { repo, extractor: extractClaudeCode, machineId: "" };
    expect(await tailAll(badDeps, [path])).toBe(0); // caught + logged, not thrown
    expect(await summaries()).toEqual([]);
    expect(await repo.readCaptureCursor(path)).toBeNull();
  });
});

// ── H: >=100-block ordering (the slot-width fix) ───────────────────────────────

describe("H — an assistant event with >=100 blocks keeps emission order in the trail", () => {
  test("105 blocks read back in exact emission order (slot zero-padded to 3, so '100' sorts after '099')", async () => {
    const N = 105;
    const blocks = Array.from({ length: N }, (_, n) => toolUse("Read", { file_path: `/p/f${String(n).padStart(3, "0")}.ts` }));
    const path = writeJsonl("t.jsonl", [assistant(blocks)]);
    await tailFile(deps(), path);
    const expected = Array.from({ length: N }, (_, n) => `Read f${String(n).padStart(3, "0")}.ts`);
    expect(await summaries()).toEqual(expected); // slot width 3 keeps "#100" after "#099"; the old width-2 stopped at 12
  });
});

// ── J: missing-sessionId guard ────────────────────────────────────────────────

describe("J — a well-formed, typed, timestamped event with NO sessionId yields no crumbs", () => {
  test("extractClaudeCode returns [] when sessionId is absent", () => {
    const noSession = { type: "user", cwd: PROJECT, timestamp: new Date(1_720_000_000_000).toISOString(), message: { role: "user", content: "orphaned prompt" } };
    expect(extract(noSession)).toEqual([]);
  });
});

// ── K: extractor / contract failures are file-fatal (Codex cross-model gate) ───

describe("K — extractor/contract failures abort the file pass, cursor un-advanced (no lost crumbs)", () => {
  test("a throwing extractor propagates; the cursor is NOT advanced past the un-extracted line", async () => {
    const path = writeJsonl("t.jsonl", [userPrompt("a valid, well-formed transcript line")]);
    const throwing: TailerDeps = { repo, machineId: MACHINE, extractor: () => { throw new Error("extractor drift"); } };
    await expect(tailFile(throwing, path)).rejects.toThrow("extractor drift");
    expect(await repo.readCaptureCursor(path)).toBeNull(); // un-advanced → the valid line is retried, not lost
    expect((await repo.queryBreadcrumbs(PROJECT, 0, "")).length).toBe(0);
  });

  test("an extractor yielding a contract-invalid crumb aborts the pass, cursor un-advanced", async () => {
    const path = writeJsonl("t.jsonl", [userPrompt("a valid, well-formed transcript line")]);
    // ts:-1 typechecks (number) but fails the schema's nonnegative() — a stand-in for ANY extractor-produced
    // crumb that violates the contract. Like a throw, it must abort the pass, not be silently skipped past.
    const badCrumb: TailerDeps = {
      repo,
      machineId: MACHINE,
      extractor: () => [{ id: "x#p", project: PROJECT, sessionId: "s", source: "claude-code", kind: "note", summary: "x", ts: -1, sensitivity: "personal" }],
    };
    await expect(tailFile(badCrumb, path)).rejects.toThrow(/invalid breadcrumb/);
    expect(await repo.readCaptureCursor(path)).toBeNull();
    expect((await repo.queryBreadcrumbs(PROJECT, 0, "")).length).toBe(0);
  });

  test("an in-place rewrite to a different length is detected at the line boundary and re-tailed (Codex #3)", async () => {
    const path = writeJsonl("t.jsonl", [userPrompt("the original session line")]);
    expect(await tailFile(deps(), path)).toBe(1);
    expect(await repo.readCaptureCursor(path)).toBeGreaterThan(0);
    // Rewrite in place with DIFFERENT, longer content (a genuine rewrite, not an append): the old cursor now
    // lands mid-line in the new bytes, so file[cursor-1] is no longer the '\n' the append-only invariant needs.
    writeFileSync(path, `${JSON.stringify(userPrompt("a completely different and noticeably longer rewritten line, brand new content"))}\n`);
    const written = await tailFile(deps(), path);
    expect(written).toBeGreaterThan(0); // reset to 0 + re-tailed, NOT silently skipped past
    expect((await summaries()).some((s) => s.includes("completely different"))).toBe(true);
  });

  // OUT OF CONTRACT (append-only violated) — documents the U5-R2 residual, NOT a fix. The no-lost-crumbs
  // guarantee is scoped to append-only inputs, which Claude Code satisfies (per-session files only grow;
  // --resume copies events verbatim to a NEW path). This locks the KNOWN first-write-wins behavior so a future
  // change to the store's ON CONFLICT DO NOTHING is forced to revisit U5-R2.
  test("[out-of-contract] a same-UUID in-place rewrite is first-write-wins — the rewrite is NOT reflected", async () => {
    const UUID = "reused-uuid-1";
    const path = writeJsonl("t.jsonl", [userPrompt("ORIGINAL content", { uuid: UUID })]);
    expect(await tailFile(deps(), path)).toBe(1);
    // Same uuid, different + longer content, rewritten in place. The boundary check DETECTS it and re-tails
    // from 0 — but the re-derived crumb id (from the reused uuid) collides with the first row, so the store's
    // per-id idempotent append keeps ORIGINAL. (A real generation-aware fix at U8 would write a fresh row.)
    writeFileSync(path, `${JSON.stringify(userPrompt("REWRITTEN much longer different brand-new content here", { uuid: UUID }))}\n`);
    await tailFile(deps(), path);
    const trail = await summaries();
    expect(trail.length).toBe(1); // same id → no new row written
    expect(trail[0]).toContain("ORIGINAL"); // first-write-wins: the stale row is kept
    expect(trail[0]).not.toContain("REWRITTEN");
  });
});
