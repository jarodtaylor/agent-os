import { describe, expect, test } from "bun:test";
import * as z from "zod";
import {
  Breadcrumb,
  Handoff,
  Inferred,
  InventoryItem,
  RuntimeTarget,
  WorkState,
  enumerateSensitive,
  jsonSchemas,
  maxSensitivity,
  sensitive,
  type SensitiveField,
} from "../src/contract/index";

// ── Shared valid fixtures (machineId + source on every record) ──────────────────

const base = { machineId: "mac-1", source: "claude-code" as const };

const handoff = {
  project: "/Users/jarod/x",
  sessionId: "s1",
  ...base,
  cursor: { inFlight: "editing foo", lastDecided: "use zod", next: "write tests" },
  ts: 1_720_000_000_000,
};

const breadcrumb = {
  id: "b1",
  project: "/Users/jarod/x",
  sessionId: "s1",
  ...base,
  kind: "user-prompt" as const,
  summary: "asked to add tests",
  ts: 1_720_000_000_000,
  sensitivity: "personal" as const,
};

const workState = {
  project: "/Users/jarod/x",
  ...base,
  lane: "curated" as const,
  lastActivity: 1_720_000_000_000,
  handoff,
  rawTrailTail: [breadcrumb],
};

const inventoryItem = {
  runtime: "claude-code" as const,
  kind: "skill" as const,
  name: "handoff",
  ...base,
};

const runtimeTarget = {
  id: "cc-local",
  runtime: "claude-code" as const,
  configSurfaces: ["~/.claude/settings.json", "~/.claude.json"],
  capabilities: ["skill", "mcp"] as const,
  ...base,
};

const records = [
  ["WorkState", WorkState, workState],
  ["Handoff", Handoff, handoff],
  ["Breadcrumb", Breadcrumb, breadcrumb],
  ["InventoryItem", InventoryItem, inventoryItem],
  ["RuntimeTarget", RuntimeTarget, runtimeTarget],
] as const;

// ── Round-trip parse ────────────────────────────────────────────────────────

describe("valid records round-trip parse", () => {
  for (const [name, schema, fixture] of records) {
    test(name, () => {
      const parsed = schema.parse(fixture);
      // Idempotent: re-parsing the parsed value succeeds and is deep-equal.
      expect(schema.parse(parsed)).toEqual(parsed);
    });
  }
});

// ── Producer drift ────────────────────────────────────────────────────────────

describe("producer drift fails at parse", () => {
  test("count where an array is expected (WorkState.rawTrailTail)", () => {
    const drifted = { ...workState, rawTrailTail: 5 };
    expect(WorkState.safeParse(drifted).success).toBe(false);
  });

  test("count where an array is expected (RuntimeTarget.configSurfaces)", () => {
    const drifted = { ...runtimeTarget, configSurfaces: 3 };
    expect(RuntimeTarget.safeParse(drifted).success).toBe(false);
  });

  test("wrong scalar type (Breadcrumb.ts as string)", () => {
    const drifted = { ...breadcrumb, ts: "yesterday" };
    expect(Breadcrumb.safeParse(drifted).success).toBe(false);
  });
});

// ── Unknown enum variants reject ──────────────────────────────────────────────

describe("unknown discriminator variants reject", () => {
  test("unknown source", () => {
    expect(WorkState.safeParse({ ...workState, source: "nope" }).success).toBe(false);
  });

  test("unknown runtime", () => {
    expect(InventoryItem.safeParse({ ...inventoryItem, runtime: "nope" }).success).toBe(false);
  });
});

// ── Sensitivity enumeration (redact by TYPE) ──────────────────────────────────

function sorted(fields: SensitiveField[]): SensitiveField[] {
  return [...fields].sort((a, b) => a.path.localeCompare(b.path));
}

describe("enumerateSensitive returns the sensitivity-marked paths", () => {
  test("Breadcrumb → summary (personal)", () => {
    expect(enumerateSensitive(Breadcrumb)).toEqual([{ path: "summary", level: "personal" }]);
  });

  test("Handoff → nested cursor.inFlight (secret)", () => {
    expect(enumerateSensitive(Handoff)).toEqual([{ path: "cursor.inFlight", level: "secret" }]);
  });

  test("RuntimeTarget → configSurfaces (path)", () => {
    expect(enumerateSensitive(RuntimeTarget)).toEqual([{ path: "configSurfaces", level: "path" }]);
  });

  test("WorkState → through optional + nested object + array element", () => {
    expect(sorted(enumerateSensitive(WorkState))).toEqual(
      sorted([
        { path: "handoff.cursor.inFlight", level: "secret" },
        { path: "rawTrailTail[].summary", level: "personal" },
      ]),
    );
  });

  test("all three levels are represented across the records", () => {
    const levels = new Set(
      [Breadcrumb, Handoff, RuntimeTarget].flatMap((s) => enumerateSensitive(s).map((f) => f.level)),
    );
    expect(levels).toEqual(new Set(["secret", "personal", "path"]));
  });
});

