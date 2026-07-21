/**
 * The blueprint loader + shared validation front-gate (U10 — R1/R2/R3/R4, KTD5/KTD10).
 *
 * Every provisioning verb (plan / apply / status / propose) runs THIS gate first, in THIS order (KTD5):
 *   1. manifest schema-VERSION compatibility — BEFORE strict schema parse, so a manifest written by a newer
 *      agent-os (carrying fields we don't know) yields an explicit "upgrade" instruction, never an opaque
 *      strictObject unrecognized-keys error (R1).
 *   2. strict manifest schema validation (the contract's `Manifest`).
 *   3. secret + machine-absolute-path classification over EVERY blueprint file's contents (the manifest
 *      itself and every referenced source), so nothing carrying a credential or a machine-specific path is
 *      ever certified for provisioning (R4).
 *
 * The loader is PURE and TOTAL: it returns a discriminated `BlueprintLoad` and NEVER throws for any input,
 * however malformed. Callers layer their own policy on the result — the CLI fails loud, the MCP tools return
 * typed refusals — the one-pure-extractor pattern (`src/codex-credential.ts`). Rendering is downstream (U3);
 * this unit only decides whether a blueprint is loadable and gate-clean.
 *
 * No-content-echo (R4/KTD5) is STRUCTURAL, not best-effort: a `secret-hit` or absolute-path `invalid` result
 * names the offending FILE only, `invalid` details are built from zod issue PATHS + CODES (never messages or
 * received values), `schema-incompatible` carries only version numbers, and the loader logs NOTHING — there
 * is no result field, error, or log line that can carry a blueprint byte.
 */
import { join } from "node:path";
import type { FileEntry } from "../contract/index";
import { Manifest } from "../contract/index";
import { type BlueprintIo, containsSecret, hasMachineAbsolutePath, realBlueprintIo } from "./internal";

/** The manifest file at the root of a blueprint directory. */
export const MANIFEST_FILENAME = "manifest.json";

/**
 * The manifest schema versions this engine understands. v1 is deliberately conservative (R1/KTD5 — "keep
 * version 1 conservative and additive"): the ONLY compatible version is 1. A manifest ABOVE the range was
 * written by a newer agent-os (⇒ upgrade agent-os); one BELOW predates the floor (⇒ migrate the blueprint).
 * The floor is a real forward-compat seam — when a future v2 drops v1 support, `MIN` rises and a v1 manifest
 * routes to the migration instruction with no other change.
 */
export const SUPPORTED_SCHEMA_VERSION = 1;
export const MIN_SCHEMA_VERSION = 1;

/** Why a blueprint is invalid — a STRUCTURAL code, never a message derived from blueprint content. */
export type InvalidProblem =
  | "unreadable-manifest" // present but not a readable regular file within bounds
  | "malformed-json" // the manifest is not parseable as JSON
  | "bad-schema-version" // schemaVersion is absent, the root is not an object, or it is not a positive integer
  | "schema" // failed the `Manifest` schema (unknown keys, wrong types, …)
  | "too-large" // declares more roles/entries/compose-sources than the cardinality budget allows (no-hang guard)
  | "unreadable-source" // a referenced source is present but ungateable (bytes we could not classify)
  | "absolute-path"; // a blueprint file carries a machine-specific absolute path (R4)

/**
 * The discriminated result of loading a blueprint. Exhaustive by design so every downstream verb switches on
 * `kind` and handles each case. Nothing here carries blueprint CONTENT — `secret-hit`/`invalid` name a file,
 * `schema-incompatible` carries only version numbers plus a fixed instruction.
 */
export type BlueprintLoad =
  | { kind: "loaded"; manifest: Manifest }
  | { kind: "absent"; manifestPath: string }
  | {
      kind: "schema-incompatible";
      direction: "too-new" | "too-old";
      found: number;
      supported: { min: number; max: number };
      message: string;
    }
  | { kind: "secret-hit"; file: string }
  | { kind: "invalid"; problem: InvalidProblem; file: string; detail?: string };

/**
 * Load and gate the blueprint rooted at `blueprintRoot`. Pure and total: returns a `BlueprintLoad`, never
 * throws. `io` is injectable so tests never touch a real HOME (defaults to real bounded file I/O).
 */
