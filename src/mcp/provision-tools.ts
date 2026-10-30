/**
 * The propose-only provisioning tools (U10 U7 — R16, AE5, F4, KTD7, KTD11). Agents SEE and PROPOSE; apply
 * authority stays with the operator's CLI (#33). Two tools, both read-only by construction:
 *
 *   provision_status — the drift report for a registered project (the CLI's `status`).
 *   provision_plan   — the advisory plan rows (the CLI's `plan`).
 *
 * There is deliberately NO mutating tool here (no apply, undo, or init): AE5 pins that the inventory stays this
 * way. Both tools run the SAME read pipeline as the CLI (`src/provision/survey.ts`), so an agent and the operator
 * can never disagree about what changed, and a refusal reads identically on both.
 *
 * Two boundaries this module holds:
 *   - KTD11: `project` is a LOGICAL name, resolved only through the known-projects registry. It is never
 *     path-joined; an unregistered name is refused before any project path is constructed or touched.
 *   - KTD7 / decision #45: output carries paths, roles, harnesses, actions, and drift flags only — never a byte
 *     of blueprint or live-surface content. Every refusal string arrives content-free from the survey layer.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveDataDir } from "../paths";
import type { DiffRow } from "../provision/diff";
import { lookupProject } from "../provision/registry";
import { planView, statusView, survey } from "../provision/survey";
import { bestEffortAccessLogger, type McpDeps } from "./tools";

type ProvisionTool = "provision_status" | "provision_plan";

/** Register the two propose-only provisioning tools on a (per-session) `McpServer`. */
export function registerProvisionTools(server: McpServer, deps: McpDeps): void {
  const logAccess = bestEffortAccessLogger(server, deps);

  const run = async (tool: ProvisionTool, project: string, sessionId: string | undefined) => {
    let payload: ProvisionPayload;
    try {
      payload = propose(tool, project, deps.dataDir);
    } catch (err) {
      // The read pipeline is built to refuse rather than throw, but an unexpected throw must not reach the agent
      // as raw error text (the SDK would forward err.message, which no layer has vetted as content-free) or skip
      // the audit row. The real error goes to the process log only.
      console.error(`[agent-os] ${tool} failed:`, err);
      payload = { ok: false, tool, project, refusal: "internal-error", error: "internal error — see the agent-os process log" };
    }
    await logAccess(tool, project, sessionId);
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: !payload.ok };
  };

  server.registerTool(
    "provision_status",
    {
      title: "Provision status",
      description:
        "Drift report for a registered project: which provisioned surfaces no longer match the blueprint. Read-only — paths and actions only, never file contents. The operator reconciles with the provision CLI. Each row is { role, harness, destination, action, drift }; `drifted` counts drifted rows, 0 means in sync. One unreadable destination makes the whole report refuse.",
      inputSchema: { project: z.string().min(1).max(128) },
    },
    async ({ project }, extra) => run("provision_status", project, extra.sessionId),
  );

  server.registerTool(
    "provision_plan",
    {
      title: "Provision plan",
      description:
        "Advisory plan for a registered project: what applying its blueprint would change. Read-only — paths and actions only, never file contents. Only the operator can apply. Each row is { role, harness, destination, action, drift }; `changes` counts rows that would change, 0 means nothing to apply.",
      inputSchema: { project: z.string().min(1).max(128) },
    },
    async ({ project }, extra) => run("provision_plan", project, extra.sessionId),
  );
}

export type ProvisionPayload =
  | { ok: true; tool: ProvisionTool; project: string; projectRoot: string; rows: DiffRow[]; changes?: number; drifted?: number }
  | { ok: false; tool: ProvisionTool; project: string; refusal: "unknown-project" | "survey-refused" | "internal-error"; error: string };

/** The tool body, pure of MCP plumbing so the suite can drive it directly. */
export function propose(tool: ProvisionTool, project: string, dataDir?: string): ProvisionPayload {
  // KTD11: the ONE bridge from an agent-supplied string to disk. An unknown name stops here — no path is built.
  const resolvedDataDir = resolveDataDir(dataDir);
  const lookup = lookupProject(project, resolvedDataDir);
  if (lookup.kind === "unknown") {
    return {
      ok: false,
      tool,
      project,
      refusal: "unknown-project",
      error: `'${project}' is not a registered project — the operator registers projects with the provision CLI's \`init\``,
    };
  }
  const { projectRoot, blueprintRoot } = lookup.record;
  const surveyed = survey(projectRoot, blueprintRoot, resolvedDataDir);
  if (!surveyed.ok) return { ok: false, tool, project, refusal: "survey-refused", error: surveyed.error };
  return tool === "provision_plan"
    ? { ok: true, tool, project, projectRoot, ...planView(surveyed.rows) }
    : { ok: true, tool, project, projectRoot, ...statusView(surveyed.rows) };
}