// ── Redact by TYPE, not by NAME (negative controls — pins the KTD2 contract) ──────

describe("enumerateSensitive keys off the schema mark, never the field name", () => {
  test("a marked field with an innocuous name IS returned", () => {
    const schema = z.object({ blob: sensitive(z.string(), "secret") });
    expect(enumerateSensitive(schema)).toEqual([{ path: "blob", level: "secret" }]);
  });

  test("unmarked fields with secret-looking names are NOT returned", () => {
    const schema = z.object({ password: z.string(), apiKey: z.string(), token: z.number() });
    expect(enumerateSensitive(schema)).toEqual([]);
  });
});

// ── Nested-in-container regression (HIGH finding: marks must not be silently dropped) ──

describe("enumerateSensitive finds marks nested in every handled container", () => {
  test("inside a z.union member", () => {
    const schema = z.object({
      payload: z.union([z.object({ blob: sensitive(z.string(), "secret") }), z.null()]),
    });
    expect(enumerateSensitive(schema)).toEqual([{ path: "payload.blob", level: "secret" }]);
  });

  test("inside a z.record value", () => {
    const schema = z.object({ env: z.record(z.string(), sensitive(z.string(), "secret")) });
    expect(enumerateSensitive(schema)).toEqual([{ path: "env[*]", level: "secret" }]);
  });

  test("inside a z.tuple item", () => {
    const schema = z.object({ pair: z.tuple([z.string(), sensitive(z.string(), "path")]) });
    expect(enumerateSensitive(schema)).toEqual([{ path: "pair[1]", level: "path" }]);
  });
});

// ── Fail CLOSED: an unhandled container throws rather than silently under-redact ──

describe("enumerateSensitive throws on unhandled zod types (no silent leak)", () => {
  test("z.map (unhandled container) throws a clear, path-bearing error", () => {
    const schema = z.object({ m: z.map(z.string(), z.string()) });
    expect(() => enumerateSensitive(schema)).toThrow(/unhandled zod type 'map' at path 'm'/);
  });

  test("z.lazy (unhandled) throws rather than dropping a nested mark", () => {
    const schema = z.lazy(() => z.object({ blob: sensitive(z.string(), "secret") }));
    expect(() => enumerateSensitive(schema)).toThrow(/unhandled zod type 'lazy'/);
  });
});

// ── JSON Schema exports (MCP tool registration) ───────────────────────────────

type JsonSchemaShape = { type?: string; properties?: Record<string, unknown>; required?: string[] };

describe("z.toJSONSchema exports are tool-usable", () => {
  test("every record exports a non-empty JSON schema", () => {
    for (const [name] of records) {
      const js = jsonSchemas[name] as JsonSchemaShape;
      expect(js).toBeDefined();
      expect(Object.keys(js).length).toBeGreaterThan(0);
    }
  });

  test("object records expose properties + required", () => {
    for (const key of ["Handoff", "Breadcrumb"] as const) {
      const js = jsonSchemas[key] as JsonSchemaShape;
      expect(js.type).toBe("object");
      expect(js.properties).toBeDefined();
      expect(Array.isArray(js.required)).toBe(true);
      expect(js.required!.length).toBeGreaterThan(0);
    }
  });

  test("Handoff required lists a known field", () => {
    const js = jsonSchemas.Handoff as JsonSchemaShape;
    expect(js.required).toContain("project");
    expect(js.properties).toHaveProperty("machineId");
    expect(js.properties).toHaveProperty("source");
  });

  // The lane invariant must survive export to JSON Schema (the MCP tool boundary, KTD2) — a .check()
  // refinement would be dropped by z.toJSONSchema; the discriminated union is representable (adversarial G1).
  test("WorkState JSON Schema encodes the lane invariant as oneOf", () => {
    const js = jsonSchemas.WorkState as { oneOf?: JsonSchemaShape[] };
    expect(Array.isArray(js.oneOf)).toBe(true);
    expect(js.oneOf).toHaveLength(2);
    for (const variant of js.oneOf!) {
      expect(variant.type).toBe("object");
      expect(variant.properties).toHaveProperty("project");
      expect(variant.required).toContain("lane");
    }
    // raw ⇒ non-empty rawTrailTail is enforced at the boundary, not just at zod parse.
    expect(JSON.stringify(js)).toContain("minItems");
  });
});