export function loadBlueprint(blueprintRoot: string, io: BlueprintIo = realBlueprintIo): BlueprintLoad {
  const manifestPath = join(blueprintRoot, MANIFEST_FILENAME);
  const read = io.readFileBounded(manifestPath);
  if (!read.ok) {
    // Absent ⇒ no blueprint here (run `init`); present-but-unreadable ⇒ a broken blueprint, not "nothing".
    return read.reason === "absent"
      ? { kind: "absent", manifestPath }
      : { kind: "invalid", problem: "unreadable-manifest", file: MANIFEST_FILENAME };
  }
  const manifestRaw = read.content;

  // (1) JSON shape. A parse error can quote source content — never surface it.
  let json: unknown;
  try {
    json = JSON.parse(manifestRaw);
  } catch {
    return { kind: "invalid", problem: "malformed-json", file: MANIFEST_FILENAME };
  }

  // (2) VERSION compatibility, BEFORE strict parse (R1/KTD5): a newer manifest with unknown fields must get
  //     an upgrade instruction, never strictObject's unrecognized-keys error.
  const versionResult = checkSchemaVersion(peekSchemaVersion(json));
  if (versionResult) return versionResult;

  // (2.5) Cardinality budget BEFORE safeParse (no-hang guard; decision #45's own-file pathological case): a
  //       bounded-SIZE (16 MiB) manifest can still declare millions of members, and `safeParse` materializes
  //       an issue PER invalid member — so cap the array dimensions it (and the source-read loop) will iterate.
  if (!withinCardinalityBudget(json)) return { kind: "invalid", problem: "too-large", file: MANIFEST_FILENAME };

  // (3) Strict schema. `safeParse` keeps the loader total (never throws on a bad shape).
  const parsed = Manifest.safeParse(json);
  if (!parsed.success) {
    return { kind: "invalid", problem: "schema", file: MANIFEST_FILENAME, detail: summarizeIssues(parsed.error) };
  }

  // (4) Secret + machine-absolute-path front-gate over every blueprint file's contents (R4/KTD5).
  return gateContents(blueprintRoot, parsed.data, manifestRaw, io);
}

/** Read `schemaVersion` from the loosely-parsed manifest as a safe positive integer, or `null` when the root
 *  is not an object or the value is not a safe positive integer. Runs BEFORE strict parse so the version gate
 *  can fire on a manifest whose OTHER fields we can't yet validate. */
function peekSchemaVersion(json: unknown): number | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const v = (json as Record<string, unknown>).schemaVersion;
  // `>= 1` is deliberate and NOT `>= MIN_SCHEMA_VERSION`: 0/negative are not "an old version", they are not
  // valid versions at all (the schema is `.min(1)`), so they route to bad-schema-version, never a bogus
  // "migrate to v1". Gating on MIN instead would break the too-old seam — when a future v2 raises MIN, a
  // legitimately-aged `schemaVersion: 1` must still peek-succeed to reach checkSchemaVersion's too-old branch.
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : null;
}

/** The version-compat verdict (R1/KTD5): `null` when compatible. A non-integer / non-positive / missing
 *  `schemaVersion` is a SCHEMA problem (an `invalid`), NOT a migration case — a garbage manifest must never be
 *  mislabeled "too old". Otherwise a `schema-incompatible` result carrying an explicit, content-free
 *  instruction. Pure in `supported` (defaulting to the module's live window) so BOTH branches are unit-testable
 *  at any floor: the too-old branch is unreachable via `loadBlueprint` while MIN == 1 (nothing valid sits below
 *  it), and activates unchanged the moment a future v2 raises the floor. */
export function checkSchemaVersion(
  found: number | null,
  supported: { min: number; max: number } = { min: MIN_SCHEMA_VERSION, max: SUPPORTED_SCHEMA_VERSION },
): BlueprintLoad | null {
  if (found === null) return { kind: "invalid", problem: "bad-schema-version", file: MANIFEST_FILENAME };
  if (found > supported.max) {
    const message =
      `This blueprint's manifest schemaVersion (${found}) is newer than this agent-os supports ` +
      `(up to ${supported.max}). Upgrade agent-os to provision it.`;
    return { kind: "schema-incompatible", direction: "too-new", found, supported, message };
  }
  if (found < supported.min) {
    const message =
      `This blueprint's manifest schemaVersion (${found}) predates the supported floor ` +
      `(${supported.min}). Migrate the blueprint to schemaVersion ${supported.min} before provisioning.`;
    return { kind: "schema-incompatible", direction: "too-old", found, supported, message };
  }
  return null;
}

/** Manifest cardinality budget — a no-hang guard for the decision-#45 own-file pathological case (a
 *  bounded-SIZE 16 MiB manifest can still declare millions of members). Caps the array dimensions that BOTH
 *  `Manifest.safeParse` iterates (it materializes an issue per invalid member) AND the front-gate's source-read
 *  loop walks (one bounded read per source). Generous vs any real blueprint (run-1: 3 roles, ~12 entries) — it
 *  exists only to reject the pathological. Reads loosely-typed STRUCTURE, never a manifest VALUE (content-free),
 *  and aborts on the first breach, so the check is itself bounded. */
const MAX_ROLES = 2_000;
const MAX_FILE_ENTRIES = 5_000;
const MAX_COMPOSE_SOURCES = 5_000;
function withinCardinalityBudget(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return true; // not our shape; safeParse rejects it in O(1)
  const roles = (json as Record<string, unknown>).roles;
  if (!Array.isArray(roles)) return true; // safeParse yields a single issue, fast
  if (roles.length > MAX_ROLES) return false;
  let entries = 0;
  let sources = 0;
  for (const role of roles) {
    if (typeof role !== "object" || role === null) continue;
    const files = (role as Record<string, unknown>).files;
    if (!Array.isArray(files)) continue;
    entries += files.length;
    if (entries > MAX_FILE_ENTRIES) return false; // fires BEFORE the inner walk, so it stays bounded
    for (const entry of files) {
      if (typeof entry !== "object" || entry === null) continue;
      const composeSources = (entry as Record<string, unknown>).sources;
      if (Array.isArray(composeSources)) {
        sources += composeSources.length;
        if (sources > MAX_COMPOSE_SOURCES) return false;
      }
    }
  }
  return true;
}

