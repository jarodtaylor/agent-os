import * as z from "zod";

/**
 * Seam #1: the single source of truth for every record the substrate reads or writes.
 *
 * Producers validate at the write boundary and hand back `z.infer` types; MCP tools and
 * the JSON API register their input/output shapes from the `jsonSchemas` exports below.
 *
 * Two bake-ins ship in v1 of every record (decision #13 + KTD2):
 *   1. `machineId` + `source` federation discriminators on every record.
 *   2. Schema-level SENSITIVITY marks so redaction keys off the TYPE, never a field name.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sensitivity: schema-level marks (KTD2 — redact by TYPE, not by magic field name)
// ─────────────────────────────────────────────────────────────────────────────

const SENSITIVITY = ["secret", "personal", "path"] as const;

/** Sensitivity levels, ordered most- to least-restrictive. Read the ordered tuple off `Sensitivity.options`. */
export const Sensitivity = z.enum(SENSITIVITY);
export type Sensitivity = (typeof SENSITIVITY)[number];

/**
 * Custom typed registry marking WHICH schemas carry sensitive content, at what level.
 *
 * A registry — not `z.brand()` — is deliberate: branding would make `z.infer` of a marked
 * field a branded type (`string & $brand<…>`), so producers, scanners, and fixtures could no
 * longer construct records from plain values. The registry marks the *schema* (which is what
 * `enumerateSensitive` reads at runtime) without polluting the inferred value type.
 */
export const sensitivityRegistry = z.registry<{ level: Sensitivity }>();

/** Mark a field's schema as sensitive at `level`. Returns the same schema (registered in place). */
export function sensitive<T extends z.ZodType>(inner: T, level: Sensitivity): T {
  // Register on the concrete base type: `.register` has a schema-compatibility conditional that a
  // generic `T` can't resolve. Registration mutates in place, so the original typed `inner` is returned.
  (inner as z.ZodType).register(sensitivityRegistry, { level });
  return inner;
}

/**
 * A sensitivity-marked field and its dotted path. Path conventions:
 *   object key → `.key`   array element → `[]`   tuple item → `[i]`   record value → `[*]`
 *   union / intersection members are path-transparent (they resolve to the same runtime path).
 */
export interface SensitiveField {
  path: string;
  level: Sensitivity;
}

/** Leaf zod types that terminate a walk (allowlisted — see `walk` for why traversal fails CLOSED). */
const LEAF_TYPES = new Set([
  "string", "number", "boolean", "enum", "literal", "date", "bigint",
  "null", "undefined", "symbol", "nan", "void", "any", "unknown",
]);

/** The introspection fields `walk` reads off a node's public `def`, typed narrowly (no `any`). */
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

/**
 * Walk a schema and return every sensitivity-marked field path — the input to a redaction pass.
 *
 * Traversal fails CLOSED: known leaf types terminate, the composite containers below are recursed
 * so a sensitive field nested anywhere is enumerated, and any *other* node type THROWS. A silently
 * dropped mark is a redaction leak, so an unhandled container (e.g. `z.lazy`, `z.map`, `z.set`) is
 * a loud failure at construction/test time, never an under-redaction at runtime. Reads the public
 * `node.def` introspection surface, verified against zod 4.4.
 */
export function enumerateSensitive(schema: z.ZodType): SensitiveField[] {
  const out: SensitiveField[] = [];
  walk(schema, "", out, new Set());
  return out;
}