// ── Inferred wrapper ──────────────────────────────────────────────────────────

describe("Inferred wrapper", () => {
  const Detected = Inferred(z.array(z.string()));

  test("parses a valid inferred value", () => {
    const ok = Detected.parse({ value: ["writes"], confidence: 0.8, evidence: ["found in config.toml"] });
    expect(ok.confidence).toBe(0.8);
    expect(ok.value).toEqual(["writes"]);
  });

  test("rejects confidence above 1", () => {
    expect(Detected.safeParse({ value: [], confidence: 1.5, evidence: [] }).success).toBe(false);
  });

  test("rejects confidence below 0", () => {
    expect(Detected.safeParse({ value: [], confidence: -0.1, evidence: [] }).success).toBe(false);
  });

  test("requires evidence to be an array", () => {
    expect(Detected.safeParse({ value: [], confidence: 0.5, evidence: "a string" }).success).toBe(false);
    expect(Detected.safeParse({ value: [], confidence: 0.5 }).success).toBe(false);
  });

  test("validates the wrapped value against its inner schema", () => {
    expect(Detected.safeParse({ value: [42], confidence: 0.5, evidence: [] }).success).toBe(false);
  });
});

// ── maxSensitivity + capture-time escalation (adversarial U1-F1: don't under-redact secret breadcrumbs) ──

describe("maxSensitivity escalates to the more restrictive level", () => {
  test("orders secret > personal > path", () => {
    expect(maxSensitivity("personal", "path")).toBe("personal");
    expect(maxSensitivity("path", "secret")).toBe("secret");
    expect(maxSensitivity("secret", "personal")).toBe("secret");
    expect(maxSensitivity("path", "path")).toBe("path");
  });

  test("a secret-classified breadcrumb escalates its summary above the schema floor", () => {
    const secretBc = { ...breadcrumb, sensitivity: "secret" as const };
    const summaryFloor = enumerateSensitive(Breadcrumb).find((f) => f.path === "summary")!.level;
    expect(summaryFloor).toBe("personal"); // the static schema mark under-redacts on its own…
    // …so the redaction pass must combine it with the record's capture-time classification.
    expect(maxSensitivity(summaryFloor, secretBc.sensitivity)).toBe("secret");
  });
});

// ── WorkState resume-state invariant (adversarial U1-F2: no valid empty work-state) ──

describe("WorkState requires its lane's primary payload", () => {
  const stateBase = { project: "/Users/jarod/x", ...base, lastActivity: 1_720_000_000_000 };

  test("curated without a handoff is rejected", () => {
    expect(WorkState.safeParse({ ...stateBase, lane: "curated", rawTrailTail: [breadcrumb] }).success).toBe(false);
  });

  test("raw without a non-empty rawTrailTail is rejected", () => {
    expect(WorkState.safeParse({ ...stateBase, lane: "raw", handoff }).success).toBe(false);
    expect(WorkState.safeParse({ ...stateBase, lane: "raw", rawTrailTail: [] }).success).toBe(false);
  });

  test("valid curated and raw states parse", () => {
    expect(WorkState.safeParse({ ...stateBase, lane: "curated", handoff }).success).toBe(true);
    expect(WorkState.safeParse({ ...stateBase, lane: "raw", rawTrailTail: [breadcrumb] }).success).toBe(true);
  });
});

// ── Records reject unknown fields (adversarial U1-F3: strictObject aligns with additionalProperties:false) ──

describe("records reject unknown fields (strictObject)", () => {
  test("an unknown root field fails to parse", () => {
    expect(Handoff.safeParse({ ...handoff, bogus: 1 }).success).toBe(false);
    expect(InventoryItem.safeParse({ ...inventoryItem, bogus: 1 }).success).toBe(false);
  });

  test("an unknown nested field fails to parse", () => {
    expect(Handoff.safeParse({ ...handoff, cursor: { ...handoff.cursor, bogus: 1 } }).success).toBe(false);
  });
});
