import { describe, expect, test } from "bun:test";
import { Breadcrumb, WorkState } from "../src/contract/index";
import { redact } from "../src/redact/apply";

const REDACTED_SECRET = "[redacted:secret]";

/**
 * A curated work-state whose handoff cursor holds a secret (schema-marked `secret`, always redacted),
 * plus two breadcrumbs: one benign (`personal` — must survive so the agent can resume) and one a secret
 * pasted at capture (`personal`-marked `summary`, but captured-classified `secret` — the escalation target).
 * Built through `WorkState.parse` so a malformed fixture fails loudly here, not silently downstream.
 */
function curatedFixture() {
  return WorkState.parse({
    project: "proj",
    machineId: "test-machine",
    source: "codex",
    lastActivity: 200,
    lane: "curated",
    handoff: {
      project: "proj",
      sessionId: "s1",
      machineId: "test-machine",
      source: "codex",
      cursor: { inFlight: "sk-live-SECRET-should-hide", lastDecided: "chose plan A", next: "run tests" },
      ts: 100,
    },
    rawTrailTail: [
      { id: "b1", project: "proj", sessionId: "s1", machineId: "test-machine", source: "codex",
        kind: "note", summary: "wrote the parser", ts: 150, sensitivity: "personal" },
      { id: "b2", project: "proj", sessionId: "s1", machineId: "test-machine", source: "codex",
        kind: "tool-call", summary: "export TOKEN=abc123xyz", ts: 200, sensitivity: "secret" },
    ],
  });
}

describe("redact — work-state choke-point", () => {
  test("always masks a schema-secret field (handoff.cursor.inFlight)", () => {
    const r = redact(curatedFixture(), WorkState);
    expect(r.handoff?.cursor.inFlight).toBe(REDACTED_SECRET);
  });

  test("passes a personal summary through (agent needs it to resume)", () => {
    const r = redact(curatedFixture(), WorkState);
    expect(r.rawTrailTail?.[0]?.summary).toBe("wrote the parser");
  });

  test("escalates a secret-classified breadcrumb's personal-marked summary (maxSensitivity)", () => {
    const r = redact(curatedFixture(), WorkState);
    expect(r.rawTrailTail?.[1]?.summary).toBe(REDACTED_SECRET);
  });

  test("leaves unmarked fields untouched", () => {
    const r = redact(curatedFixture(), WorkState);
    expect(r.handoff?.cursor.lastDecided).toBe("chose plan A");
    expect(r.handoff?.cursor.next).toBe("run tests");
    expect(r.project).toBe("proj");
  });

  test("does not mutate the input", () => {
    const original = curatedFixture();
    redact(original, WorkState);
    expect(original.handoff?.cursor.inFlight).toBe("sk-live-SECRET-should-hide");
    expect(original.rawTrailTail?.[1]?.summary).toBe("export TOKEN=abc123xyz");
  });

  test("redacted output is still schema-valid WorkState", () => {
    const r = redact(curatedFixture(), WorkState);
    expect(() => WorkState.parse(r)).not.toThrow();
  });

  test("raw-lane trail redacts a secret-classified breadcrumb", () => {
    const raw = WorkState.parse({
      project: "proj", machineId: "test-machine", source: "codex", lastActivity: 50, lane: "raw",
      rawTrailTail: [
        { id: "r1", project: "proj", sessionId: "s", machineId: "test-machine", source: "codex",
          kind: "user-prompt", summary: "my api key is sk-XYZ", ts: 50, sensitivity: "secret" },
      ],
    });
    const r = redact(raw, WorkState);
    expect(r.rawTrailTail?.[0]?.summary).toBe(REDACTED_SECRET);
  });
});

describe("redact — standalone Breadcrumb (query_breadcrumbs)", () => {
  test("secret-classified summary is redacted", () => {
    const b = Breadcrumb.parse({ id: "b", project: "p", sessionId: "s", machineId: "m", source: "codex",
      kind: "note", summary: "pw=hunter2", ts: 1, sensitivity: "secret" });
    expect(redact(b, Breadcrumb).summary).toBe(REDACTED_SECRET);
  });

  test("personal-classified summary passes through", () => {
    const b = Breadcrumb.parse({ id: "b", project: "p", sessionId: "s", machineId: "m", source: "codex",
      kind: "note", summary: "refactored repo.ts", ts: 1, sensitivity: "personal" });
    expect(redact(b, Breadcrumb).summary).toBe("refactored repo.ts");
  });
});

describe("redact — policy + safety", () => {
  test("threshold=personal also masks personal summaries (wider policy), labels reflect true level", () => {
    const r = redact(curatedFixture(), WorkState, { threshold: "personal" });
    expect(r.rawTrailTail?.[0]?.summary).toBe("[redacted:personal]"); // personal now masked
    expect(r.rawTrailTail?.[1]?.summary).toBe(REDACTED_SECRET);        // escalated one still labeled secret
    expect(r.handoff?.cursor.inFlight).toBe(REDACTED_SECRET);
  });

  test("fails CLOSED when no union member matches (cannot locate sensitive fields)", () => {
    expect(() => redact({ lane: "bogus" } as unknown as typeof WorkState._output, WorkState)).toThrow();
  });
});
