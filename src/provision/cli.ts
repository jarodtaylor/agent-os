/**
 * The provisioning CLI (U10 U6 — R12/R15/R17/R18, F1, KTD5/KTD11) — the OPERATOR's surface, and the only
 * surface that may write a harness (#33: agents propose through U7's MCP tools, they never apply).
 *
 * Five verbs over one pipeline: `init` (seed a blueprint into a project), `plan` (render + diff, dry run),
 * `apply` (the write), `status` (drift report), `undo` (reverse a batch).
 *
 * ── Two invariants this module exists to hold ──
 *
 * 1. REALPATH AT INGRESS (issue #51.1). The operator's project path is canonicalized to a realpath EXACTLY
 *    ONCE, here, at the boundary — and that canonical root is what flows into the known-projects registry,
 *    into `apply`'s `projectRoot` (hence into every undo-journal entry), and into `undoBatch`'s lookup.
 *    `apply`/`runs` canonicalize only LEXICALLY (`posix.normalize`), so a root reached through a SYMLINK
 *    (`/link/p` vs `/real/p`) would otherwise key apart: two spellings could miss undo supersession, and an
 *    explicit older-batch undo could clobber a newer batch. The fix belongs at the boundary — one place that
 *    knows what the operator typed — not inside the pure journal reader. ORDERING, since realpath throws
 *    ENOENT on a path that does not exist yet:
 *      - `init`   — absent ⇒ create the directory, THEN realpath (a fresh project must be initializable, the
 *                   `git init <dir>` precedent); a path that exists as a non-directory is refused, never
 *                   mkdir'd over.
 *      - everything else — absent ⇒ typed refusal pointing at `init`. No verb but `init` creates anything.
 *
 * 2. NO CONTENT ECHO (KTD5 / decision #45's threat model: no secret escapes any read path). No verb — not
 *    even `status`, whose whole job is reporting divergence — puts a byte of blueprint or live-surface content
 *    into `text`, into `--json`, or into an error. Every message here is built from PATHS, ROLES, HARNESSES,
 *    ACTIONS, and structural problem CODES, all of which arrive pre-sanitized from the loader/render/diff
 *    layers. That is why the drift report says WHICH file drifted and never HOW.
 *
 * TESTABILITY: `runCli(argv, ctx)` is a pure-ish function returning `{ exitCode, text, json }` — no
 * `process.exit`, no ambient cwd, an injectable `dataDir` — so the suite drives every verb in-process and one
 * spawn test proves the `package.json` wiring. The `import.meta.main` block below is the only I/O adapter.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, posix, resolve } from "node:path";
import type { Manifest, Runtime } from "../contract/index";
import { resolveDataDir } from "../paths";
import { apply, type ApplyOutcome } from "./apply";
import { loadBlueprint } from "./blueprint";
import { diffRendered, type BlockedReason, type DiffError, type DiffRow } from "./diff";
import { containsSecret, errorText, hasMachineAbsolutePath, isNotFound, readDestinationBounded, readFileBounded } from "./internal";
import { renderBlueprint, type RenderError, type RenderIo } from "./render";
import { isLogicalProjectName, lookupProject, registerProject } from "./registry";
import { liveProvisionedTargets, undoBatch, type UndoOutcome } from "./runs";

/** The blueprint directory inside a project. A fixed convention (R1: "a plain directory plus a manifest,
 *  living in the project repo") so `init`, the CLI verbs, and the registry can never disagree about where a
 *  project's blueprint is; the registry still stores the resolved root explicitly, so relocating it later is a
 *  data change rather than a code change. */
export const BLUEPRINT_DIRNAME = "blueprint";

/** The cross-harness run file `init` scaffolds ONCE (R12). It is runtime state, deliberately NOT a target
 *  registry surface — so it cannot be named by a manifest row even by mistake, and `apply` can never write it. */
export const RUN_STATE_FILENAME = "RUN_STATE.md";

/** Where the seed's initial run-file content lives INSIDE the blueprint, so a project can tune the text it
 *  starts from. Read after the copy, written only when the project has no run file yet. */
const RUN_STATE_SEED_RELATIVE = "runtime/RUN_STATE.seed.md";

/** The shipped seed template (R17). Resolved from THIS MODULE's location, never from cwd: the operator runs
 *  this CLI from their own repo, so a cwd-relative or bare-relative path would find nothing (or, worse, find
 *  something else). `install/codex.ts` takes `repoRoot` as a parameter; the CLI has no caller to take it from. */
const SEED_ROOT = resolve(import.meta.dir, "..", "..", "templates", "blueprint-seed");

export type CliVerb = "init" | "plan" | "apply" | "status" | "undo";

/** One applied write, flattened for machine consumption. `undoable` is `undoId !== null` — an applied write
 *  with no journal entry (`AppliedButUnjournaledError`) is real on disk and cannot be reversed, and that fact
 *  must survive into the operator's report rather than being inferred from a missing field. */
export interface AppliedJson {
  path: string;
  action: string;
  created: boolean;
  undoable: boolean;
}

export interface PathProblem {
  path: string;
  error: string;
}

/**
 * The machine payload — one variant per verb, discriminated on `verb`. Every variant carries `ok` + `errors`
 * so failure is a FIELD rather than a separate shape: `apply` and `undo` can fail PARTIALLY (some writes
 * landed, some did not), which a success-or-error union cannot express honestly. Fields that a run never
 * reached are `null`, not absent, so a consumer never has to distinguish "missing" from "not applicable".
 *
 * Nothing here can carry file content: `rows` are the diff's own content-free rows, and every `error` string
 * originates in a typed loader/render/diff/apply result (paths and structural codes only).
 */
export type CliJson =
  | { verb: "usage"; ok: false; errors: string[] }
  | {
      verb: "init";
      ok: boolean;
      errors: string[];
      project: string | null;
      name: string | null;
      blueprintRoot: string | null;
      blueprintFiles: number;
      runState: "created" | "present" | "skipped";
      /** Non-fatal residue from an otherwise successful run — today, only a backup of the replaced blueprint
       *  that could not be removed. `ok` stays true (the project IS seeded and registered), but something is
       *  left on disk for a human, so it reports here rather than being dropped. Mirrors `apply.warnings`. */
      warnings: string[];
    }
  | { verb: "plan"; ok: boolean; errors: string[]; project: string | null; rows: DiffRow[]; changes: number }
  | { verb: "status"; ok: boolean; errors: string[]; project: string | null; rows: DiffRow[]; drifted: number }
  | {
      verb: "apply";
      /** ⚠️ `ok` (and therefore the exit code) reflects only whether every intended write LANDED — it is
       *  `errors.length === 0`. An applied-but-unjournaled write is a SUCCESS by that measure (the bytes are on
       *  disk) but is permanently un-undoable, and it reports ONLY in `warnings`. Automation that gates on the
       *  exit code alone will therefore treat such a run as fully clean AND fully reversible, which it is not:
       *  **check `warnings` too.** Asserted in `tests/provision-cli.test.ts` so it cannot change silently. */
      ok: boolean;
      errors: string[];
      warnings: string[];
      project: string | null;
      batchId: string | null;
      applied: AppliedJson[];
      noops: number;
      failed: PathProblem[];
      rolledBack: boolean;
    }
  | {
      verb: "undo";
      ok: boolean;
      errors: string[];
      project: string | null;
      batchId: string | null;
      reversed: string[];
      alreadyReversed: string[];
      superseded: PathProblem[];
      failed: PathProblem[];
    };

