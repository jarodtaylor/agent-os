/**
 * The Brain MCP tools (U4) — the agent-facing surface over the substrate. Three tools, each registered on
 * a per-session `McpServer` (see server.ts) and each logging its call to the access log, the ONE place
 * substrate CONSUMPTION is measured (repo reads don't self-log; repo.ts decision #4).
 *
 *   read_work_state  — resume payload, REDACTED through the shared response path.
 *   write_handoff    — the one substrate write path; validates the external payload at the boundary (U2-R1).
 *   query_breadcrumbs — raw-lane trail after a cursor, each crumb REDACTED through the choke-point.
 *
 * Identity model (the plan left write-attribution underspecified): `sessionId` is the transport session id
 * (extra.sessionId — distinct per connection, so KTD8 concurrent handoffs never clobber); `machineId` is
 * server-supplied (v1: os.hostname()); `ts` is server-stamped; `source` is a VALIDATED tool input — the
 * harness self-declares it (trustworthy in v1: the harnesses are the user's own, behind the loopback+token
 * gate) and the SDK checks it against the closed `Source` enum at the boundary.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { Breadcrumb, Cursor, Handoff, Source } from "../contract/index";
import { redact } from "../redact/apply";
import type { Repo } from "../store/repo";
import { DEFAULT_TRAIL_CAP, readWorkStateResponse } from "../workstate/response";

export interface McpDeps {
  repo: Repo;
  /** This machine's federation id, stamped onto every record written here (v1: os.hostname()). */
  machineId: string;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** Register the three Brain tools on a (per-session) `McpServer`. */
export function registerBrainTools(server: McpServer, deps: McpDeps): void {
  const now = deps.now ?? Date.now;
  // Best-effort harness label for the access log: the connected MCP client's declared name.
  const harnessLabel = (): string => server.server.getClientVersion()?.name ?? "unknown";

  server.registerTool(
    "read_work_state",
    {
      title: "Read work state",
      description: "Resume payload for a project: the curated handoff (if any) plus the recent raw trail, redacted.",
      inputSchema: { project: z.string().min(1) },
    },
    async ({ project }, extra) => {
      const resp = await readWorkStateResponse(
        deps.repo,
        project,
        { harness: harnessLabel(), tool: "read_work_state", sessionId: extra.sessionId },
        { now: now() },
      );
      return { content: [{ type: "text", text: JSON.stringify(resp) }] };
    },
  );

  server.registerTool(
    "write_handoff",
    {
      title: "Write handoff",
      description: "Persist a curated 'pick up here' handoff for a project — the one substrate write path.",
      // U2-R1 (boundary layer 1): the SDK validates this external payload against the contract schemas
      // (cursor via `Cursor`, source via the closed `Source` enum) BEFORE the handler runs.
      inputSchema: { project: z.string().min(1), source: Source, cursor: Cursor },
    },
    async ({ project, source, cursor }, extra) => {
      const ts = now();
      const sessionId = extra.sessionId ?? "unknown-session";
      // U2-R1 (boundary layer 2): re-validate the FULLY-assembled record against the contract before it
      // reaches the repo — never trust TS types at a write boundary, and this catches a bad server-supplied
      // field (e.g. an empty sessionId) too.
      const handoff = Handoff.parse({ project, sessionId, machineId: deps.machineId, source, cursor, ts });
      await deps.repo.writeHandoff(handoff);
      await deps.repo.logAccess({ sessionId, harness: harnessLabel(), tool: "write_handoff", project, ts });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, project, sessionId }) }] };
    },
  );

  server.registerTool(
    "query_breadcrumbs",
    {
      title: "Query breadcrumbs",
      description: "Raw-lane breadcrumbs for a project strictly after `since` (a forward cursor), redacted.",
      inputSchema: { project: z.string().min(1), since: z.number().int().nonnegative() },
    },
    async ({ project, since }, extra) => {
      // Bound the response to one page (U2-R6) — the OLDEST-N after `since`; a caller pages by advancing
      // `since` to the last returned crumb's ts.
      const crumbs = await deps.repo.queryBreadcrumbs(project, since, DEFAULT_TRAIL_CAP);
      const redacted = crumbs.map((b) => redact(b, Breadcrumb));
      await deps.repo.logAccess({
        sessionId: extra.sessionId,
        harness: harnessLabel(),
        tool: "query_breadcrumbs",
        project,
        ts: now(),
      });
      return { content: [{ type: "text", text: JSON.stringify(redacted) }] };
    },
  );
}
