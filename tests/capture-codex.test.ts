import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureCodex,
  discoverCodexRollouts,
  extractCodex,
  readSessionMeta,
  type CodexSession,
} from "../src/capture/codex";
import { tailFile, type ExtractContext, type TailerDeps } from "../src/capture/tailer";
import { Breadcrumb } from "../src/contract/index";
import { redact } from "../src/redact/apply";
import { openDb, type OpenedDb } from "../src/store/db";
import { createRepo, type Repo } from "../src/store/repo";

// Same isolated-real-file-db pattern as tests/capture-claude.test.ts: a temp dir per test, real sqlite file.
const MACHINE = "machine-under-test";
const PROJECT = "/Users/jarod/proj (v2)/agents-os"; // symbols on purpose — cwd must round-trip verbatim
const SESSION = "019f4468-6ec5-74d3-857a-b3583fdc8269";
const SESS: CodexSession = { project: PROJECT, sessionId: SESSION };
const CTX: ExtractContext = { sourcePath: "/x/rollout.jsonl", byteOffset: 0 };

let root: string;
let opened: OpenedDb;
let repo: Repo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "capture-codex-"));
  opened = openDb(join(root, "test.db"));
  repo = createRepo(opened.db);
});
afterEach(() => {
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

/** Deps whose extractor is bound to the fixed test session (the factory pattern). */
function deps(session: CodexSession = SESS, r: Repo = repo): TailerDeps {
  return { repo: r, extractor: extractCodex(session), machineId: MACHINE };
}

// ── Rollout fixture builders (faithful to the {type, payload, timestamp} envelope) ──

let seq = 0;
function envelope(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return { type, payload, timestamp: new Date(1_720_000_000_000 + seq * 1000).toISOString() };
}
const sessionMeta = (o: Record<string, unknown> = {}) =>
  envelope("session_meta", { id: SESSION, session_id: SESSION, cwd: PROJECT, base_instructions: "…system prompt…", ...o });
const message = (role: string, text: string) =>
  envelope("response_item", { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const funcCall = (name: string, args: Record<string, unknown> | string, id = `fc-${seq}`, callId = `call-${seq}`) =>
  envelope("response_item", { type: "function_call", name, arguments: typeof args === "string" ? args : JSON.stringify(args), id, call_id: callId });
const funcOutput = (output: unknown, callId = `call-${seq}`) =>
  envelope("response_item", { type: "function_call_output", call_id: callId, output });
const reasoning = (text: string) =>
  envelope("response_item", { type: "reasoning", id: `rs-${seq}`, summary: [{ type: "summary_text", text }], encrypted_content: "opaque" });
const eventMsg = (payloadType: string, extra: Record<string, unknown> = {}) => envelope("event_msg", { type: payloadType, ...extra });

/** Serialize events to a rollout `.jsonl`; the caller decides whether to prepend a session_meta line. */
function writeRollout(name: string, events: unknown[]): string {
  const body = events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n");
  const path = join(root, name);
  writeFileSync(path, `${body}\n`);
  return path;
}

const summaries = async (project = PROJECT): Promise<string[]> =>
  (await repo.queryBreadcrumbs(project, 0, "")).map((b) => b.summary);
const boundExtract = (event: unknown) => extractCodex(SESS)(event, CTX);

// ── Stream selection: response_item only; session_meta / event_msg / reasoning skipped ──

describe("stream selection — response_item is canonical; the parallel streams don't double-count", () => {
  test("session_meta, event_msg, turn_context, world_state, and reasoning all yield NO crumb", () => {
    expect(boundExtract(sessionMeta())).toEqual([]);
    expect(boundExtract(eventMsg("user_message", { message: "hello" }))).toEqual([]);
    expect(boundExtract(eventMsg("agent_message", { message: "hi back" }))).toEqual([]);
    expect(boundExtract(eventMsg("token_count", { total: 5 }))).toEqual([]);
    expect(boundExtract(envelope("turn_context", { cwd: PROJECT }))).toEqual([]);
    expect(boundExtract(envelope("world_state", {}))).toEqual([]);
    expect(boundExtract(reasoning("let me think about the seam"))).toEqual([]);
  });

  test("a user prompt present in BOTH response_item and the event_msg mirror is captured ONCE", async () => {
    const prompt = "Register the brain MCP in Codex";
    const path = writeRollout("dup.jsonl", [
      sessionMeta(),
      message("user", prompt), // the canonical item
      eventMsg("user_message", { message: prompt }), // the UI mirror — must NOT produce a second crumb
    ]);
    await tailFile(deps(), path);
    expect(await summaries()).toEqual([prompt]);
  });
});

// ── Messages: real user prompts vs injected context; assistant narration; developer skipped ──

describe("messages — real prompts kept, injected context + developer role filtered", () => {
  test("a real user prompt becomes a user-prompt crumb", () => {
    const [c] = boundExtract(message("user", "Okay, let's do U8."));
    expect(c).toMatchObject({ kind: "user-prompt", summary: "Okay, let's do U8.", source: "codex", project: PROJECT, sessionId: SESSION });
  });

  test("injected user-role content (AGENTS.md / INSTRUCTIONS / permissions / environment) is dropped", () => {
    expect(boundExtract(message("user", "# AGENTS.md instructions for /Users/jarod/.codex\n\n<INSTRUCTIONS>"))).toEqual([]);
    expect(boundExtract(message("user", "<INSTRUCTIONS>\n<!-- codebase-memory-mcp:start -->"))).toEqual([]);
    expect(boundExtract(message("user", "<permissions instructions>\nFilesystem sandboxing…"))).toEqual([]);
    expect(boundExtract(message("user", "<environment_context>cwd=/x</environment_context>"))).toEqual([]);
    // A genuine prompt that merely MENTIONS one of those words is untouched.
    const [kept] = boundExtract(message("user", "update the AGENTS.md instructions please"));
    expect(kept).toMatchObject({ kind: "user-prompt" });
  });

  test("an assistant message becomes a note; developer + system roles are skipped", () => {
    expect(boundExtract(message("assistant", "I'll check the Codex manual first."))[0]).toMatchObject({ kind: "note", summary: "I'll check the Codex manual first." });
    expect(boundExtract(message("developer", "Code discovery: prefer codebase-memory-mcp"))).toEqual([]); // hook-echo injection
    expect(boundExtract(message("system", "you are Codex"))).toEqual([]);
  });
});

// ── Tool calls + outputs ──────────────────────────────────────────────────────

describe("tool calls — exec/patch/read families + the MCP/default branch", () => {
  test("exec_command reads as an Exec action off the cmd field", () => {
    const [c] = boundExtract(funcCall("exec_command", { cmd: "bun test ./x", yield_time_ms: 5000 }));
    expect(c).toMatchObject({ kind: "tool-call", summary: "Exec: bun test ./x" });
  });

  test("apply_patch/write is a lean file-edit; read_file reads as Read; MCP tools keep name + hint", () => {
    expect(boundExtract(funcCall("apply_patch", { path: "/p/src/codex.ts", patch: "@@ -1 +1 @@" }))[0]).toMatchObject({ kind: "file-edit", summary: "Edit codex.ts" });
    expect(boundExtract(funcCall("read_file", { path: "/p/schema.ts" }))[0]).toMatchObject({ kind: "tool-call", summary: "Read schema.ts" });
    expect(boundExtract(funcCall("mcp__context7__query-docs", { query: "zod v4" }))[0]).toMatchObject({ kind: "tool-call", summary: "mcp__context7__query-docs: zod v4" });
    // custom_tool_call carries `input` (not `arguments`) — still summarized.
    const [custom] = boundExtract(envelope("response_item", { type: "custom_tool_call", name: "uidotsh_fetch", input: JSON.stringify({ query: "button" }), id: "ct-1", call_id: "cc-1" }));
    expect(custom).toMatchObject({ kind: "tool-call", summary: "uidotsh_fetch: button" });
  });

  test("a malformed arguments string degrades to a name-only summary, never throws", () => {
    const [c] = boundExtract(funcCall("exec_command", "{ not valid json"));
    expect(c).toMatchObject({ kind: "tool-call" }); // parseArgs → {} → Exec with empty cmd
    expect(c!.summary.startsWith("Exec:")).toBe(true);
  });
});

describe("tool outputs — a digest only on error/test signal, never a plain-success dump", () => {
  test("a test result digests to counts; an error digests to the first line; plain success is skipped", () => {
    expect(boundExtract(funcOutput("bun test v1.3\n 42 pass\n 1 fail"))[0]).toMatchObject({ kind: "note", summary: "→ bun test v1.3" });
    expect(boundExtract(funcOutput("Error: exit code 1\nsrc/x.ts: TS2322"))[0]).toMatchObject({ kind: "note", summary: "→ Error: exit code 1" });
    expect(boundExtract(funcOutput("Done. 3 files written successfully."))).toEqual([]); // plain success → no digest
    expect(boundExtract(funcOutput({ output: "npm ERROR failed to install" }))[0]).toMatchObject({ kind: "note", summary: "→ npm ERROR failed to install" });
  });
});

// ── Ids: stable item id vs the session@offset fallback ────────────────────────

describe("crumb ids — stable payload.id / call_id, else session@byteOffset", () => {
  test("a function_call uses its own id; a message with no id falls back to session@offset", () => {
    const [call] = extractCodex(SESS)(funcCall("exec_command", { cmd: "ls" }, "fc-STABLE"), { sourcePath: "/x", byteOffset: 100 });
    expect(call!.id).toBe("fc-STABLE");
    const [msg] = extractCodex(SESS)(message("user", "hello"), { sourcePath: "/x", byteOffset: 250 });
    expect(msg!.id).toBe(`${SESSION}@250`); // no id on a message → session@offset
    const [out] = extractCodex(SESS)(funcOutput("Error: boom", "call-XYZ"), { sourcePath: "/x", byteOffset: 300 });
    expect(out!.id).toBe("call-XYZ"); // an output has only call_id
  });
});

// ── Integration through tailFile: project/sessionId come from the bound session ──

describe("tailFile integration — crumbs land under the bound session's project", () => {
  test("a full rollout tails into an ordered, legible trail attributed to the session cwd", async () => {
    const path = writeRollout("session.jsonl", [
      sessionMeta(),
      message("user", "implement the codex extractor"),
      funcCall("exec_command", { cmd: "bun test", description: "run suite" }),
      funcOutput("bun test\n 270 pass\n 0 fail"),
      message("assistant", "Tests are green."),
    ]);
    const written = await tailFile(deps(), path);
    expect(written).toBe(4); // prompt + exec + digest + note (session_meta yields nothing)
    const crumbs = await repo.queryBreadcrumbs(PROJECT, 0, "");
    expect(crumbs.every((c) => c.project === PROJECT && c.sessionId === SESSION && c.source === "codex")).toBe(true);
    expect(crumbs.map((c) => c.kind)).toEqual(["user-prompt", "tool-call", "note", "note"]);
    expect(await summaries()).toContain("→ bun test");
  });
});

// ── Secret classification (shared KTD2 classifier) redacts through the read path ──

describe("secret classification — a pasted key is secret and redacts through the read path", () => {
  test("a secret in a Codex prompt is classified secret and masked by redact()", async () => {
    const key = "sk-" + "proj-abcdef0123456789ghijklmn"; // assembled so no literal secret sits in source
    const path = writeRollout("s.jsonl", [sessionMeta(), message("user", `use ${key} to call the api`)]);
    await tailFile(deps(), path);
    const [crumb] = await repo.queryBreadcrumbs(PROJECT, 0, "");
    expect(crumb!.sensitivity).toBe("secret");
    const masked = redact(crumb!, Breadcrumb);
    expect(masked.summary).toBe("[redacted:secret]");
    expect(masked.summary).not.toContain(key);
  });

  test("a secret in an exec_command's args escalates the crumb even when absent from the summary", async () => {
    const key = "ghp_" + "0123456789".repeat(3) + "abcd";
    const [c] = boundExtract(funcCall("exec_command", { cmd: "deploy", env: { TOKEN: key } }));
    expect(c!.summary).toBe("Exec: deploy"); // the secret sits in args.env, never in the summary
    expect(c!.summary).not.toContain(key);
    expect(c!.sensitivity).toBe("secret"); // classified on the RAW args
  });
});

// ── Discovery + readSessionMeta + captureCodex (the per-file wiring) ───────────

describe("discoverCodexRollouts — recursive, 3 levels deep (YYYY/MM/DD)", () => {
  test("finds rollout-*.jsonl nested under date dirs, ignores other files", () => {
    const day = join(root, "sessions", "2026", "07", "08");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-A.jsonl"), "");
    writeFileSync(join(day, "rollout-B.jsonl"), "");
    writeFileSync(join(day, "notes.md"), ""); // not a rollout
    writeFileSync(join(day, "session_index.jsonl"), ""); // jsonl but not a rollout-*
    const found = discoverCodexRollouts(join(root, "sessions")).sort();
    expect(found).toEqual([join(day, "rollout-A.jsonl"), join(day, "rollout-B.jsonl")].sort());
  });

  test("a missing sessions root returns [] (no throw)", () => {
    expect(discoverCodexRollouts(join(root, "nope"))).toEqual([]);
  });
});

describe("readSessionMeta — cwd + id from line 1, else null", () => {
  test("parses cwd + id from a session_meta first line", () => {
    const path = writeRollout("s.jsonl", [sessionMeta(), message("user", "hi")]);
    expect(readSessionMeta(path)).toEqual({ project: PROJECT, sessionId: SESSION });
  });

  test("returns null when line 1 is not a session_meta, or lacks cwd/id, or the file is missing", () => {
    const notMeta = writeRollout("s2.jsonl", [message("user", "no meta here")]);
    expect(readSessionMeta(notMeta)).toBeNull();
    const noCwd = writeRollout("s3.jsonl", [envelope("session_meta", { id: SESSION })]);
    expect(readSessionMeta(noCwd)).toBeNull();
    expect(readSessionMeta(join(root, "ghost.jsonl"))).toBeNull();
  });
});

describe("captureCodex — discovers, binds per file, and tails", () => {
  test("a nested rollout is captured, attributed to ITS session_meta cwd", async () => {
    const otherProject = "/Users/jarod/other";
    const day = join(root, "sessions", "2026", "07", "08");
    mkdirSync(day, { recursive: true });
    writeRolloutAt(join(day, "rollout-1.jsonl"), [
      envelope("session_meta", { id: "sess-1", cwd: otherProject }),
      message("user", "work in the other project"),
    ]);
    const total = await captureCodex({ repo, machineId: MACHINE }, join(root, "sessions"));
    expect(total).toBe(1);
    const crumbs = await repo.queryBreadcrumbs(otherProject, 0, "");
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({ project: otherProject, sessionId: "sess-1", source: "codex" });
  });

  test("a rollout with no parseable session_meta is skipped, not crashed", async () => {
    const day = join(root, "sessions", "2026", "07", "08");
    mkdirSync(day, { recursive: true });
    writeRolloutAt(join(day, "rollout-bad.jsonl"), [message("user", "orphaned — no session_meta line")]);
    const total = await captureCodex({ repo, machineId: MACHINE }, join(root, "sessions"));
    expect(total).toBe(0);
  });
});

// ── Junk-shape resilience (the extractor never throws) ────────────────────────

describe("resilience — the extractor returns [] on junk, never throws", () => {
  test("null / number / non-response_item / no-timestamp all yield []", () => {
    expect(boundExtract(null)).toEqual([]);
    expect(boundExtract(42)).toEqual([]);
    expect(boundExtract({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "x" }] } })).toEqual([]); // no timestamp
    expect(boundExtract(envelope("response_item", { type: "unknown_kind" }))).toEqual([]);
  });
});

/** A rollout writer for an explicit absolute path (the nested-discovery tests need files OUTSIDE root's top). */
function writeRolloutAt(path: string, events: unknown[]): void {
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}
