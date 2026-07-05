/**
 * The redaction choke-point (decision #12–13, KTD2). Given a value and its schema, return a copy with
 * every sensitivity-marked field masked at or above `threshold`. This is the ONE place brain data is
 * redacted; the MCP `read_work_state` tool and the `GET /work-state` route both funnel through it (via
 * the shared work-state response path), so they can never disagree on what leaks.
 *
 * Two properties make it correct where a hand-written per-shape redactor would rot:
 *
 *   1. Schema-driven, never field-name-driven (KTD2). It keys off the sensitivity *registry* — the same
 *      marks `enumerateSensitive` reads — so marking a new field sensitive in the contract redacts it
 *      everywhere with no change here. Hardcoding `summary`/`inFlight` would be exactly the by-name
 *      redaction KTD2 forbids.
 *   2. Per-record escalation. A `Breadcrumb.summary` is schema-marked `personal` (the floor), but a
 *      breadcrumb captured-classified `secret` must redact as `secret`. Descending into any record that
 *      carries its own `sensitivity` field raises the effective level of its descendants via
 *      `maxSensitivity` — static marks alone under-redact an escalated record (the contract's own warning).
 *
 * POLICY — default `threshold` is `secret`: only `secret`-effective fields are masked, so the user's own
 * resume content (`personal` summaries, `path`s) still flows to their local, gate-protected agent — which
 * is the whole point of the substrate ("pick up where we left off"). The escalation above is what keeps
 * that safe: a secret hiding inside a nominally-`personal` field is caught and masked anyway. A stricter
 * consumer (a shared UI, federation in v1.1) passes a wider `threshold` (e.g. `personal`) without any
 * redesign.
 *
 * Traversal mirrors `enumerateSensitive`'s fail-CLOSED walk: known containers recurse, leaf types pass
 * untouched, and an unrecognized zod node THROWS rather than risk passing an unredacted sensitive field.
 * The two walks are deliberately parallel (this one carries the value alongside the schema); a new
 * contract container type therefore fails loudly in BOTH at test time, never silently under-redacts.
 */
import type * as z from "zod";
import { Sensitivity, maxSensitivity, sensitivityRegistry } from "../contract/index";

/** The masked-value sentinel. Encodes the effective level (honest signal of what was hidden, no leak). */
function mask(level: Sensitivity): string {
  return `[redacted:${level}]`;
}

/** True when `level` is at least as restrictive as `threshold` (`Sensitivity.options` is most→least). */
function atOrAboveThreshold(level: Sensitivity, threshold: Sensitivity): boolean {
  const order = Sensitivity.options;
  return order.indexOf(level) <= order.indexOf(threshold);
}

/** A value is an escalating record iff it carries a valid `sensitivity` field (Breadcrumb in v1). */
function recordSensitivityOf(value: Record<string, unknown>, fallback: Sensitivity | null): Sensitivity | null {
  const s = value.sensitivity;
  return typeof s === "string" && (Sensitivity.options as readonly string[]).includes(s)
    ? (s as Sensitivity)
    : fallback;
}

export interface RedactOptions {
  /** Mask fields whose EFFECTIVE sensitivity is at least this restrictive. Default `secret`. */
  threshold?: Sensitivity;
}

/** Return a redacted copy of `value` per its `schema`. Never mutates the input. */
export function redact<T>(value: T, schema: z.ZodType, opts: RedactOptions = {}): T {
  return walk(value, schema, null, opts.threshold ?? "secret") as T;
}

/** The introspection surface read off a node's public `def` — same fields `enumerateSensitive` reads. */
interface ZodDef {
  type: string;
  shape?: Record<string, z.ZodType>; // object
  element?: z.ZodType; // array
  innerType?: z.ZodType; // optional | nullable | default | prefault | readonly | catch
  options?: z.ZodType[]; // union
  left?: z.ZodType; // intersection
  right?: z.ZodType; // intersection
  items?: z.ZodType[]; // tuple
  rest?: z.ZodType | null; // tuple
  valueType?: z.ZodType; // record
}

/** Leaf zod types that terminate the walk untouched (allowlisted — mirrors the contract's `LEAF_TYPES`). */
const LEAF_TYPES = new Set([
  "string", "number", "boolean", "enum", "literal", "date", "bigint",
  "null", "undefined", "symbol", "nan", "void", "any", "unknown",
]);

function walk(value: unknown, schema: z.ZodType, recordSensitivity: Sensitivity | null, threshold: Sensitivity): unknown {
  // 1. Marked sensitive at THIS node → mask, escalating by the enclosing record's capture-time sensitivity.
  const meta = sensitivityRegistry.get(schema);
  if (meta) {
    const effective = recordSensitivity ? maxSensitivity(meta.level, recordSensitivity) : meta.level;
    return atOrAboveThreshold(effective, threshold) ? mask(effective) : value;
  }

  // 2. Not marked here → recurse by container type, carrying the corresponding sub-value.
  const def = schema.def as ZodDef;
  switch (def.type) {
    case "object": {
      if (value === null || typeof value !== "object") return value;
      const rec = value as Record<string, unknown>;
      // A record carrying its own `sensitivity` escalates every descendant sensitive mark (Breadcrumb).
      const nextRecordSensitivity = recordSensitivityOf(rec, recordSensitivity);
      const shape = def.shape ?? {};
      const out: Record<string, unknown> = { ...rec }; // shallow clone → never mutate the input
      for (const key of Object.keys(shape)) {
        if (key in out) out[key] = walk(out[key], shape[key]!, nextRecordSensitivity, threshold);
      }
      return out;
    }
    case "array":
      if (!Array.isArray(value) || !def.element) return value;
      return value.map((el) => walk(el, def.element!, recordSensitivity, threshold));
    // Path-transparent wrappers: unwrap without touching the value's shape.
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
      return value === undefined || value === null || !def.innerType
        ? value
        : walk(value, def.innerType, recordSensitivity, threshold);
    case "union": {
      // A concrete value takes exactly ONE member's shape — walk only that member (safeParse selects it,
      // for discriminated and plain unions alike). No match ⇒ we can't locate its sensitive fields, so
      // fail CLOSED rather than return it unredacted.
      const member = (def.options ?? []).find((opt) => opt.safeParse(value).success);
      if (!member) {
        throw new Error("redact: no union member matches the value — cannot locate sensitive fields (fail closed)");
      }
      return walk(value, member, recordSensitivity, threshold);
    }
    case "intersection": {
      // The value satisfies both sides; redacting through each applies the union of their marks.
      let v = value;
      if (def.left) v = walk(v, def.left, recordSensitivity, threshold);
      if (def.right) v = walk(v, def.right, recordSensitivity, threshold);
      return v;
    }
    case "tuple": {
      if (!Array.isArray(value)) return value;
      const items = def.items ?? [];
      return value.map((el, i) => {
        const itemSchema = items[i] ?? def.rest ?? undefined;
        return itemSchema ? walk(el, itemSchema, recordSensitivity, threshold) : el;
      });
    }
    case "record": {
      if (value === null || typeof value !== "object" || !def.valueType) return value;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, def.valueType, recordSensitivity, threshold);
      }
      return out;
    }
    default:
      if (LEAF_TYPES.has(def.type)) return value; // leaf — nothing sensitive below it
      // Fail CLOSED: an unrecognized node could hide a sensitive field. Throw loudly (parity with
      // `enumerateSensitive`) rather than silently pass it through unredacted.
      throw new Error(`redact: unhandled zod type '${def.type}' (fail closed)`);
  }
}
