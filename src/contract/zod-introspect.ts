/**
 * Shared zod-introspection vocabulary read off a node's public `def` — used by BOTH the contract's
 * `enumerateSensitive` walk (schema.ts) and the redaction walk (../redact/apply.ts). Extracted to ONE
 * source so the two parallel walks can never disagree on which node types are leaves or on the `def`
 * shape.
 *
 * The walk BODIES stay separate by design — each independently handles every container so a new type
 * fails CLOSED in BOTH at test time (that safety property is why the two `walk` functions are not merged).
 * Only this vocabulary — the leaf allowlist and the introspection field shape — is shared. Verified
 * against the public `node.def` surface of zod 4.4.
 */
import type * as z from "zod";

/** The introspection fields a walk reads off a node's public `def`, typed narrowly (no `any`). */
export interface ZodDef {
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

/** Leaf zod types that terminate a walk (allowlisted — traversal fails CLOSED on any other node type). */
export const LEAF_TYPES = new Set([
  "string", "number", "boolean", "enum", "literal", "date", "bigint",
  "null", "undefined", "symbol", "nan", "void", "any", "unknown",
]);