/** What a run produced: the exit code, the stream text (the human table, or the JSON payload under `--json`),
 *  which stream that text belongs on, and the structured payload. The caller decides what to do with them —
 *  `runCli` itself performs no I/O. */
export interface CliRun {
  exitCode: number;
  text: string;
  /** Where the adapter should write `text`. A `--json` payload is ALWAYS stdout so `… --json | jq` works on a
   *  failure too; human text for a failed run goes to stderr, so a human-mode pipe carries only real output. */
  stream: "stdout" | "stderr";
  json: CliJson;
}

/** The ambient inputs a run depends on, injected so tests never read the real cwd or the real data dir. */
export interface CliContext {
  cwd: string;
  dataDir?: string;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `agent-os provisioning

  bun run provision <verb> [options]

Verbs
  init      Copy the seed blueprint into a project and scaffold ${RUN_STATE_FILENAME} (once).
  plan      Render the blueprint and show exactly what would change. Writes nothing.
  apply     Write the blueprint into every harness surface. Reversible with undo.
  status    Report where a live surface has drifted from the blueprint. Writes nothing.
  undo      Reverse a provision batch (default: this project's newest committed one).

Options
  --project <path>   Project root (default: the current directory).
  --json             Emit the machine-readable payload instead of a table.
  --force            init only: replace an existing blueprint/ directory.
  --name <name>      init only: the logical project name (default: the directory name).
  --batch <id>       undo only: reverse a specific batch instead of the newest.`;

/** Flags each verb accepts. Per-verb rather than global so `plan --force` is a loud usage error instead of a
 *  silently ignored option that reads like it did something. */
const VERB_FLAGS: Readonly<Record<CliVerb, readonly string[]>> = {
  init: ["--project", "--json", "--force", "--name"],
  plan: ["--project", "--json"],
  apply: ["--project", "--json"],
  status: ["--project", "--json"],
  undo: ["--project", "--json", "--batch"],
};

interface ParsedArgs {
  verb: CliVerb;
  project: string | null;
  name: string | null;
  batch: string | null;
  json: boolean;
  force: boolean;
}

/**
 * Run one CLI invocation. Total: every failure path returns a `CliRun` with a non-zero exit code, so a caller
 * never needs a try/catch and a test never needs a process.
 */
export function runCli(argv: readonly string[], ctx: CliContext): CliRun {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return usage(parsed.error);

  const args = parsed.args;
  const rawProject = args.project ?? ctx.cwd;
  const dataDir = resolveDataDir(ctx.dataDir);

  switch (args.verb) {
    case "init":
      return runInit(rawProject, args, dataDir);
    case "plan":
      return runPlan(rawProject, args, dataDir);
    case "status":
      return runStatus(rawProject, args, dataDir);
    case "apply":
      return runApply(rawProject, args, dataDir);
    case "undo":
      return runUndo(rawProject, args, dataDir);
    default:
      return assertNever(args.verb);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): { ok: true; args: ParsedArgs } | { ok: false; error: string } {
  const [rawVerb, ...rest] = argv;
  if (rawVerb === undefined) return { ok: false, error: "no verb given" };
  if (!isVerb(rawVerb)) return { ok: false, error: `unknown verb '${rawVerb}'` };

  const args: ParsedArgs = { verb: rawVerb, project: null, name: null, batch: null, json: false, force: false };
  const allowed = VERB_FLAGS[rawVerb];

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!allowed.includes(flag)) {
      return { ok: false, error: `'${rawVerb}' does not accept '${flag}'` };
    }
    switch (flag) {
      case "--json":
        args.json = true;
        break;
      case "--force":
        args.force = true;
        break;
      default: {
        // Every remaining allowed flag takes a value; a missing one must not swallow the NEXT flag as its
        // argument (`--project --json` would silently provision a directory named "--json").
        const value = rest[++i];
        // An EMPTY value is refused too: `--batch "$BATCH_ID"` with the variable unset must not read as "no batch
        // named" and silently undo the newest one.
        if (value === undefined || value === "" || value.startsWith("--")) return { ok: false, error: `'${flag}' needs a value` };
        if (flag === "--project") args.project = value;
        else if (flag === "--name") args.name = value;
        else args.batch = value;
      }
    }
  }
  return { ok: true, args };
}

function isVerb(value: string): value is CliVerb {
  return value === "init" || value === "plan" || value === "apply" || value === "status" || value === "undo";
}

function usage(error: string): CliRun {
  const json: CliJson = { verb: "usage", ok: false, errors: [error] };
  // Usage text is always human: the flags were not parseable, so `--json` was never established.
  return { exitCode: EXIT_USAGE, text: `${error}\n\n${USAGE}`, stream: "stderr", json };
}

// ─────────────────────────────────────────────────────────────────────────────
// Project-root resolution (issue #51.1) — the one realpath, at the boundary
// ─────────────────────────────────────────────────────────────────────────────

/** `created` is true only when THIS run's mkdir brought the root into being (init's absent-path branch), so a
 *  later refusal can withdraw a directory the operator never asked for. Always false for the read verbs, which
 *  create nothing. */
type RootResolution = { ok: true; root: string; created: boolean } | { ok: false; error: string };

/** Canonicalize an EXISTING project root. Absent is a refusal pointing at `init` — no verb but `init` may
 *  bring a project into being, so a typo can never silently provision a fresh empty directory. */
function resolveExistingRoot(raw: string): RootResolution {
  let stats;
  try {
    stats = statSync(raw); // follows symlinks: a symlink to a directory IS a usable project root
  } catch (err) {
    if (isNotFound(err)) return { ok: false, error: `project root '${raw}' does not exist — run \`init\` first` };
    return { ok: false, error: `project root '${raw}' could not be inspected: ${errorText(err)}` };
  }
  if (!stats.isDirectory()) return { ok: false, error: `project root '${raw}' is not a directory` };
  return canonicalize(raw);
}

/** Canonicalize a project root for `init`, CREATING it when absent. A path that exists as a non-directory is
 *  refused rather than mkdir'd over — `init` may create a project, never replace a file with one. */
