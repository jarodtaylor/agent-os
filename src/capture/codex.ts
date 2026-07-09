/**
 * Codex rollout extractor (U8) — the ONE module that knows the shape of the undocumented
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` event stream, the Codex peer of `claude-code.ts`. It reuses
 * the generic `tailer.ts` (byte-offset resume, complete-line framing, contract validation) UNCHANGED — the
 * whole point of the extractor seam — and adds only Codex-specific shape knowledge here.
 *
 * TWO shape facts drive the design, both different from Claude Code:
 *
 *  1. session_meta is LINE-1-ONLY. Codex records the session's `cwd` + `id` on the first line
 *     (`type:"session_meta"`) and NOWHERE else — the per-event `message`/`function_call` lines carry neither
 *     (Claude Code, by contrast, stamps `cwd`+`sessionId` on every event). The tailer's `Extractor` is PURE
 *     and stateless per-event, so it can't "remember" line 1. Resolution: `extractCodex` is a FACTORY bound to
 *     a `CodexSession` (project+sessionId read once from line 1); the per-event closure it returns is still
 *     pure (cwd is a closed-over constant, never mutated). `captureCodex` does the per-file wiring.
 *
 *  2. TWO parallel streams. Each rollout line is `{type, payload, timestamp}`. `type:"response_item"` is the
 *     canonical model-item stream (messages, function calls + their outputs, reasoning, MCP tool calls);
 *     `type:"event_msg"` is a UI-event MIRROR (`user_message`/`agent_message` duplicate the messages, plus
 *     `token_count`/`task_*` noise). We extract from `response_item` ONLY — taking both would double every
 *     user prompt and assistant turn.
 *
 * Sensitivity is classified at capture (KTD2) via the SHARED `secret-classify` module (identical to the CC
 * lane — both capture prompts + tool I/O verbatim). Redaction happens later at the read boundary (U4).
 */
