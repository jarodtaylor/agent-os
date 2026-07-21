import * as z from "zod";
import { LEAF_TYPES, type ZodDef } from "./zod-introspect";

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
 * The MORE restrictive of two sensitivity levels, by `Sensitivity.options` order (secret > personal > path).
 * The redaction pass MUST combine a field's static schema mark with a record's capture-time `sensitivity`
 * through this — a `Breadcrumb` whose `summary` is schema-marked `personal` but captured as `secret` must
 * redact as `secret`. Static enumeration alone (`enumerateSensitive`) under-redacts an escalated record.
 */
export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  const order = Sensitivity.options; // most- to least-restrictive
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

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
  // Dedupe: a union/intersection walk revisits shared sub-schemas (e.g. both work-state variants embed
  // the same Handoff), so the same (path, level) can surface more than once. Collapse identical marks;
  // a genuine same-path-different-level (rare) keeps both entries.
  const seen: SensitiveField[] = [];
  return out.filter((f) => {
    if (seen.some((s) => s.path === f.path && s.level === f.level)) return false;
    seen.push(f);
    return true;
  });
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
export type Inferred<T extends z.ZodType> = { value: z.infer<T>; confidence: number; evidence: string[] };

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
export const Cursor = z.strictObject({
  // Least-curated of the three: an in-flight buffer that can hold a pasted token, a raw command,
  // or an error dump — so it carries the highest redaction obligation.
  inFlight: sensitive(z.string(), "secret"),
  lastDecided: z.string(),
  next: z.string(),
});
export type Cursor = z.infer<typeof Cursor>;

/** Curated "pick up here" record, keyed by (project, sessionId) so concurrent sessions never clobber (KTD8). */
export const Handoff = z.strictObject({
  project: z.string().min(1),
  sessionId: z.string().min(1),
  ...federation,
  cursor: Cursor,
  ts: epochMs,
});
export type Handoff = z.infer<typeof Handoff>;

/** One captured event on the raw lane. */
export const Breadcrumb = z.strictObject({
  id: z.string().min(1),
  project: z.string().min(1),
  sessionId: z.string().min(1),
  ...federation,
  kind: BreadcrumbKind,
  // Captured event text. The schema mark is the FLOOR (`personal`); the record's `sensitivity` field can
  // escalate it — the redaction pass MUST take `maxSensitivity(schema mark, record.sensitivity)`, or a
  // secret-classified breadcrumb under-redacts.
  summary: sensitive(z.string(), "personal"),
  ts: epochMs,
  // Capture-time CLASSIFICATION (data) — distinct from the schema-level mark on `summary`.
  sensitivity: Sensitivity,
});
export type Breadcrumb = z.infer<typeof Breadcrumb>;

/** Fields shared by both work-state variants. */
const workStateCommon = {
  project: z.string().min(1),
  ...federation,
  lastActivity: epochMs,
};

/** Curated resume state: the handoff is the primary "pick up here" payload (a newer raw trail may ride alongside). */
const CuratedWorkState = z.strictObject({
  ...workStateCommon,
  lane: z.literal("curated"),
  handoff: Handoff,
  rawTrailTail: z.array(Breadcrumb).optional(),
});

/** Raw resume state: a non-empty breadcrumb trail is the fallback payload when no curated handoff exists. */
const RawWorkState = z.strictObject({
  ...workStateCommon,
  lane: z.literal("raw"),
  rawTrailTail: z.array(Breadcrumb).min(1),
  handoff: Handoff.optional(),
});

/**
 * The resume payload `read_work_state` returns (R1/R5/R6). A discriminated union on `lane` makes the
 * resume-state invariant STRUCTURAL — curated ⇒ handoff, raw ⇒ non-empty trail — so it holds at zod
 * parse AND is represented in the exported JSON Schema (`oneOf` + `minItems`). That closes the boundary
 * gap a `.check()` refinement leaves: `z.toJSONSchema` drops custom checks, so the MCP tool schema (KTD2)
 * would otherwise still accept an empty work-state a reader mistakes for "nothing in flight" (AE1/AE2).
 */
export const WorkState = z.discriminatedUnion("lane", [CuratedWorkState, RawWorkState]);
export type WorkState = z.infer<typeof WorkState>;

/** One observed stack item. `runtime` is the discriminant — kept a plain enum (not a
 *  discriminatedUnion) because every runtime emits an identical shape in slice 1; promote
 *  to a discriminatedUnion only when per-runtime branches diverge (simplicity first). */
export const InventoryItem = z.strictObject({
  runtime: Runtime,
  kind: ItemKind,
  name: z.string().min(1),
  ...federation,
});
export type InventoryItem = z.infer<typeof InventoryItem>;

