/**
 * Inventory scanners (U9 — the Observe half): one typed inventory across the roster's harnesses, crash-safe.
 *
 * This file is the SPINE — a registry of one scanner per source, composed crash-safely. Adding a harness
 * (Hermes/Cursor/Antigravity/OpenCode/Grok Build, as each enters real rotation — decisions #40/#44) is a
 * one-line change: write a `src/scan/<runtime>.ts` returning `InventoryItem[]`, add its `Runtime` to the
 * contract's enum, and add ONE row to `SCANNERS`. No spine rework — that is the property the unit exists to
 * protect. Slice-1 roster (Jarod's call, anchored to the shipped contract): Claude Code + Codex only.
 *
 * Crash-safety is layered: each scanner's helpers fail soft per surface (`internal.ts`), and `scanAll`
 * wraps every source so a scanner that throws anyway degrades ONLY its own runtime to empty — the rest of
 * the inventory is always returned (R9 / AE4).
 *
 * The inventory is NOT persisted. Scanners read live disk and return the current stack, so a rescan always
 * reflects reality (R8) and a removed item simply stops appearing (AE5) — no cache to reconcile, no phantom
 * rows. The `inventory` store table (U2) stays available for a later federation/caching need; slice-1's one
 * consumer (U11's view) scans in-process on demand.
 */
import type { InventoryItem, Runtime } from "../contract/index";
import { scanClaudeCode } from "./claude-code";
import { scanCodex } from "./codex";
import type { ScanContext, SourceScanner } from "./internal";

export type { ScanContext, SourceScanner } from "./internal";
export { scanClaudeCode } from "./claude-code";
export { scanCodex } from "./codex";

/** One scanner per source. Slice-1 roster only; append a row per harness as it enters real rotation. */
const SCANNERS: ReadonlyArray<{ runtime: Runtime; scan: SourceScanner }> = [
  { runtime: "claude-code", scan: scanClaudeCode },
  { runtime: "codex", scan: scanCodex },
];

/**
 * Run a given scanner list into one flat inventory. A source that throws is caught and logged, degrading
 * ONLY that runtime (never the whole sweep) — the AE4/R9 guarantee at the composition level. Factored out of
 * `scanAll` so this source-level backstop is DIRECTLY testable: the real registry is all fail-soft, so no
 * real scanner ever throws out here, which means only an injected throwing scanner can exercise the catch —
 * without this seam the backstop could be deleted with the whole suite still green. `async` so an async
 * source (a future network probe) slots into the registry unchanged; today's sync scanners resolve at once.
 */
export async function runScanners(
  ctx: ScanContext,
  scanners: ReadonlyArray<{ runtime: Runtime; scan: SourceScanner }>,
): Promise<InventoryItem[]> {
  let inventory: InventoryItem[] = [];
  for (const { runtime, scan } of scanners) {
    try {
      // `concat`, not `inventory.push(...items)`: a function-call spread of an untrusted-length array
      // RangeErrors in V8/Bun on a pathological config (attacker-owns-HOME), which would nuke the whole scan.
      inventory = inventory.concat(await scan(ctx));
    } catch {
      // The caught value is NEVER inspected — not even `.name`. Any read of an unconstrained thrown value
      // has an angle: its message can quote config content (a config legitimately holds secrets — the same
      // rule `readParsed` follows), and ANY property access can itself throw (a getter), which would abort
      // this catch and void the very degrade-one-runtime guarantee it exists to provide. A fixed
      // runtime-only line is structurally terminal: no data flows from the throw to the log. The runtime is
      // enough to know which source degraded; the "roughly why" belongs to structured degradation metadata
      // (issue #37), not stderr.
      console.error(`[agent-os] inventory scan: '${runtime}' threw and was degraded`);
    }
  }
  return inventory;
}

/** Scan every registered source (the slice-1 roster) into one flat inventory. */
export function scanAll(ctx: ScanContext): Promise<InventoryItem[]> {
  return runScanners(ctx, SCANNERS);
}