/**
 * The secret + machine-absolute-path scan over every blueprint file's contents (R4/KTD5). Returns a
 * `secret-hit` or absolute-path `invalid` naming the FIRST offending file, an `unreadable-source` `invalid`
 * for a present-but-ungateable source (fail-closed — bytes we can't classify are never certified secret-free),
 * or the final `loaded` result. Scans the manifest itself first, then each referenced source once, in
 * manifest order (deterministic first-hit reporting).
 *
 * SCOPE of what a `loaded` result certifies (honest boundary): the manifest in BOTH raw and parsed-normalized
 * form, and every referenced source as RAW BYTES. Whole-file (`text`) sources are written verbatim, so raw
 * bytes ARE their provisioned content. Config-format sources (config-merge — JSON/TOML/YAML) are scanned here
 * only as raw bytes, so a secret hidden behind an encoding escape (e.g. JSON `\uXXXX`) that decodes at parse
 * time is NOT caught at load — that effective-form scan belongs where the parse happens, U3's render, which
 * re-runs this gate on the parsed forms (KTD7). U3 owns it as an explicit, tested requirement: deferred by
 * construction, not silently punted (Codex gate round 1; decision-#45 disposition).
 */
function gateContents(root: string, manifest: Manifest, manifestRaw: string, io: BlueprintIo): BlueprintLoad {
  // Scan BOTH the raw manifest bytes AND the parsed-then-reserialized form. The raw scan catches a secret
  // that JSON.parse would DROP (duplicate keys — last-wins), while the normalized form catches one hidden
  // behind JSON \uXXXX escapes: an escaped `sk-…` or `/Users` reads clean as raw bytes but decodes into
  // `loaded.manifest` — the value a downstream verb (render / status / propose) would emit or write. Neither
  // scan alone certifies R4. (Config-format SOURCE files U3 parses get the same parsed-form scan where U3
  // parses them; whole-file sources are written verbatim, so their raw bytes ARE their content — see below.)
  const manifestHit =
    scanContent(MANIFEST_FILENAME, manifestRaw) ?? scanContent(MANIFEST_FILENAME, JSON.stringify(manifest));
  if (manifestHit) return manifestHit;

  const seen = new Set<string>();
  for (const role of manifest.roles) {
    for (const entry of role.files) {
      for (const source of sourcesOf(entry)) {
        if (seen.has(source)) continue;
        seen.add(source);
        const read = io.readFileBounded(join(root, source));
        if (!read.ok) {
          // Absent source ⇒ skip: no bytes exist to classify, and render (U3) raises missing-source as its
          // OWN functional failure (re-running this gate, KTD7, closes the TOCTOU). Present-but-blocked ⇒
          // FAIL CLOSED: we hold bytes we could not gate, so the blueprint is not certifiable.
          if (read.reason === "blocked") return { kind: "invalid", problem: "unreadable-source", file: source };
          continue;
        }
        const hit = scanContent(source, read.content);
        if (hit) return hit;
      }
    }
  }
  return { kind: "loaded", manifest };
}

/** Secret first, then machine-absolute-path, over one file's content. Names the FILE only (R4/KTD5). */
function scanContent(file: string, content: string): BlueprintLoad | null {
  if (containsSecret(content)) return { kind: "secret-hit", file };
  if (hasMachineAbsolutePath(content)) return { kind: "invalid", problem: "absolute-path", file };
  return null;
}

/** The source paths a file entry reads (relative to the blueprint root). Exhaustive over the transform
 *  discriminant — the `assertNever` default makes a new transform a COMPILE error here, so the gate can never
 *  silently skip a new transform's sources. Exported because it is the single source-of-truth for "what does
 *  this entry read" that render (U3) and test fixtures both need — a hand-rolled copy would lose the guard. */
export function sourcesOf(entry: FileEntry): string[] {
  switch (entry.transform) {
    case "copy":
    case "config-merge":
      return [entry.source];
    case "compose":
      return entry.sources;
    case "scaffold":
      return entry.source ? [entry.source] : [];
    default:
      return assertNever(entry);
  }
}

/** Summarize schema failures for the caller WITHOUT echoing blueprint content: each issue reduces to its
 *  field PATH + zod CODE (both structural) — never the zod `message`, the received value, or the offending
 *  key. Capped so a pathological manifest can't produce an unbounded detail string. */
function summarizeIssues(error: { issues: readonly { path: readonly PropertyKey[]; code: string }[] }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "<root>"}:${issue.code}`)
    .join("; ");
}

/** Compile-time exhaustiveness guard: adding a `FileEntry` transform without a case fails to type-check.
 *  Unreachable at runtime (the gate runs only on an already schema-parsed manifest), so the loader stays
 *  total; the fixed message carries no content. */
function assertNever(x: never): never {
  void x;
  throw new Error("blueprint loader: unhandled transform variant");
}
