/**
 * Claude Code transcript extractor (U5) — the ONE module that knows the shape of the undocumented
 * `~/.claude/projects/<mangled-project>/<session>.jsonl` event stream. It is deliberately quarantined here
 * because that shape is an UNVERSIONED contract that drifts between Claude Code releases; isolating it means a
 * shape change touches this file only, never the generic `tailer.ts` (which Codex/U8 reuses unchanged).
 *
 * What the raw lane is FOR: a breadcrumb trail that survives a crashed or forgotten session. The transcript
 * lines exist on disk the moment they are written, independent of any clean session end — so tailing them
 * leaves a usable "here's what was in flight" trail even when nothing got handed off.
 *
 * Extraction (refined by the U5 sufficiency spike — SPIKE-REPORT.md):
 *   1. OBSERVATION LAYER (#1 refinement). A tool call records what was DONE; its `toolUseResult` records what
 *      was OBSERVED (test pass/fail, an error, a subagent verdict). The spike proved the trail recovers
 *      direction but NOT observations without this — and `toolUseResult` is structural (every tool call emits
 *      one), so it survives terse/crashed sessions where narration wouldn't. We emit a terse DIGEST, never a
 *      dump.
 *   2. Tool-call summaries prefer the Bash `description` (human intent) over the raw command.
 *   3. File-edit crumbs stay lean ("Edit <basename>") — git diff carries what changed; the edit RESULT is not
 *      digested at all.
 *   4. User prompts/directives are first-class (decision/intent capture).
 *   5. Command scaffolding and teammate idle-pings are filtered as noise.
 */
import type { BreadcrumbKind, Sensitivity } from "../contract/index";
import { classify } from "./secret-classify";
import type { ExtractContext, ExtractedBreadcrumb } from "./tailer";

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers
// ─────────────────────────────────────────────────────────────────────────────

const basename = (p: unknown): string => {
  const s = str(p);
  return s.split("/").filter(Boolean).pop() ?? s;
};
const oneLine = (s: unknown): string => str(s).replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const firstLine = (s: unknown): string => oneLine(str(s).split("\n").find((l) => l.trim()) ?? "");

/**
 * User string-content events that are command scaffolding or teammate idle-pings, not real prompts (spike
 * refinement #5). Matched on the leading tag so a genuine prompt that merely mentions one of these words is
 * untouched.
 */
const SCAFFOLD_TAG =
  /^<(command-name|command-message|command-args|command-stdout|local-command-caveat|local-command-stdout|task-id|task-notification|task-prompt|system-reminder|user-prompt-submit-hook)>/;

// ─────────────────────────────────────────────────────────────────────────────
// Per-block summarization (a crumb sans identity — the extractor stamps id/project/etc.)
// ─────────────────────────────────────────────────────────────────────────────

interface CrumbCore {
  kind: BreadcrumbKind;
  summary: string;
  sensitivity: Sensitivity;
}

/** Summarize one `tool_use` block into a legible one-liner. `file-edit` for Edit/Write (git carries the
 *  diff), `tool-call` for everything else. */
function toolCrumb(name: unknown, input: unknown): CrumbCore {
  const i = (input ?? {}) as Record<string, unknown>;
  const toolName = typeof name === "string" ? name : "tool";
  const { kind, summary } = toolSummary(toolName, i);
  // Escalate on the RAW input (a command flag or a Write payload can embed a secret), never just the summary.
  const floor: Sensitivity = kind === "file-edit" ? "path" : "personal";
  return { kind, summary, sensitivity: classify(safeJson(i), floor) };
}

function toolSummary(name: string, i: Record<string, unknown>): { kind: BreadcrumbKind; summary: string } {
  switch (name) {
    case "Bash": {
      // Refinement #2: prefer the human INTENT string over a truncated command — the spike showed a
      // resuming agent reorients off intent labels, not raw command text.
      const intent = oneLine(i.description);
      const cmd = firstLine(i.command);
      return { kind: "tool-call", summary: `Bash: ${clip(intent || cmd || "(command)", 120)}` };
    }
    case "Edit":
    case "MultiEdit":
      return { kind: "file-edit", summary: `Edit ${basename(i.file_path)}` };
    case "Write":
      return { kind: "file-edit", summary: `Write ${basename(i.file_path)}` };
    case "NotebookEdit":
      return { kind: "file-edit", summary: `Edit ${basename(i.notebook_path ?? i.file_path)}` };
    case "Read":
      return { kind: "tool-call", summary: `Read ${basename(i.file_path)}` };
    case "Glob":
      return { kind: "tool-call", summary: `Glob ${clip(oneLine(i.pattern), 80)}` };
    case "Grep":
      return { kind: "tool-call", summary: `Grep ${clip(oneLine(i.pattern), 60)}` };
    case "Agent":
      return { kind: "tool-call", summary: `Agent[${str(i.subagent_type) || "?"}]: ${clip(oneLine(i.description ?? i.name), 80)}` };
    case "Task":
      return { kind: "tool-call", summary: `Task: ${clip(oneLine(i.description ?? i.subject), 80)}` };
    case "Skill":
      return { kind: "tool-call", summary: `Skill: ${oneLine(i.skill ?? i.command)}` };
    case "SendMessage":
      return { kind: "tool-call", summary: `SendMessage → ${str(i.to ?? i.recipient)}: ${clip(oneLine(i.content ?? i.message), 70)}` };
    case "ToolSearch":
      return { kind: "tool-call", summary: `ToolSearch: ${clip(oneLine(i.query), 70)}` };
    default:
      if (name.startsWith("mcp__")) {
        return { kind: "tool-call", summary: `${name}: ${clip(oneLine(i.query ?? i.libraryName), 70)}` };
      }
      return { kind: "tool-call", summary: name };
  }
}