function resolveRootForInit(raw: string): RootResolution {
  try {
    const stats = statSync(raw);
    if (!stats.isDirectory()) return { ok: false, error: `project root '${raw}' is not a directory` };
  } catch (err) {
    if (!isNotFound(err)) return { ok: false, error: `project root '${raw}' could not be inspected: ${errorText(err)}` };
    try {
      mkdirSync(raw, { recursive: true });
    } catch (createErr) {
      return { ok: false, error: `project root '${raw}' could not be created: ${errorText(createErr)}` };
    }
    return canonicalize(raw, true);
  }
  return canonicalize(raw);
}

function canonicalize(raw: string, created = false): RootResolution {
  try {
    return { ok: true, root: realpathSync(raw), created };
  } catch (err) {
    return { ok: false, error: `project root '${raw}' could not be resolved: ${errorText(err)}` };
  }
}

const blueprintRootFor = (projectRoot: string): string => join(projectRoot, BLUEPRINT_DIRNAME);

// ─────────────────────────────────────────────────────────────────────────────
// The shared front-gate + render/diff core (KTD5) — plan and status both run it
// ─────────────────────────────────────────────────────────────────────────────

type Gated = { ok: true; manifest: Manifest } | { ok: false; error: string };

/**
 * The KTD5 front-gate, translated from the loader's typed result into ONE operator-facing message per failure
 * mode. Every verb that reads a blueprint runs this — `status` included, which is the case the rule exists
 * for: a drift report that materialized a secret-bearing blueprint would be a read path a secret escapes on.
 * `undo` deliberately does NOT gate: it reverses journal entries and reads no blueprint, and gating it would
 * make a blueprint that later grew a secret impossible to un-apply.
 */
function gate(blueprintRoot: string): Gated {
  const load = loadBlueprint(blueprintRoot);
  switch (load.kind) {
    case "loaded":
      return { ok: true, manifest: load.manifest };
    case "absent":
      return { ok: false, error: `no blueprint manifest at '${load.manifestPath}' — run \`init\` to create one` };
    case "schema-incompatible":
      return { ok: false, error: load.message };
    case "secret-hit":
      // Names the FILE, never the match: the whole point of the gate is that these bytes do not travel.
      return { ok: false, error: `blueprint file '${load.file}' failed the secret gate — refusing to provision (its content is not shown)` };
    case "invalid":
      return { ok: false, error: `blueprint file '${load.file}' is invalid (${load.problem})${load.detail ? `: ${load.detail}` : ""}` };
    default:
      return assertNever(load);
  }
}

type Surveyed = { ok: true; rows: DiffRow[] } | { ok: false; error: string };

/**
 * Render + diff a project's blueprint against its live surfaces — the read half of the pipeline, shared by
 * `plan` and `status` so the two can never disagree about what "changed" means. `apply` does NOT call this:
 * it re-renders internally from the current blueprint (KTD7), which is what closes the stale-plan TOCTOU. So
 * this is a second CALL SITE of the same pure core, not a second implementation of it.
 */
function survey(projectRoot: string, blueprintRoot: string, dataDir: string): Surveyed {
  const gated = gate(blueprintRoot);
  if (!gated.ok) return gated;

  const io: RenderIo = {
    readSource: (source) => readFileBounded(posix.join(blueprintRoot, source)),
    readDestination: (destination) => readFileBounded(posix.join(projectRoot, destination)),
  };
  const rendered = renderBlueprint(gated.manifest, io);
  if (!rendered.ok) return { ok: false, error: renderErrorText(rendered.error) };

  // The journal tells a deleted provisioned surface (drift) from one nothing ever wrote (not drift) — see `diff.ts`.
  const live = liveProvisionedTargets(projectRoot, dataDir);
  const diffed = diffRendered(
    rendered.files,
    (destination) => readDestinationBounded(posix.join(projectRoot, destination)),
    (destination) => live.has(posix.join(projectRoot, destination)),
  );
  if (!diffed.ok) return { ok: false, error: diffErrorText(diffed.error) };
  return { ok: true, rows: diffed.rows };
}

/** Content-free render/diff failure text — the same shapes `apply` reports, so a failure reads identically
 *  whichever verb surfaced it. Both consume only role/harness/destination/source/problem-code fields. */
function renderErrorText(error: RenderError): string {
  const where = `role '${error.role}' (${error.harness}) → '${error.destination}'`;
  return "source" in error ? `render ${error.problem} for ${where} from '${error.source}'` : `render ${error.problem} for ${where}`;
}

/** Operator-facing remedy per blocked cause — fixed strings selected by a fixed enum, never derived from bytes. */
const BLOCKED_REMEDY: Readonly<Record<BlockedReason, string>> = {
  symlink: "it is a symlink — provisioning never reads or writes through an indirection; replace it with a real file",
  oversized: "it is larger than the 16 MiB read bound",
  "non-regular": "it is not a regular file (a directory, FIFO, or device)",
  unreadable: "it could not be read (check its permissions)",
};

