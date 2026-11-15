/**
 * `bun run integrate <install|uninstall> [claude-code|codex]` — the operator entry point for the two harness
 * integrations (U6 Claude Code, U8 Codex), which until now were only reachable via `bun -e`. Thin by design:
 * every write/undo guarantee lives in the installers; this module only dispatches and reports.
 *
 * - No target ⇒ both harnesses. They are independent: one failing never stops the other (no cross-harness
 *   rollback — each installer is already all-or-nothing across its own files); any failure ⇒ exit 1.
 * - Output is PATHS + written/unchanged only — never config content (Codex `config.toml` carries the
 *   credential; decision #45's no-content-echo threat model).
 * - `runCli(argv, ctx)` takes an injectable `home`/`dataDir` so the suite never touches the real configs;
 *   the `import.meta.main` block is the only I/O adapter.
 */
import type { MergeResult } from "../configwrite/index";
import { installClaudeCode, uninstallClaudeCode } from "./claude-code";
import { installCodex, uninstallCodex } from "./codex";
import { errorText, type UninstallOutcome } from "./shared";

export interface CliContext {
  home?: string;
  dataDir?: string;
}

export interface CliResult {
  exitCode: number;
  lines: string[];
  errors: string[];
}

const USAGE = "usage: bun run integrate <install|uninstall> [claude-code|codex]";

const TARGETS = {
  "claude-code": {
    install: (ctx: CliContext): string[] => {
      const r = installClaudeCode(ctx);
      return [merged(r.settings), merged(r.mcp)];
    },
    uninstall: (ctx: CliContext): UninstallOutcome => uninstallClaudeCode(ctx),
  },
  codex: {
    install: (ctx: CliContext): string[] => {
      const r = installCodex(ctx);
      return [merged(r.config), merged(r.hooks), `${r.agentsMd.path}: ${r.agentsMd.changed ? "written" : "unchanged"}`];
    },
    uninstall: (ctx: CliContext): UninstallOutcome => uninstallCodex(ctx),
  },
} as const;

type Target = keyof typeof TARGETS;

function merged(r: MergeResult): string {
  return `${r.targetPath}: ${r.noop ? "unchanged" : "written"}`;
}

export function runCli(argv: string[], ctx: CliContext = {}): CliResult {
  const [verb, target, ...rest] = argv;
  const known = Object.keys(TARGETS) as Target[];
  if ((verb !== "install" && verb !== "uninstall") || rest.length > 0 || (target !== undefined && !known.includes(target as Target))) {
    return { exitCode: 2, lines: [], errors: [USAGE] };
  }

  const lines: string[] = [];
  const errors: string[] = [];
  for (const name of target ? [target as Target] : known) {
    try {
      if (verb === "install") {
        for (const line of TARGETS[name].install(ctx)) lines.push(`[${name}] ${line}`);
      } else {
        const { removed, failed, warnings } = TARGETS[name].uninstall(ctx);
        lines.push(`[${name}] removed: ${removed.join(", ") || "(nothing)"}`);
        for (const w of warnings) lines.push(`[${name}] warning: ${w.path}: ${w.error}`);
        for (const f of failed) errors.push(`[${name}] failed: ${f.path}: ${f.error}`);
      }
    } catch (err) {
      errors.push(`[${name}] ${verb} failed: ${errorText(err)}`);
    }
  }
  return { exitCode: errors.length > 0 ? 1 : 0, lines, errors };
}

if (import.meta.main) {
  const { exitCode, lines, errors } = runCli(process.argv.slice(2));
  for (const l of lines) console.log(`[agent-os] ${l}`);
  for (const e of errors) console.error(`[agent-os] ${e}`);
  process.exit(exitCode);
}