/** Seam #2 sliver: the descriptor parity writes dispatch against, never a hardcoded `~/.claude` path (KTD6). */
export const RuntimeTarget = z.strictObject({
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
// Provisioning blueprint manifest (U10 — KTD10). Modeled on `RuntimeTarget`'s strictObject-record shape.
// The manifest is organized BY ROLE (R2); the engine executes ONLY the file operations — the role/harness/
// model metadata is descriptive (machine-readable for the future view + drift reporting) and encodes no
// workflow or sequencing. `schemaVersion` is new contract convention: an integer at the manifest root whose
// COMPATIBILITY the loader owns (newer ⇒ "upgrade agent-os", older ⇒ migrate — never an opaque schema error,
// R1). The loader lives in `src/provision/blueprint.ts`; this is only the typed shape.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One provisioning file operation, discriminated on `transform` (KTD3). A `discriminatedUnion` makes illegal
 * states unrepresentable (a `copy` can't carry `sources`; a `scaffold` can't be drift-tracked) and gives the
 * downstream render switch (U3) a compile-time `assertNever` exhaustiveness guard.
 *
 *   - `copy`         1 source → 1 destination, byte-identical.
 *   - `compose`      N ORDERED sources → 1 destination (deterministic assembly, KTD6).
 *   - `scaffold`     create-only, drift-EXCLUDED by construction (KTD3/KTD8) — `source` is OPTIONAL (a marker
 *                    README has one; a bare placeholder doesn't), so it carries no `driftTracked` field.
 *   - `config-merge` a patch merged through the U14 config-write engine, foreign keys preserved (KTD3).
 *
 * A 5th taxonomy member `"transform"` (strip/inject framing) is a DEFERRED extension point (R6) — documented
 * here, not implemented; it joins as a new variant when an SSOT file first carries framing its native copy
 * shouldn't. `driftTracked` is optional on the drift-eligible transforms; its DEFAULT resolution is U3's
 * (diff) job — U1 only carries the field so the diff can read it.
 */
/**
 * A blueprint-relative file path (R1/R9): non-empty, POSIX-RELATIVE, and CONTAINED — no absolute root, no
 * `..` segment, no NUL, not the bare `.`. Because the schema rejects every escaping shape, the loader's
 * `join(blueprintRoot, path)` can never read or write outside the blueprint directory — containment BY
 * CONSTRUCTION, so no redundant runtime check is needed. Encodes "the blueprint lives in the project repo"
 * (R1) + "project scope" (R9) at the type level, so a traversal path never reaches the loader. POSIX-only,
 * matching the machine-abspath heuristic (Windows drive/UNC paths are a documented future extension).
 */
function isPortableRelPath(p: string): boolean {
  if (p === ".") return false; // the bare current-dir is not a file target
  if (p.startsWith("/")) return false; // POSIX-absolute root
  if (p.includes("\0")) return false; // NUL
  return !p.split("/").includes(".."); // any `..` segment ⇒ could escape join(root, p)
}
const PortableRelPath = z
  .string()
  .min(1)
  .refine(isPortableRelPath, { message: "must be a portable, contained relative path (no absolute root, no `..` segment, no NUL)" });

export const FileEntry = z.discriminatedUnion("transform", [
  z.strictObject({
    transform: z.literal("copy"),
    source: PortableRelPath,
    destination: PortableRelPath,
    driftTracked: z.boolean().optional(),
  }),
  z.strictObject({
    transform: z.literal("compose"),
    sources: z.array(PortableRelPath).min(1),
    destination: PortableRelPath,
    driftTracked: z.boolean().optional(),
  }),
  z.strictObject({
    transform: z.literal("scaffold"),
    source: PortableRelPath.optional(),
    destination: PortableRelPath,
  }),
  z.strictObject({
    transform: z.literal("config-merge"),
    source: PortableRelPath,
    destination: PortableRelPath,
    driftTracked: z.boolean().optional(),
  }),
]);
export type FileEntry = z.infer<typeof FileEntry>;

/** A role bundle (R2): one role's target harness, an optional DESCRIPTIVE model pin (never used to drive
 *  file ops — per-agent pins live in the copied file CONTENT), and its file entries. An empty `files` array
 *  is legal (a declared role not yet carrying surfaces). */
export const RoleBundle = z.strictObject({
  name: z.string().min(1),
  harness: Runtime,
  model: z.string().min(1).optional(),
  files: z.array(FileEntry),
});
export type RoleBundle = z.infer<typeof RoleBundle>;

/** A project's provisioning blueprint manifest (R1/R2). Root `schemaVersion` + role bundles; an empty
 *  `roles` array is legal. Unknown keys are rejected (strictObject). */
export const Manifest = z.strictObject({
  schemaVersion: z.number().int().min(1),
  roles: z.array(RoleBundle),
});
export type Manifest = z.infer<typeof Manifest>;

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema exports (for MCP tool registration) — zod v4 native, no zod-to-json-schema
// ─────────────────────────────────────────────────────────────────────────────

export const jsonSchemas = {
  WorkState: z.toJSONSchema(WorkState),
  Handoff: z.toJSONSchema(Handoff),
  Breadcrumb: z.toJSONSchema(Breadcrumb),
  InventoryItem: z.toJSONSchema(InventoryItem),
  RuntimeTarget: z.toJSONSchema(RuntimeTarget),
  Manifest: z.toJSONSchema(Manifest),
} as const;