function walk(node: z.ZodType, path: string, out: SensitiveField[], seen: Set<z.ZodType>): void {
  const meta = sensitivityRegistry.get(node);
  if (meta && path !== "") out.push({ path, level: meta.level });

  const def = node.def as ZodDef;
  switch (def.type) {
    case "object": {
      if (seen.has(node)) return; // cycle guard
      seen.add(node);
      const shape = def.shape ?? {};
      for (const key of Object.keys(shape)) {
        walk(shape[key]!, path === "" ? key : `${path}.${key}`, out, seen);
      }
      seen.delete(node);
      return;
    }
    case "array":
      if (def.element) walk(def.element, `${path}[]`, out, seen);
      return;
    // Path-transparent wrappers: unwrap without changing the path.
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
      if (def.innerType) walk(def.innerType, path, out, seen);
      return;
    // Union / intersection: a value here can take any member's shape. Recurse each member
    // path-transparent, so the enumerated path matches the real runtime path a redactor keys off.
    case "union":
      for (const opt of def.options ?? []) walk(opt, path, out, seen);
      return;
    case "intersection":
      if (def.left) walk(def.left, path, out, seen);
      if (def.right) walk(def.right, path, out, seen);
      return;
    case "tuple":
      (def.items ?? []).forEach((item, i) => walk(item, `${path}[${i}]`, out, seen));
      if (def.rest) walk(def.rest, `${path}[]`, out, seen);
      return;
    case "record":
      if (def.valueType) walk(def.valueType, `${path}[*]`, out, seen);
      return;
    default:
      if (LEAF_TYPES.has(def.type)) return; // leaf (string, number, enum, literal, …)
      // Fail CLOSED: an unrecognized node could hide a sensitive field. Throw loudly rather than
      // silently under-redact — this is the safety primitive every downstream module imports.
      throw new Error(`enumerateSensitive: unhandled zod type '${def.type}' at path '${path || "<root>"}'`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inferred<T>: heuristic values carry confidence + evidence, never a bare guess (decision #13)
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap a schema so a heuristic value ships with `confidence` (0–1) and `evidence`. */
export function Inferred<T extends z.ZodType>(inner: T) {
  return z.object({
    value: inner,
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string()),
  });
}
export type Inferred<T> = { value: T; confidence: number; evidence: string[] };

// ─────────────────────────────────────────────────────────────────────────────
// Shared vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** Who produced a record — the federation discriminator: the write-capable harnesses (Claude Code + Codex in v1, Hermes in v1.1) plus the OS itself. Cursor/Antigravity/OpenCode join when they gain write. */
export const Source = z.enum(["claude-code", "codex", "hermes", "agent-os"]);
export type Source = z.infer<typeof Source>;

/** Runtimes the inventory observes (a superset of write-capable harnesses). */
export const Runtime = z.enum(["claude-code", "codex", "hermes", "cursor", "antigravity", "opencode"]);
export type Runtime = z.infer<typeof Runtime>;

/** Kinds of stack item the inventory enumerates and parity can propagate. */
export const ItemKind = z.enum(["skill", "mcp", "plugin"]);
export type ItemKind = z.infer<typeof ItemKind>;

/** Which write lane produced the work-state a reader is looking at (R6). */
export const Lane = z.enum(["curated", "raw"]);
export type Lane = z.infer<typeof Lane>;

/** The kind of captured event a breadcrumb records. */
export const BreadcrumbKind = z.enum(["user-prompt", "tool-call", "file-edit", "session-start", "session-end", "note"]);
export type BreadcrumbKind = z.infer<typeof BreadcrumbKind>;

/** Epoch milliseconds. */
const epochMs = z.number().int().nonnegative();

/** Federation discriminators baked into every record (decision #13). */
const federation = {
  machineId: z.string().min(1),
  source: Source,
};

// ─────────────────────────────────────────────────────────────────────────────
// Records
// ─────────────────────────────────────────────────────────────────────────────

/** The continuity cursor inside a handoff. */
export const Cursor = z.object({
  // Least-curated of the three: an in-flight buffer that can hold a pasted token, a raw command,
  // or an error dump — so it carries the highest redaction obligation.
  inFlight: sensitive(z.string(), "secret"),
  lastDecided: z.string(),
  next: z.string(),
});
export type Cursor = z.infer<typeof Cursor>;

/** Curated "pick up here" record, keyed by (project, sessionId) so concurrent sessions never clobber (KTD8). */
export const Handoff = z.object({
  project: z.string().min(1),
  sessionId: z.string().min(1),
  ...federation,
  cursor: Cursor,
  ts: epochMs,
});
export type Handoff = z.infer<typeof Handoff>;

/** One captured event on the raw lane. */
export const Breadcrumb = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  sessionId: z.string().min(1),
  ...federation,
  kind: BreadcrumbKind,
  // Captured event text; defaults to `personal` per KTD2 (escalated at capture via `sensitivity` below).
  summary: sensitive(z.string(), "personal"),
  ts: epochMs,
  // Capture-time CLASSIFICATION (data) — distinct from the schema-level mark on `summary`.
  sensitivity: Sensitivity,
});
export type Breadcrumb = z.infer<typeof Breadcrumb>;

/** The resume payload `read_work_state` returns: curated handoff primary, raw trail fallback, freshness visible (R1/R5/R6). */
export const WorkState = z.object({
  project: z.string().min(1),
  ...federation,
  lane: Lane,
  lastActivity: epochMs,
  handoff: Handoff.optional(),
  rawTrailTail: z.array(Breadcrumb).optional(),
});
export type WorkState = z.infer<typeof WorkState>;

/** One observed stack item. `runtime` is the discriminant — kept a plain enum (not a
 *  discriminatedUnion) because every runtime emits an identical shape in slice 1; promote
 *  to a discriminatedUnion only when per-runtime branches diverge (simplicity first). */
export const InventoryItem = z.object({
  runtime: Runtime,
  kind: ItemKind,
  name: z.string().min(1),
  ...federation,
});
export type InventoryItem = z.infer<typeof InventoryItem>;

/** Seam #2 sliver: the descriptor parity writes dispatch against, never a hardcoded `~/.claude` path (KTD6). */
export const RuntimeTarget = z.object({
  id: z.string().min(1),
  runtime: Runtime,
  // Filesystem paths — reveal home dir / username, so the whole list is redaction-marked.
  configSurfaces: sensitive(z.array(z.string().min(1)), "path"),
  // DECLARED, not inferred: which item kinds can be provisioned here; empty ⇒ read-only (e.g. OpenClaw in v1).
  capabilities: z.array(ItemKind),
  ...federation,
});
export type RuntimeTarget = z.infer<typeof RuntimeTarget>;

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema exports (for MCP tool registration) — zod v4 native, no zod-to-json-schema
// ─────────────────────────────────────────────────────────────────────────────

export const jsonSchemas = {
  WorkState: z.toJSONSchema(WorkState),
  Handoff: z.toJSONSchema(Handoff),
  Breadcrumb: z.toJSONSchema(Breadcrumb),
  InventoryItem: z.toJSONSchema(InventoryItem),
  RuntimeTarget: z.toJSONSchema(RuntimeTarget),
} as const;