function diffErrorText(error: DiffError): string {
  const where = `diff ${error.problem} for role '${error.role}' (${error.harness}) → '${error.destination}'`;
  // Name the CAUSE when the reader knew it. A blocked destination aborts the whole run, so "unreadable-destination"
  // alone leaves the operator with no idea that removing one symlink unblocks every other surface. Fixed strings
  // selected by a fixed enum — no bytes, so the no-content-echo rule is untouched.
  const remedy = "blockedBy" in error && error.blockedBy ? ` — ${BLOCKED_REMEDY[error.blockedBy]}` : "";
  return `${where}${remedy}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// init
// ─────────────────────────────────────────────────────────────────────────────

function initFailure(args: ParsedArgs, error: string, project: string | null = null): CliRun {
  const json: CliJson = {
    verb: "init",
    ok: false,
    errors: [error],
    project,
    name: null,
    blueprintRoot: null,
    blueprintFiles: 0,
    runState: "skipped",
    warnings: [],
  };
  return render(args, json, error, EXIT_FAILED);
}

/**
 * Seed a project (F1). Ordered so that NOTHING is written until every refusal has had its chance — the same
 * preflight-then-write discipline `apply` uses:
 *   1. gate the SHIPPED SEED itself, before it is copied anywhere. A seed that carries a secret or a
 *      machine-absolute path must fail as a pure read, not as a half-copied blueprint.
 *   2. resolve (and, only here, create) the project root.
 *   3. refuse a name already bound to a different project, BEFORE copying.
 *   4. refuse a surviving backup from an unfinished `--force`, then an existing blueprint unless `--force`.
 *   5. stage the copy → set any existing blueprint aside → install → scaffold the run file → register → drop
 *      the backup. Every failure from the install onward puts the operator's blueprint back.
 */
function runInit(rawProject: string, args: ParsedArgs, dataDir: string): CliRun {
  // (1) The shipped seed must pass the same front-gate a hand-authored blueprint does (R4/KTD5).
  const seed = gate(SEED_ROOT);
  if (!seed.ok) return initFailure(args, `the shipped seed template at '${SEED_ROOT}' is not provisionable: ${seed.error}`);

  // (2) The one realpath (issue #51.1). `init` is the only verb that may create the root.
  const resolved = resolveRootForInit(rawProject);
  if (!resolved.ok) return initFailure(args, resolved.error);
  const projectRoot = resolved.root;
  const blueprintRoot = blueprintRootFor(projectRoot);
  const name = args.name ?? basename(projectRoot);

  /**
   * Refuse, withdrawing a project directory THIS run created (step 2 mkdirs before the checks below can run,
   * because `realpath` throws on a path that does not exist yet). Without this, a mistyped `--project` plus any
   * later refusal left a stray empty directory at the wrong path and never mentioned it — and the contract this
   * function states is that nothing is written until every refusal has had its chance.
   *
   * Removal is doubly guarded: only a root this run created, and — via `rmdirSync` — only while it is still
   * EMPTY. `rmdirSync` is the right primitive precisely because it REFUSES a non-empty directory itself, so the
   * guard cannot lose a race with something landing inside between a check and a delete; an operator-supplied
   * path is the last thing to recursively delete on a guess. A directory that survives is named in the message
   * rather than silently abandoned.
   */
  const refuse = (error: string): CliRun => {
    if (!resolved.created) return initFailure(args, error, projectRoot);
    try {
      rmdirSync(projectRoot);
      return initFailure(args, error, projectRoot);
    } catch {
      // Non-empty, or removal failed — keep it, and say so rather than leaving a stray directory unmentioned.
      return initFailure(args, `${error} (the directory '${projectRoot}' was created and left in place)`, projectRoot);
    }
  };

  // (3a) Name SHAPE preflight (KTD11). `registerProject` re-checks this at write time, but that runs at step
  //      (5) — after the seed is copied and the run file scaffolded — so an unusable name used to leave a
  //      SEEDED BUT UNREGISTERED project that no verb can recover: U7 can never resolve it, and re-running
  //      `init` demands `--force`, which deletes the blueprint the operator may already have tuned. This is
  //      reachable from ordinary argv (`--name a/b`) and even from the DEFAULT name (a directory whose name
  //      carries a trailing space fails the trim rule). The check belongs in the preflight, which is what this
  //      function's contract promises: nothing is written until every refusal has had its chance.
  if (!isLogicalProjectName(name)) {
    return refuse(
      `'${name}' is not a usable logical project name (no path separators, no NUL, no leading/trailing whitespace, 1–128 chars) — re-run with --name <other>`,
    );
  }

  // (3b) Name COLLISION preflight (KTD11). A basename collision between two repos would otherwise silently
  //      rebind every U7 lookup for the first one, so it is refused here — before any file is touched.
  const existing = lookupProject(name, dataDir);
  if (existing.kind === "found" && existing.record.projectRoot !== projectRoot) {
    return refuse(
      `the project name '${name}' is already registered to '${existing.record.projectRoot}' — re-run with --name <other> to register this one under a different logical name`,
    );
  }

  // (4a) A SURVIVING BACKUP is a previous `--force` that never finished: it was killed mid-transaction (so
  //      `blueprint/` may be missing, or hold a replacement the operator never approved) or its final cleanup
  //      failed. That directory holds the operator's hand-tuned original — the one thing here nothing can
  //      rebuild — so BOTH `init` and `init --force` refuse until a human has decided its fate. Auto-recovery
  //      is deliberately NOT attempted: only the operator knows whether the backup or what is at `blueprint/`
  //      is the version they want, and guessing wrong destroys the answer. Fail closed, name the path, name
  //      both remedies. (Staging `.tmp` leftovers are NOT guarded: they hold nothing but a copy of the shipped
  //      seed, so stepping over one loses nothing.)
  const backups = findBlueprintBackups(projectRoot);
  if (!backups.ok) return refuse(backups.error);
  if (backups.paths.length > 0) {
    const named = backups.paths.map((path) => `'${path}'`).join(", ");
    return refuse(
      `a previous 'init --force' left a backup of this project's blueprint behind (at ${named}) — it holds the blueprint as it was before that run: restore it (rename it to '${blueprintRoot}') or remove it, then re-run`,
    );
  }

  // (4b) An existing blueprint is the operator's hand-tuned source of truth: never replaced implicitly.
  const blueprintExists = existsSync(blueprintRoot);
  if (blueprintExists && !args.force) {
    return refuse(`a blueprint already exists at '${blueprintRoot}' — re-run with --force to replace it`);
  }

  // (5) Write, as a RECOVERABLE TRANSACTION: stage → set the original aside → install → finish → drop the
  //     backup. `--force` is the one mutation in this system with no journal and no undo — every other write
  //     goes through the config-write engine precisely so it is reversible — and `blueprint/` may hold weeks of
  //     hand-tuning, so this path builds its own reversal by hand.
  //
  //     Staging alone (copy into a sibling temp dir, then one POSIX rename — the same temp-then-rename
  //     discipline as `configwrite`'s `restoreAtomically`) only shrinks the DESTRUCTIVE window; it does not
  //     close it. The original was still DELETED before the replacement landed, and two more steps that can
  //     fail — scaffolding `RUN_STATE.md` and registering the project — ran with nothing on the machine to put
  //     back. So the original is RENAMED aside instead of removed, and every failure from the install onward
  //     restores it.
  const staging = `${blueprintRoot}.${randomUUID()}${STAGING_SUFFIX}`;
  const discardStaging = (): void => rmSync(staging, { recursive: true, force: true });
  let blueprintFiles: number;
  try {
    mkdirSync(staging, { recursive: true });
    blueprintFiles = copyTree(SEED_ROOT, staging);
  } catch (err) {
    discardStaging();
    return initFailure(args, `copying the seed blueprint into '${blueprintRoot}' failed: ${errorText(err)}`, projectRoot);
  }

  let backup: string | null = null;
  if (blueprintExists) {
    // The lstat guard still runs, and still runs FIRST: `--force` is an opt-in to replacing a blueprint, not a
    // licence to move a file or a symlink pointing out of the project.
    const guard = guardReplaceableBlueprint(blueprintRoot);
    if (guard) {
      discardStaging();
      return initFailure(args, guard, projectRoot);
    }
    backup = `${blueprintRoot}.${randomUUID()}${BACKUP_SUFFIX}`;
    try {
      renameSync(blueprintRoot, backup);
    } catch (err) {
      discardStaging();
      return initFailure(args, `setting the existing blueprint at '${blueprintRoot}' aside failed: ${errorText(err)}`, projectRoot);
    }
  }

  /**
   * Fail from the install onward: put the operator's blueprint back, and NEVER claim a restore that did not
   * happen. Same honesty `apply` owes through `rollbackFailures` — a reversal that itself failed is surfaced
   * with what is still on disk and where, rather than being absorbed by the wording of the failure it followed.
   */
  // Set once `scaffoldRunState` reports it CREATED the run file, so `abort` can withdraw exactly that file and
  // nothing else. Null whenever the run file predated this run or was never written.
  let scaffolded: { path: string; content: string } | null = null;
  // Set once the staged seed is renamed into place on a project that had NO blueprint, so `abort` can withdraw it.
  let installedFresh = false;

  const abort = (error: string): CliRun => {
    // Withdraw a run file THIS transaction created, before restoring the blueprint. Scoped hard: only when we
    // created it (never one that predated the run — R12 says an existing run file is the operator's) and only
    // while it still holds exactly the bytes we wrote, so a run file the operator has already started editing
    // is left alone. Without this, a registration failure rolled the blueprint back but left the new RUN_STATE.md
    // standing, and since `init` treats any present run file as authoritative it would never be repaired.
    if (scaffolded !== null) {
      try {
        if (readFileSync(scaffolded.path, "utf8") === scaffolded.content) rmSync(scaffolded.path, { force: true });
      } catch {
        // Unreadable or already gone — leave it; the blueprint restore below is the load-bearing half.
      }
    }
    if (!backup) {
      // FRESH init: there is no prior blueprint to restore, but the one THIS transaction installed must go too, or
      // a plain retry refuses on "blueprint exists" and recovery needs `--force` (gate round 9). Safe to remove
      // whole: it was installed moments ago in this same synchronous run, so no operator edit can be inside it.
      if (!installedFresh) return initFailure(args, error, projectRoot);
      try {
        rmSync(blueprintRoot, { recursive: true, force: true });
      } catch (err) {
        return initFailure(args, `${error} — AND withdrawing the just-installed blueprint at '${blueprintRoot}' failed (${errorText(err)}): remove it by hand before re-running 'init'`, projectRoot);
      }
      return initFailure(args, `${error} — the just-installed blueprint was withdrawn; fix the cause and re-run 'init'`, projectRoot);
    }
    const failure = restoreBlueprintBackup(blueprintRoot, backup);
    return initFailure(
      args,
      failure === undefined
        ? `${error} — the existing blueprint at '${blueprintRoot}' was restored`
        : `${error} — AND restoring the existing blueprint failed: ${failure}. It is intact at '${backup}': rename it to '${blueprintRoot}' to recover`,
      projectRoot,
    );
  };

  try {
    renameSync(staging, blueprintRoot);
  } catch (err) {
    discardStaging();
    return abort(`installing the seed blueprint at '${blueprintRoot}' failed: ${errorText(err)}`);
  }
  installedFresh = !blueprintExists;

  const runState = scaffoldRunState(projectRoot, blueprintRoot);
  if (!runState.ok) return abort(runState.error);
  if (runState.state === "created") scaffolded = { path: join(projectRoot, RUN_STATE_FILENAME), content: runState.content };

  const registration = registerProject(dataDir, { name, projectRoot, blueprintRoot });
  if (registration.kind !== "registered") {
    const detail =
      registration.kind === "conflict"
        ? `it is already registered to '${registration.existing.projectRoot}'`
        : registration.kind === "invalid-name"
          ? "it is not a usable logical project name (no path separators, no NUL, 1–128 chars)"
          : registration.error;
    return abort(`seeding succeeded, but registering the project as '${name}' failed: ${detail}`);
  }

  // COMMIT. Everything that can fail has succeeded, so the backup has no job left — and leaving it would wedge
  // the next `init` on the (4a) guard. A removal that fails is a warning, not a failure: the run really did
  // seed and register the project, and saying otherwise would push the operator back into `--force`.
  const warnings: string[] = [];
  if (backup) {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (err) {
      warnings.push(
        `the replaced blueprint's backup at '${backup}' could not be removed (${errorText(err)}) — remove it by hand; until it is gone, the next 'init' will refuse`,
      );
    }
  }

  const json: CliJson = {
    verb: "init",
    ok: true,
    errors: [],
    project: projectRoot,
    name,
    blueprintRoot,
    blueprintFiles,
    runState: runState.state,
    warnings,
  };
  const lines = [
    `Seeded ${blueprintFiles} blueprint file${blueprintFiles === 1 ? "" : "s"} into ${blueprintRoot}`,
    `Registered as project '${name}'`,
    runStateLine(runState.state, projectRoot),
    ...warnings.map((warning) => `Warning: ${warning}`),
    "",
    "Next: tune blueprint/, then `plan` to see what would change.",
  ];
  return render(args, json, lines.join("\n"), EXIT_OK);
}

