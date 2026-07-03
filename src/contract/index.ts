/**
 * Contract public surface (seam #1). Everything importing shared types imports from here.
 */
export {
  // Sensitivity system (KTD2)
  Sensitivity,
  sensitivityRegistry,
  sensitive,
  enumerateSensitive,
  // Inferred wrapper (decision #13)
  Inferred,
  // Shared vocabulary
  Source,
  Runtime,
  ItemKind,
  Lane,
  BreadcrumbKind,
  // Records
  Cursor,
  Handoff,
  Breadcrumb,
  WorkState,
  InventoryItem,
  RuntimeTarget,
  // JSON Schema outputs for MCP tool registration
  jsonSchemas,
} from "./schema";

export type { SensitiveField } from "./schema";