import { closeSync, type Dirent, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { BreadcrumbKind, Sensitivity } from "../contract/index";
import type { Repo } from "../store/repo";
import { classify } from "./secret-classify";
import { tailFile, type ExtractContext, type ExtractedBreadcrumb, type Extractor } from "./tailer";

/** The per-file identity read once from the rollout's `session_meta` line and bound into the extractor. */
export interface CodexSession {
  /** Absolute project path — the session's `cwd` (Codex has no per-project session dirs like CC). */
  project: string;
  /** The Codex session id (`session_meta.payload.id`) — the breadcrumb `sessionId`. */
  sessionId: string;
}

/** Max directory depth walked under the sessions root. The real layout is `YYYY/MM/DD` (3), so 4 gives slack
 *  while still bounding a runaway/symlinked recursion. */
const MAX_DEPTH = 4;

/** Bytes scanned for the line-1 `session_meta`. It can be large — `session_meta` embeds `base_instructions`
 *  (the system prompt) — so this is generous; a first line beyond it yields no session (the file is skipped). */
const SESSION_META_SCAN_BYTES = 1 << 20; // 1 MiB

// ─────────────────────────────────────────────────────────────────────────────
// The extractor factory (bound to one file's session; the returned fn is a pure `Extractor`)
// ─────────────────────────────────────────────────────────────────────────────

interface CrumbCore {
  kind: BreadcrumbKind;
  summary: string;
  sensitivity: Sensitivity;
}

/**
 * Build an `Extractor` bound to one rollout's `session`. The returned function is PURE and SYNCHRONOUS (the
 * tailer's contract): the same event always yields the same crumb, so a re-tailed file is idempotent. `cwd`
 * lives in the closure, never in mutable cross-event state.
 */
export function extractCodex(session: CodexSession): Extractor {
  return (event: unknown, ctx: ExtractContext): ExtractedBreadcrumb[] => {
    if (event === null || typeof event !== "object") return [];
    const ev = event as Record<string, unknown>;
    // Canonical stream only — session_meta / event_msg / turn_context / world_state all fall through to [].
    if (ev.type !== "response_item") return [];

    const ts = Date.parse(str(ev.timestamp));
    if (Number.isNaN(ts)) return []; // no usable timestamp → can't place it on the trail

    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const core = crumbCore(str(payload.type), payload);
    if (!core) return [];

    // A stable per-crumb id: the item's OWN id (function_call / reasoning / custom_tool_call carry `id`), else
    // the correlating `call_id` (a `…_output` has only that), else `session@byteOffset` for a plain message —
    // which has no id of its own. The offset fallback is stable within a file; a resume that COPIED the file to
    // a new path would re-key those message crumbs (the U5-R2 residual — narrowed honestly: tool-call crumbs,
    // which carry real ids, are unaffected; only plain-message crumbs are offset-keyed).
    const id = str(payload.id) || str(payload.call_id) || `${session.sessionId}@${ctx.byteOffset}`;
    return [
      {
        id,
        project: session.project,
        sessionId: session.sessionId,
        source: "codex",
        kind: core.kind,
        summary: core.summary,
        ts,
        sensitivity: core.sensitivity,
      },
    ];
  };
}

/** One `response_item` payload → a crumb core, or `null` to skip. `reasoning` (verbose internal chain-of-
 *  thought — the assistant `message` items carry the narration worth resuming from) and any unknown shape fall
 *  through to null, mirroring the CC extractor's "digest, never dump" leanness. */
function crumbCore(ptype: string, p: Record<string, unknown>): CrumbCore | null {
  switch (ptype) {
    case "message":
      return messageCrumb(p);
    case "function_call":
      return callCrumb(str(p.name), p.arguments);
    case "custom_tool_call":
      return callCrumb(str(p.name), p.input);
    case "function_call_output":
    case "custom_tool_call_output":
      return outputDigest(p.output);
    default:
      return null;
  }
}

/**
 * User-role content that is INJECTED context, not a real prompt: the `AGENTS.md` block, the codebase-memory
 * `<INSTRUCTIONS>` block, and the `<user_instructions>`/`<environment_context>`/`<permissions …>` wrappers
 * Codex prepends. Matched on the leading marker so a genuine prompt merely mentioning one of these is kept.
 */
const INJECTED_USER = /^(#\s*AGENTS\.md instructions|<(INSTRUCTIONS|user_instructions|environment_context|permissions)\b)/i;

/** A `message` item → a user-prompt (real prompts only) or an assistant narration note. developer/system
 *  roles (hook echoes, permissions, environment injections) are skipped. */
function messageCrumb(p: Record<string, unknown>): CrumbCore | null {
  const role = str(p.role);
  const raw = contentText(p.content);
  const text = oneLine(raw);
  if (!text) return null;
  if (role === "user") {
    if (INJECTED_USER.test(text)) return null; // injected context, not intent
    return { kind: "user-prompt", summary: clip(text, 240), sensitivity: classify(raw, "personal") };
  }
  if (role === "assistant") {
    return { kind: "note", summary: clip(text, 160), sensitivity: classify(raw, "personal") };
  }
  return null; // developer / system
}

/** A tool call (`function_call` args are a JSON STRING; `custom_tool_call` `input` may be an object) → an
 *  action crumb. Escalate sensitivity on the RAW args (a command flag or write payload can embed a secret). */
function callCrumb(name: string, argsRaw: unknown): CrumbCore {
  const args = parseArgs(argsRaw);
  const { kind, summary } = toolSummary(name || "tool", (args ?? {}) as Record<string, unknown>);
  const floor: Sensitivity = kind === "file-edit" ? "path" : "personal";
  return { kind, summary, sensitivity: classify(safeJson(args), floor) };
}

function toolSummary(name: string, a: Record<string, unknown>): { kind: BreadcrumbKind; summary: string } {
  if (name === "exec_command" || name === "shell" || name === "bash") {
    // The Codex analog of CC's Bash — the command is the intent worth resuming from.
    return { kind: "tool-call", summary: `Exec: ${clip(firstLine(a.cmd ?? a.command), 120)}` };
  }
  if (/patch|write|edit/i.test(name)) {
    // apply_patch / write-file etc. → file-edit; git carries the diff, so keep it lean (mirrors CC).
    const path = basename(a.path ?? a.file_path ?? a.filename);
    return { kind: "file-edit", summary: path ? `Edit ${path}` : name };
  }
  if (name === "read_file" || name === "read") {
    return { kind: "tool-call", summary: `Read ${basename(a.path ?? a.file_path)}` };
  }
  // MCP tools (`mcp__…`) + anything else — name + a terse hint from a common arg field.
  const hint = clip(oneLine(a.query ?? a.input ?? a.pattern ?? ""), 70);
  return { kind: "tool-call", summary: hint ? `${name}: ${hint}` : name };
}

/**
 * A `…_output` item → a terse OBSERVATION digest, or `null` when the output carries no signal worth its own
 * crumb (a plain successful command — its action crumb already says what ran). Emits ONLY on an error or a
 * test result, classifying the FULL output for secrets while surfacing just the first line (a secret anywhere
 * in the output marks the whole crumb `secret`; only a short, redaction-covered line is ever stored).
 */
function outputDigest(output: unknown): CrumbCore | null {
  const text = outputText(output);
  if (!text) return null;
  const first = firstLine(text);
  const hasTestResult = /\d+\s+(?:pass|passed|fail|failed|error)/i.test(text);
  const errorish = /\berror\b|exit code [1-9]|\bfailed\b|\bpanic\b|traceback/i.test(first);
  if (!hasTestResult && !errorish) return null;
  return { kind: "note", summary: `→ ${clip(first, 140)}`, sensitivity: classify(text, "personal") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-file wiring: read session_meta → bind the extractor → tail
// ─────────────────────────────────────────────────────────────────────────────

export interface CodexCaptureDeps {
  repo: Repo;
  /** This machine's federation id (`paths.ts#resolveMachineId`), stamped onto every crumb by the tailer. */
  machineId: string;
}

/**
 * Discover every Codex rollout under `sessionsRoot`, and for each: read its `session_meta` to learn the
 * project+sessionId, bind an extractor to it, and tail it from its persisted cursor. Returns the total crumbs
 * submitted this pass. A file with no parseable `session_meta` (can't be attributed) is skipped, and a
 * per-file tail fault is caught + logged rather than aborting the whole sweep — the same resilience contract
 * as the tailer's `tailAll`.
 */
export async function captureCodex(deps: CodexCaptureDeps, sessionsRoot: string): Promise<number> {
  let total = 0;
  for (const path of discoverCodexRollouts(sessionsRoot)) {
    const session = readSessionMeta(path);
    if (!session) continue; // no attributable session_meta → skip this file
    try {
      total += await tailFile({ repo: deps.repo, machineId: deps.machineId, extractor: extractCodex(session) }, path);
    } catch (err) {
      console.error(`[agent-os] codex capture: skipping ${path} this pass:`, err);
    }
  }
  return total;
}

/**
 * Recursively collect `rollout-*.jsonl` files under `sessionsRoot` (the layout is `YYYY/MM/DD/`, three levels
 * deep — the tailer's own one-level `discoverTranscripts` can't reach it). A missing/unreadable root or subdir
 * is skipped rather than thrown; depth is bounded (`MAX_DEPTH`) against a symlink loop. Returns absolute paths.
 */
export function discoverCodexRollouts(sessionsRoot: string): string[] {
  const out: string[] = [];
  walk(sessionsRoot, out, 0);
  return out;
}

function walk(dir: string, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing/unreadable dir — skip, keep sweeping the rest
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

/**
 * Read a rollout's line-1 `session_meta` → its `{project, sessionId}`, or `null` when the file is unreadable,
 * the first line isn't a parseable `session_meta`, or it lacks a cwd/id. Reads only a bounded prefix (line 1
 * can be large — it embeds `base_instructions`) rather than the whole, possibly-multi-MB, file.
 */
export function readSessionMeta(sourcePath: string): CodexSession | null {
  let prefix: string;
  try {
    const fd = openSync(sourcePath, "r");
    try {
      const buf = Buffer.allocUnsafe(SESSION_META_SCAN_BYTES);
      const n = readSync(fd, buf, 0, SESSION_META_SCAN_BYTES, 0);
      prefix = buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const newline = prefix.indexOf("\n");
  const line = newline >= 0 ? prefix.slice(0, newline) : prefix; // if line 1 exceeds the scan, this is partial → parse fails → null
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev === null || typeof ev !== "object") return null;
  const e = ev as Record<string, unknown>;
  if (e.type !== "session_meta") return null;
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  const project = str(payload.cwd);
  const sessionId = str(payload.id) || str(payload.session_id);
  if (!project || !sessionId) return null; // can't attribute a crumb without both
  return { project, sessionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small guards / text helpers (kept local; the CC extractor has its own copies — a shared text-utils module is
// a ce-simplify candidate, deliberately not pulled into this unit's diff)
// ─────────────────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const oneLine = (s: unknown): string => str(s).replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const firstLine = (s: unknown): string => oneLine(str(s).split("\n").find((l) => l.trim()) ?? "");

const basename = (p: unknown): string => {
  const s = str(p);
  return s.split("/").filter(Boolean).pop() ?? s;
};

/** Extract the text of a `message.content` — a string, or the joined `.text` of a content-part array. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? str((c as Record<string, unknown>).text) : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/** `function_call.arguments` is a JSON STRING; `custom_tool_call.input` may already be an object. Normalize to
 *  a value, never throwing (a malformed args string → `{}`, so the crumb still summarizes by tool name). */
function parseArgs(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw ?? {};
}

/** The text of a tool `output` — a bare string, `{output|content: "…"}`, else its JSON form (so a secret in an
 *  unexpected-shaped output is still scanned by the classifier). */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.output === "string") return o.output;
    if (typeof o.content === "string") return o.content;
    return safeJson(output);
  }
  return "";
}

/** JSON.stringify that never throws (a circular input coerces to "") — used only to scan input for secrets. */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