function runStateLine(state: "created" | "present" | "skipped", projectRoot: string): string {
  switch (state) {
    case "created":
      return `Scaffolded ${join(projectRoot, RUN_STATE_FILENAME)}`;
    case "present":
      return `Left the existing ${RUN_STATE_FILENAME} untouched (it is runtime state, never provisioned)`;
    case "skipped":
      return `No ${RUN_STATE_SEED_RELATIVE} in the blueprint — ${RUN_STATE_FILENAME} was not scaffolded`;
    default:
      return assertNever(state);
  }
}

/** Sibling of `blueprint/` holding a COMPLETE copy of the seed that has not been installed yet. Disposable:
 *  its contents are the shipped template, so nothing is lost by removing one. */
const STAGING_SUFFIX = ".tmp";

/** Sibling of `blueprint/` holding the operator's PREVIOUS blueprint during a `--force` run. Precious: while
 *  it exists it may be the only copy of weeks of hand-tuning, which is why `init` refuses to run past one. */
const BACKUP_SUFFIX = ".bak";

/** Matches ONLY the backup names this module creates — `blueprint.<uuid v4>.bak`. Deliberately narrow: an
 *  operator's own `blueprint.old.bak` is their business and must not wedge `init`, and the guard's whole value
 *  is that a match means "a run of THIS code did not finish". */
const BLUEPRINT_BACKUP_PATTERN = new RegExp(
  // `.replace` escapes the suffix's leading dot — a bare `.` here would match `blueprint.<uuid>Xbak` too.
  `^${BLUEPRINT_DIRNAME}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${BACKUP_SUFFIX.replace(".", "\\.")}$`,
  "i",
);

type BackupScan = { ok: true; paths: string[] } | { ok: false; error: string };