/**
 * Digest a `toolUseResult` into a terse OBSERVATION crumb (refinement #1), or `null` when the result carries
 * no observation worth its own crumb. Stateless SHAPE discrimination (no cross-event `tool_use_id`
 * correlation) keeps the extractor pure: the result object's own keys identify the tool family.
 *
 * Emitted (all prefixed `→` so an observation reads distinctly from an action, kept a legible `note`):
 *   - a test run              → "→ N pass, M fail"   (parsed from stdout/stderr)
 *   - an interrupted command  → "→ interrupted"
 *   - a non-zero exit / error → "→ error: <first line>"  (string result, or `is_error` on the sibling block)
 *   - a subagent/review       → "→ agent[<type>]: <verdict pointer>"
 * Skipped (no digest): a plain successful command (its tool-call crumb already says what ran), an Edit/Write
 * result (git carries the diff — refinement #3), a Read/Task result, and any unknown shape (never dump it).
 */
function resultDigest(result: unknown, isError: boolean): CrumbCore | null {
  // String result — almost always the error surface ("Error: Exit code 1\n…", "Error: String to replace…").
  if (typeof result === "string") {
    const line = firstLine(result);
    return line ? { kind: "note", summary: `→ ${clip(line, 140)}`, sensitivity: classify(result, "personal") } : null;
  }
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  // Bash-family result: { stdout, stderr, interrupted }. The observation layer the spike proved is the #1 gap.
  if (typeof r.stdout === "string" || typeof r.stderr === "string") {
    const out = `${str(r.stdout)}\n${str(r.stderr)}`;
    const pass = out.match(/(\d+)\s+pass/i);
    const fail = out.match(/(\d+)\s+fail/i);
    // classify() runs every SECRET_PATTERN over the full output — only pay it on a branch that emits a crumb
    // (a plain successful command is the common case and returns null below).
    if (pass || fail) {
      return { kind: "note", summary: `→ ${pass?.[1] ?? "0"} pass, ${fail?.[1] ?? "0"} fail`, sensitivity: classify(out, "personal") };
    }
    if (r.interrupted === true) return { kind: "note", summary: "→ interrupted", sensitivity: classify(out, "personal") };
    if (isError) {
      const detail = firstLine(str(r.stderr) || str(r.stdout)) || "non-zero exit";
      return { kind: "note", summary: `→ error: ${clip(detail, 120)}`, sensitivity: classify(out, "personal") };
    }
    return null; // plain success — the tool-call crumb already carries the action; a digest adds nothing
  }

  // Subagent/review result: a POINTER to the verdict (the "review / large output" case, refinement #1).
  if (typeof r.agentType === "string" || typeof r.agentId === "string") {
    const content = typeof r.content === "string"
      ? r.content
      : Array.isArray(r.content)
        ? r.content.map((c) => str((c as Record<string, unknown>)?.text)).join(" ")
        : "";
    const tip = firstLine(content);
    return {
      kind: "note",
      summary: `→ agent[${str(r.agentType) || "?"}]${tip ? `: ${clip(tip, 100)}` : " done"}`,
      sensitivity: classify(content, "personal"),
    };
  }

  // Edit/Write ({ structuredPatch, filePath }), Read ({ file }), Task ({ taskId }), unknown shapes → no digest.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The extractor (an `Extractor` — pure, one event in, zero+ crumbs out)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn one parsed Claude Code JSONL event into breadcrumbs. Handles exactly three event families and skips
 * everything else (mode / ai-title / attachment / queue-operation / pr-link / file-history-snapshot / system
 * / last-prompt events all fall through to `[]`, as do `isMeta` events and command scaffolding):
 *   - `type:"user"` + STRING content            → a user prompt (unless it's scaffolding noise)
 *   - `type:"user"` + a `toolUseResult`         → an observation digest
 *   - `type:"assistant"` + a content[] array    → one crumb per tool_use / text block
 */
export function extractClaudeCode(event: unknown, ctx: ExtractContext): ExtractedBreadcrumb[] {
  if (event === null || typeof event !== "object") return [];
  const ev = event as Record<string, unknown>;
  if (ev.isMeta === true) return []; // meta events are bookkeeping, never a breadcrumb

  const ts = Date.parse(str(ev.timestamp));
  if (Number.isNaN(ts)) return []; // no usable timestamp → can't place it on the trail (non-event lines)

  // breadcrumb.sessionId is the Claude Code TRANSCRIPT session id. NOTE (U4-R1): this is a DIFFERENT
  // namespace from `access_log.sessionId`, which U4 derives from the MCP TRANSPORT UUID. They are genuinely
  // different producers (the tailer here vs. an MCP tool call), so `repo.hitRate()` cannot correlate a
  // breadcrumb's session with an access-log session — that cross-namespace correlation is DEFERRED (ref
  // open-findings U4-R1). Do not assume this id matches any `access_log` row's sessionId.
  const sessionId = str(ev.sessionId);
  if (!sessionId) return []; // every real user/assistant event carries one; without it we can't attribute

  const project = projectOf(ev, ctx.sourcePath);
  const message = (ev.message ?? {}) as Record<string, unknown>;

  // A stable per-crumb id: the event's own uuid when present (survives file rewrites), else session@offset.
  // The `#<slot>` suffix disambiguates the multiple crumbs one assistant event can emit — and MUST be
  // zero-padded: the store reads breadcrumbs ordered by `(ts, id)` with `id` compared as a STRING, and every
  // crumb from one event shares that event's single `ts`, so an unpadded "…#10" would sort between "…#1" and
  // "…#2" and scramble within-event order in the trail.
  const eventId = str(ev.uuid) || `${sessionId}@${ctx.byteOffset}`;
  const out: ExtractedBreadcrumb[] = [];
  const emit = (slot: string, core: CrumbCore): void => {
    out.push({
      id: `${eventId}#${slot}`,
      project,
      sessionId,
      source: "claude-code",
      kind: core.kind,
      summary: core.summary,
      ts,
      sensitivity: core.sensitivity,
    });
  };

  // 1. User prompt — first-class decision/intent capture (refinement #4).
  if (ev.type === "user" && typeof message.content === "string") {
    const raw = message.content;
    const text = oneLine(raw);
    if (text && !SCAFFOLD_TAG.test(text)) {
      emit("p", { kind: "user-prompt", summary: clip(text, 240), sensitivity: classify(raw, "personal") });
    }
    return out;
  }

  // 2. Observation digest — a tool RESULT rides `toolUseResult` on the FOLLOWING user event (whose
  //    `message.content` is a tool_result ARRAY, so branch 1 above never claimed it). `is_error` sits on the
  //    sibling content block.
  if (ev.type === "user" && ev.toolUseResult != null) {
    const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
    const isError = blocks.some((b) => b?.type === "tool_result" && b?.is_error === true);
    const digest = resultDigest(ev.toolUseResult, isError);
    if (digest) emit("r", digest);
    return out;
  }

  // 3. Assistant blocks — tool_use → action crumb, text → terse narration note.
  if (ev.type === "assistant" && Array.isArray(message.content)) {
    const blocks = message.content as Record<string, unknown>[];
    // Pad the slot to the widest index so the store's STRING ordering on id matches numeric block order even
    // at >=100 blocks (a fixed width of 2 sorts "100" before "99"); see the `eventId` note on (ts, id).
    const slotWidth = String(Math.max(blocks.length - 1, 0)).length;
    blocks.forEach((block, index) => {
      const slot = String(index).padStart(slotWidth, "0");
      if (block?.type === "tool_use") {
        emit(slot, toolCrumb(block.name, block.input));
      } else if (block?.type === "text") {
        const text = oneLine(block.text);
        if (text) emit(slot, { kind: "note", summary: clip(text, 160), sensitivity: classify(str(block.text), "personal") });
      }
    });
    return out;
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Project resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The project an event belongs to. The event's `cwd` is AUTHORITATIVE — it round-trips a path containing
 * symbols (spaces, dashes, parentheses) losslessly, and every real user/assistant event carries one. Only
 * when `cwd` is absent do we fall back to de-mangling the `~/.claude/projects/<mangled>/` directory name,
 * which is a LOSSY reverse of the `cwd → dir` mangling (every `/` became `-`): a real segment containing a
 * dash (`agents-os`) can no longer be told apart from a path separator. The fallback is therefore best-effort
 * only; the authoritative `cwd` path is what the tests pin.
 */
function projectOf(ev: Record<string, unknown>, sourcePath: string): string {
  const cwd = str(ev.cwd);
  if (cwd) return cwd;
  return demangleDir(sourcePath);
}

function demangleDir(sourcePath: string): string {
  const dir = basename(sourcePath.replace(/\/[^/]*$/, "")); // the transcript's parent directory name
  if (!dir) return sourcePath;
  const path = dir.replace(/-/g, "/");
  return path.startsWith("/") ? path : `/${path}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small guards
// ─────────────────────────────────────────────────────────────────────────────

/** Coerce an unknown JSONL field to a string; anything non-string becomes "". */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** JSON.stringify that never throws (a circular input coerces to "") — used only to scan input for secrets. */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