/** Every surviving `--force` backup in `projectRoot`, sorted for a deterministic message. Fail-closed: a root
 *  we cannot read is an error, not an empty answer — "no backups" must mean we looked, or the guard that
 *  protects the operator's only copy would be silently skippable. `isDirectory()` on a dirent is lstat-grade,
 *  so a symlink wearing a backup name never counts (this code only ever creates real directories). */
function findBlueprintBackups(projectRoot: string): BackupScan {
  let entries;
  try {
    entries = readdirSync(projectRoot, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `'${projectRoot}' could not be inspected: ${errorText(err)}` };
  }
  const paths = entries
    .filter((entry) => entry.isDirectory() && BLUEPRINT_BACKUP_PATTERN.test(entry.name))
    .map((entry) => join(projectRoot, entry.name))
    .sort();
  return { ok: true, paths };
}

/** May `--force` move this `blueprint/` aside? Returns an error string, or `undefined` if it may. Refuses
 *  anything that is not a real directory: `--force` is an opt-in to replacing a blueprint, NOT a licence to
 *  move a file or follow a symlink out of the project and put the seed somewhere else entirely. */
function guardReplaceableBlueprint(blueprintRoot: string): string | undefined {
  let stats;
  try {
    stats = lstatSync(blueprintRoot);
  } catch (err) {
    return `'${blueprintRoot}' could not be inspected: ${errorText(err)}`;
  }
  if (stats.isSymbolicLink()) return `'${blueprintRoot}' is a symlink — refusing to replace it`;
  if (!stats.isDirectory()) return `'${blueprintRoot}' is not a directory — refusing to replace it`;
  return undefined;
}

/**
 * Put a `--force` backup back where it came from, discarding whatever this run installed. Returns `undefined`
 * on success, or the reason it could not — NEVER throws, and never reports a partial recovery as a recovery:
 * the caller has already failed once, and its next act is to tell the operator what is on their disk.
 *
 * Exported for direct fault-injection coverage. This is the last line of defence for the one directory the
 * system cannot rebuild, and its failure branch is unreachable through the CLI (it needs the filesystem to
 * turn hostile between the swap and the failure), so it is tested here rather than left to review.
 */
export function restoreBlueprintBackup(blueprintRoot: string, backup: string): string | undefined {
  try {
    // Whatever is at `blueprintRoot` is this run's own freshly-installed seed copy (or nothing, if the install
    // itself failed) — never operator content, which by now lives in `backup`.
    rmSync(blueprintRoot, { recursive: true, force: true });
    renameSync(backup, blueprintRoot);
  } catch (err) {
    return errorText(err);
  }
  return undefined;
}

/** Recursively copy the seed's regular files, returning how many were written. Only directories and regular
 *  files are copied: the shipped seed is plain files by construction, and silently materializing a symlink or
 *  a device node from a template would be a surprise a project could not see in its own diff. */
function copyTree(from: string, to: string): number {
  let count = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      count += copyTree(source, destination);
    } else if (entry.isFile()) {
      copyFileSync(source, destination);
      count += 1;
    }
  }
  return count;
}

/** `content` is present only on `"created"` — the exact bytes written, so an aborting transaction can withdraw
 *  the file it made while leaving one the operator has since edited strictly alone. */
type RunStateResult =
  | { ok: true; state: "created"; content: string }
  | { ok: true; state: "present" | "skipped" }
  | { ok: false; error: string };

/**
 * Scaffold `RUN_STATE.md` ONCE (R12). Present ⇒ left strictly alone, which is what makes a `--force` re-init
 * safe: the blueprint is configuration and replaceable, the run file is lived history and is not.
 *
 * The seed content is gated before it is written even though it is our own file: it lives in `blueprint/` but
 * is NOT manifest-referenced, so `loadBlueprint`'s source scan never sees it — and `init` materializes it into
 * the project. Scanning here keeps R4's promise ("no blueprint file carries a secret or a machine-absolute
 * path") true for every byte `init` writes, not just the manifest-referenced ones.
 */
function scaffoldRunState(projectRoot: string, blueprintRoot: string): RunStateResult {
  const target = join(projectRoot, RUN_STATE_FILENAME);
  // Guarded lstat, NOT `existsSync` — the same discipline `guardReplaceableBlueprint` below and the engine's
  // `statTarget` apply, and the reason is that this is the ONE write that bypasses the config-write engine
  // (RUN_STATE.md is deliberately not a target-registry surface, so `apply` can never touch it — R12). It
  // therefore bypasses the engine's symlink refusal too, and must re-state it here.
  //
  // `existsSync` FOLLOWS symlinks, so a DANGLING `RUN_STATE.md` symlink read as absent and `writeFileSync`
  // then followed it — landing the seed bytes at the link target ANYWHERE on the filesystem, unbacked-up and
  // unjournaled, while the run exited 0 reporting the in-project path it did not write. A false-success
  // misreport, and the one indirection this system never accepts. ENOENT alone means absent; anything else is
  // refused rather than written through.
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) {
      return { ok: false, error: `'${target}' is a symlink — refusing to scaffold ${RUN_STATE_FILENAME} through an indirection` };
    }
    return { ok: true, state: "present" }; // a real file already there is left strictly alone (R12)
  } catch (err) {
    if (!isNotFound(err)) return { ok: false, error: `'${target}' could not be inspected: ${errorText(err)}` };
  }

  const seed = readFileBounded(join(blueprintRoot, RUN_STATE_SEED_RELATIVE));
  if (!seed.ok) {
    // Absent ⇒ this blueprint simply does not carry run-file seed content; blocked ⇒ fail closed.
    return seed.reason === "absent"
      ? { ok: true, state: "skipped" }
      : { ok: false, error: `'${RUN_STATE_SEED_RELATIVE}' is present but unreadable — refusing to scaffold ${RUN_STATE_FILENAME}` };
  }
  if (containsSecret(seed.content) || hasMachineAbsolutePath(seed.content)) {
    return { ok: false, error: `'${RUN_STATE_SEED_RELATIVE}' failed the secret/portability gate — refusing to scaffold ${RUN_STATE_FILENAME}` };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, seed.content);
  } catch (err) {
    return { ok: false, error: `scaffolding '${target}' failed: ${errorText(err)}` };
  }
  return { ok: true, state: "created", content: seed.content };
}

// ─────────────────────────────────────────────────────────────────────────────
// plan / status — the two read verbs over one survey
// ─────────────────────────────────────────────────────────────────────────────

function runPlan(rawProject: string, args: ParsedArgs, dataDir: string): CliRun {
  const resolved = resolveExistingRoot(rawProject);
  if (!resolved.ok) {
    return render(args, { verb: "plan", ok: false, errors: [resolved.error], project: null, rows: [], changes: 0 }, resolved.error, EXIT_FAILED);
  }
  const projectRoot = resolved.root;

  const surveyed = survey(projectRoot, blueprintRootFor(projectRoot), dataDir);
  if (!surveyed.ok) {
    return render(args, { verb: "plan", ok: false, errors: [surveyed.error], project: projectRoot, rows: [], changes: 0 }, surveyed.error, EXIT_FAILED);
  }

  const rows = surveyed.rows;
  const changes = rows.filter((row) => row.action !== "noop" && row.action !== "scaffold-skip").length;
  const json: CliJson = { verb: "plan", ok: true, errors: [], project: projectRoot, rows, changes };
  const summary = changes === 0 ? "Nothing to change." : `${changes} of ${rows.length} rows would change.`;
  return render(args, json, `${rowTable(rows, { drift: false })}\n\n${summary}`, EXIT_OK);
}

/**
 * The drift report (F3/AE6). Scaffold rows are excluded outright (KTD8: create-once surfaces cannot drift by
 * definition, so listing them would train the operator to ignore the report). Drift is informational, so a
 * drifted project still exits 0 — a non-zero exit is reserved for a run that could not answer the question.
 */
function runStatus(rawProject: string, args: ParsedArgs, dataDir: string): CliRun {
  const resolved = resolveExistingRoot(rawProject);
  if (!resolved.ok) {
    return render(args, { verb: "status", ok: false, errors: [resolved.error], project: null, rows: [], drifted: 0 }, resolved.error, EXIT_FAILED);
  }
  const projectRoot = resolved.root;

  const surveyed = survey(projectRoot, blueprintRootFor(projectRoot), dataDir);
  if (!surveyed.ok) {
    return render(args, { verb: "status", ok: false, errors: [surveyed.error], project: projectRoot, rows: [], drifted: 0 }, surveyed.error, EXIT_FAILED);
  }

  const rows = surveyed.rows.filter((row) => row.action !== "scaffold-skip");
  const drifted = rows.filter((row) => row.drift).length;
  const json: CliJson = { verb: "status", ok: true, errors: [], project: projectRoot, rows, drifted };
  const summary =
    drifted === 0
      ? "No drift: every tracked surface matches the blueprint."
      : `${drifted} surface${drifted === 1 ? "" : "s"} drifted from the blueprint. Nothing was modified — \`apply\` to reconcile (the blueprint wins).`;
  return render(args, json, `${rowTable(rows, { drift: true })}\n\n${summary}`, EXIT_OK);
}

// ─────────────────────────────────────────────────────────────────────────────
// apply / undo — the two write verbs
// ─────────────────────────────────────────────────────────────────────────────

function applyPayload(overrides: Partial<Extract<CliJson, { verb: "apply" }>>): Extract<CliJson, { verb: "apply" }> {
  return {
    verb: "apply",
    ok: false,
    errors: [],
    warnings: [],
    project: null,
    batchId: null,
    applied: [],
    noops: 0,
    failed: [],
    rolledBack: false,
    ...overrides,
  };
}

function runApply(rawProject: string, args: ParsedArgs, dataDir: string): CliRun {
  const resolved = resolveExistingRoot(rawProject);
  if (!resolved.ok) return render(args, applyPayload({ errors: [resolved.error] }), resolved.error, EXIT_FAILED);
  const projectRoot = resolved.root;
  const blueprintRoot = blueprintRootFor(projectRoot);

  // The front-gate runs here, in the CLI, so a refusal is loud and content-free (KTD5). `apply` then RE-renders
  // from the same manifest internally — the plan a human just read is never the thing executed (KTD7).
  const gated = gate(blueprintRoot);
  if (!gated.ok) return render(args, applyPayload({ errors: [gated.error], project: projectRoot }), gated.error, EXIT_FAILED);

  const outcome = apply({ manifest: gated.manifest, blueprintRoot, projectRoot, dataDir });
  const json = applyJson(outcome, projectRoot);
  return render(args, json, applyText(outcome, json), json.ok ? EXIT_OK : EXIT_FAILED);
}

/** Exported for direct unit test: the unjournaled → `warnings` mapping is the operator-facing half of issue
 *  #51.2, and the CLI deliberately does NOT expose apply's engine-injection seam, so this pure
 *  ApplyOutcome → payload function is the honest place to prove it. */
export function applyJson(outcome: ApplyOutcome, projectRoot: string): Extract<CliJson, { verb: "apply" }> {
  // A rollback that itself failed left files on disk despite `rolledBack: true` — it is an ERROR, not a note.
  const errors = [
    ...outcome.failed.map((f) => `${f.path}: ${f.error}`),
    ...(outcome.rollbackFailures ?? []).map((f) => `rollback of '${f.path}' failed: ${f.error}`),
  ];
  // An applied-but-unjournaled write SUCCEEDED but cannot be reversed — a warning, since the write is live.
  const warnings = outcome.applied
    .filter((w) => w.unjournaled)
    .map((w) => `'${w.targetPath}' was written but could not be journaled — it cannot be undone (${w.unjournaled?.backupPath ? `restore from '${w.unjournaled.backupPath}'` : "delete it"} to revert by hand)`);

  return applyPayload({
    ok: errors.length === 0,
    errors,
    warnings,
    project: projectRoot,
    batchId: outcome.batchId,
    applied: outcome.applied.map((w) => ({ path: w.targetPath, action: w.action, created: w.created, undoable: w.undoId !== null })),
    noops: outcome.noops.length,
    failed: outcome.failed,
    rolledBack: outcome.rolledBack,
  });
}

/** Exported alongside `applyJson` for the same reason — the `WARNING:` line is the only human rendering of an
 *  un-undoable write. */
export function applyText(outcome: ApplyOutcome, json: Extract<CliJson, { verb: "apply" }>): string {
  const lines: string[] = [];
  if (json.applied.length > 0) {
    lines.push(
      table(
        ["ACTION", "UNDOABLE", "PATH"],
        json.applied.map((w) => [w.action, w.undoable ? "yes" : "NO", w.path]),
      ),
    );
  }
  lines.push(json.ok ? successSummary(json) : `Apply FAILED${outcome.rolledBack ? " and this batch's earlier writes were rolled back" : " before anything was written"}.`);
  for (const warning of json.warnings) lines.push(`WARNING: ${warning}`);
  for (const error of json.errors) lines.push(`ERROR: ${error}`);
  return lines.join("\n");
}

/**
 * The one-line verdict on a run that LANDED. The batch clause reads off `json.batchId`, the SAME field a `--json`
 * consumer sees, so the human text and the payload can never disagree about whether a batch exists (gate finding
 * 4) — a null id must never be rendered as "reverse it with `undo`", because following that instruction reversed
 * an OLDER real batch.
 *
 * A null id has TWO causes and they need different words. Usually it is the routine repeat apply where every row
 * diffed to a noop — genuinely "nothing changed". But it also covers the run whose every write LANDED and none
 * could be journaled (an unwritable journal with a writable project): there, `applied` is non-empty, files really
 * did change, and only the reversibility is missing. Saying "nothing changed" to that operator would be a fresh
 * lie in exactly the domain this fix hardens, so the two are split — the `WARNING:` lines below then name each
 * un-undoable file and how to revert it by hand.
 */
function successSummary(json: Extract<CliJson, { verb: "apply" }>): string {
  const counts = `Applied ${json.applied.length}, unchanged ${json.noops}.`;
  if (json.batchId !== null) return `${counts} Batch ${json.batchId} — reverse it with \`undo\`.`;
  return json.applied.length === 0
    ? `${counts} Nothing changed — no batch to reverse.`
    : `${counts} No reversible batch was recorded — \`undo\` cannot reverse this run.`;
}

function runUndo(rawProject: string, args: ParsedArgs, dataDir: string): CliRun {
  const resolved = resolveExistingRoot(rawProject);
  if (!resolved.ok) {
    const failure: CliJson = {
      verb: "undo",
      ok: false,
      errors: [resolved.error],
      project: null,
      batchId: null,
      reversed: [],
      alreadyReversed: [],
      superseded: [],
      failed: [],
    };
    return render(args, failure, resolved.error, EXIT_FAILED);
  }
  const projectRoot = resolved.root;

  const outcome: UndoOutcome = undoBatch(projectRoot, dataDir, args.batch ?? undefined);

  // An EXPLICIT `--batch` id that matched nothing must not read as a successful undo. `undoBatch` returns
  // all-empty buckets when the id matches no batch, and since every real batch has at least one journal entry,
  // all-four-empty means exactly "no batch was selected". Without this a typo'd id exits 0 with `ok: true` and
  // every bucket empty — the operator, and any automation gating on the exit code, reads a no-op as a completed
  // reversal of the run they named.
  //
  // Scoped to the explicit form ON PURPOSE. A BARE `undo` on a project with no batches stays an honest exit-0
  // no-op (pinned by its own test): the operator asked "reverse whatever is outstanding" and the truthful answer
  // is "nothing was". Naming an id that does not exist is a different act — a claim about a specific run that
  // turned out to be false, and the only way the operator learns their id was wrong.
  const unmatchedBatch =
    args.batch !== null &&
    outcome.reversed.length === 0 &&
    outcome.alreadyReversed.length === 0 &&
    outcome.superseded.length === 0 &&
    outcome.failed.length === 0;
  const unmatchedError = unmatchedBatch
    ? `no provision batch '${args.batch}' for project '${projectRoot}' — check the batch id reported by the \`apply\` that created it`
    : null;

  // A superseded entry was REFUSED, not reversed, so the run the operator named is still (partly) live — that is
  // not a completed undo, and automation gating on the exit code must not read it as one (gate round 5). Only a
  // bare `undo` can never hit this: its newest-live selection has no later live writer by construction.
  const refusals = [...outcome.superseded, ...outcome.failed];
  const json: CliJson = {
    verb: "undo",
    ok: refusals.length === 0 && unmatchedError === null,
    errors: unmatchedError ? [unmatchedError] : refusals.map((f) => `${f.path}: ${f.error}`),
    project: projectRoot,
    batchId: outcome.batchId,
    reversed: outcome.reversed,
    alreadyReversed: outcome.alreadyReversed,
    superseded: outcome.superseded,
    failed: outcome.failed,
  };
  return render(args, json, unmatchedError ?? undoText(outcome), json.ok ? EXIT_OK : EXIT_FAILED);
}

function undoText(outcome: UndoOutcome): string {
  if (outcome.batchId === null) {
    // A refusal before any batch was selected (lost terminal-state history) must not read as "nothing to undo".
    if (outcome.failed.length > 0) return ["Undo refused:", ...outcome.failed.map(({ path, error }) => `  FAILED    ${path}: ${error}`)].join("\n");
    return "Nothing to undo: this project has no reversible provision batch.";
  }
  const lines = [
    `Batch ${outcome.batchId}: reversed ${outcome.reversed.length}, already reversed ${outcome.alreadyReversed.length}.`,
    ...outcome.reversed.map((path) => `  reversed  ${path}`),
  ];
  // Superseded entries are a REFUSAL (a later batch owns those files now, so reversing this one would clobber
  // it) — labelled apart from FAILED because the operator's next move differs, though both fail the run.
  for (const { path, error } of outcome.superseded) lines.push(`  SUPERSEDED ${path}: ${error}`);
  for (const { path, error } of outcome.failed) lines.push(`  FAILED    ${path}: ${error}`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

/** Pick the stream text for this run: the JSON payload under `--json`, the human text otherwise. One place,
 *  so no verb can accidentally emit a table into a `--json` pipe. */
function render(args: ParsedArgs, json: CliJson, text: string, exitCode: number): CliRun {
  return {
    exitCode,
    text: args.json ? JSON.stringify(json, null, 2) : text,
    stream: args.json || exitCode === EXIT_OK ? "stdout" : "stderr",
    json,
  };
}

/**
 * The plan/status table. Deliberately plain text with NO colour: an action is a WORD and drift is the word
 * `drift`, so the report is readable in a pipe, in a log, and by a colourblind reader.
 *
 * The DRIFT column is `status`-only. `plan` answers "what would change", where every row is by definition a
 * change and a `drift` marker beside a `create` for a file that does not exist yet reads as a warning about
 * nothing. `status` answers "what diverged", which is exactly what the flag means.
 */
function rowTable(rows: readonly DiffRow[], options: { drift: boolean }): string {
  if (rows.length === 0) return "(no rows — the blueprint declares no files)";
  const headers = options.drift ? ["ACTION", "DRIFT", "ROLE", "HARNESS", "DESTINATION"] : ["ACTION", "ROLE", "HARNESS", "DESTINATION"];
  return table(
    headers,
    rows.map((row) => [
      row.action,
      ...(options.drift ? [row.drift ? "drift" : "-"] : []),
      row.role,
      harnessLabel(row.harness),
      row.destination,
    ]),
  );
}

const harnessLabel = (harness: Runtime): string => harness;

/** Left-aligned fixed-width columns. Cells are already content-free (paths, roles, harnesses, actions). */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

function assertNever(value: never): never {
  throw new Error(`provision cli: unhandled variant ${String(value)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Process adapter — the ONLY I/O in this module
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const run = runCli(process.argv.slice(2), { cwd: process.cwd() });
  const line = run.text.endsWith("\n") ? run.text : `${run.text}\n`;
  (run.stream === "stderr" ? process.stderr : process.stdout).write(line);
  process.exit(run.exitCode);
}
