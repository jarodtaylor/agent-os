/**
 * OS data-dir resolution + the well-known file paths under it (U3: extracted from
 * `configwrite/internal.ts` unchanged — the server needs the same dataDir resolution config-write
 * already had, so it now lives in a dependency-free module both sides import from).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the OS data dir under which every substrate subsystem keeps its files: the sqlite store
 * (`store.db`), the per-boot security token (`agent-os.token`), config-write's backups, and its
 * undo journal.
 *
 * Precedence: explicit `dataDir` (tests inject a temp dir) → `AGENT_OS_DATA_DIR` (escape hatch) →
 * the platform default. This function only computes the path; `ensureDataDir` (below) creates it
 * owner-only, and every caller (`store/db.ts#openDb`, `server/security.ts#writeTokenFile`, the boot
 * sequence) goes through that so the 0700 discipline lives in exactly one place.
 */
export function resolveDataDir(dataDir?: string): string {
  if (dataDir) return dataDir;
  if (process.env.AGENT_OS_DATA_DIR) return process.env.AGENT_OS_DATA_DIR;
  // macOS is the slice-1 host (roster decision); Application Support is its OS data dir.
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "agent-os");
  }
  // Elsewhere (Linux CI), fall back to XDG so the utility stays correct off the primary host.
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-os");
}

/**
 * The loopback port the server binds and every local caller (the SessionStart/SessionEnd hooks, the MCP
 * headers helper, skills) dials. `AGENT_OS_PORT` overrides; any invalid value — unset, non-numeric, or out
 * of range — falls back to the default so a discoverable daemon always has a KNOWN port (the token +
 * Host-allowlist contract keys off it). This is the ONE definition: `server/index.ts` binds it and the
 * hooks target it, so they can never drift onto different ports.
 */
export const DEFAULT_PORT = 4319;
export function resolvePort(): number {
  const n = Number(process.env.AGENT_OS_PORT);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}

/** Path to the sqlite store db file (see `store/db.ts#openDb`). */
export function dbPath(dataDir: string): string {
  return join(dataDir, "store.db");
}

/** Path to the per-boot security token file (see `server/security.ts`), written mode `0600`. */
export function tokenPath(dataDir: string): string {
  return join(dataDir, "agent-os.token");
}

/**
 * Path to the STABLE Codex credential (`codex.token`), written mode `0600` — distinct from the per-boot
 * `tokenPath`. Codex's HTTP-MCP client can only send a STATIC header (no per-connection headers-helper like
 * Claude Code's), so it authenticates with a stable token the gate honors ALONGSIDE the per-boot one (U8
 * decision A). Honest KTD6 narrowing: "installed config never embeds the token" holds for Claude Code
 * (headersHelper reads the file at call time); Codex's stable token is embedded in its own `0600` config,
 * exactly as it already stores every other MCP server's bearer.
 */
export function codexTokenPath(dataDir: string): string {
  return join(dataDir, "codex.token");
}

/**
 * The HTTP header the per-boot token travels in — the gate reads it (`server/security.ts`) and every local
 * caller sends it (the U6 hooks + the MCP headers helper). Defined here in the dependency-free shared module
 * so a hook can import it WITHOUT pulling the whole server (hono etc.). ONE definition so the sender and the
 * gate can't drift — a lowercase-vs-Train-Case split already happened once. Header names are case-insensitive
 * on the wire, but a single constant keeps greps and renames honest.
 */
export const TOKEN_HEADER = "x-agent-os-token";

/** Path to the persisted machine-id file, written mode `0600`. */
export function machineIdPath(dataDir: string): string {
  return join(dataDir, "machine-id");
}

/**
 * A STABLE, opaque per-machine id — the federation discriminator stamped onto every record (decision #13).
 * PERSISTED (unlike the per-boot token) so it survives reboots, and a random UUID rather than
 * `os.hostname()`: a hostname can carry the user's name (PII), and `machineId` is baked into every
 * `Handoff`/`Breadcrumb` and returned through the read paths (unredacted — it isn't sensitivity-marked), so
 * an opaque id federates cleanly without leaking a personal identifier. Minted `0600` on first boot.
 */
export function resolveMachineId(dataDir: string): string {
  const path = machineIdPath(dataDir);
  const existing = readMachineId(path);
  if (existing) return existing;

  // Absent or MALFORMED (empty/corrupt) → mint + persist, OVERWRITING any garbage. Re-minting on corruption
  // is right: a garbage id would fail the contract's `machineId.min(1)` at the write boundary and break every
  // write. Atomic temp-write + rename (adopts the temp's 0600 regardless of a prior file's mode, and never
  // leaves a partial id) — same discipline as `writeTokenFile`. The single-instance lock (U3) makes the boot
  // the sole writer, so there's no concurrent creator to race.
  ensureDataDir(dataDir);
  const id = randomUUID();
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, id, { mode: 0o600 });
  renameSync(tmp, path);
  return id;
}

/** Read a persisted machine-id, returning it only when it's a well-formed UUID; `null` (absent, unreadable,
 *  or corrupt) tells `resolveMachineId` to mint a fresh one rather than trust garbage. */
function readMachineId(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
}

/**
 * The STABLE Codex credential — minted ONCE and persisted (unlike the per-boot token). The `agent-os`
 * installer is the SOLE resolver: it mints `codex.token` and embeds the same value in `~/.codex/config.toml`.
 * The server no longer mints at boot — its security gate reads `codex.token` FRESH per request
 * (`server/security.ts#makeStableTokenReader`), so it always reflects the CURRENT file: a fresh install is
 * picked up live and an uninstall's `rm codex.token` revokes access live, with no restart and no
 * server-vs-installer mint race to reconcile (U8 decision A hardening — see docs/DECISIONS.md #28).
 *
 * EXCLUSIVE-CREATE mint (`flag: "wx"`), NOT resolveMachineId's plain temp+rename: kept as cheap defense
 * against a rare CONCURRENT double-install (two `agent-os install` runs) racing the first mint — `wx`
 * (O_CREAT|O_EXCL) lets exactly one creator win; the loser catches EEXIST and re-reads/overwrites so both
 * converge on the persisted value.
 */
export function resolveCodexToken(dataDir: string): string {
  const path = codexTokenPath(dataDir);
  const existing = readCodexToken(path);
  if (existing) return existing;

  ensureDataDir(dataDir);
  const token = randomUUID();
  try {
    // Fast path — the file is truly ABSENT: exclusive-create (O_CREAT|O_EXCL) so a concurrent first-mint has
    // exactly one winner; the loser catches EEXIST below and adopts the winner's value. A single short
    // writeFileSync lands the whole token, so a concurrent reader sees either no file or the complete value.
    writeFileSync(path, token, { mode: 0o600, flag: "wx" });
    return token;
  } catch {
    // The file EXISTS (EEXIST) — two sub-cases. If a concurrent creator won with a VALID token, adopt theirs
    // (keeps the two resolvers convergent). Otherwise it's a present-but-EMPTY/corrupt leftover the read above
    // already rejected: overwrite it atomically (temp+rename adopts 0600 and never leaves a partial token),
    // exactly as resolveMachineId re-mints over a malformed machine-id.
    const won = readCodexToken(path);
    if (won) return won;
    // Present-but-empty/corrupt leftover -> atomic overwrite. UNIQUE tmp per process (server boot + installer can
    // both reach this branch over the same empty file, no lock), then RE-READ so both converge on whichever rename
    // won rather than each returning its own un-persisted mint.
    const tmp = `${path}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, path);
    return readCodexToken(path) ?? token;
  }
}

/** Read the stable Codex token — a non-empty trimmed string, else `null`. Deliberately does NOT validate a
 *  UUID shape the way `readMachineId` does: the token is opaque, and re-minting a present-but-odd value would
 *  invalidate the copy already written into `~/.codex/config.toml`. Only absence/emptiness triggers a mint.
 *  Exported: `installCodex`'s `tokenPreexisted` guard uses this (not `existsSync`) so provenance is SEMANTIC
 *  — a valid non-empty token pre-existed — not path-existence, which an empty/whitespace leftover would
 *  satisfy despite `resolveCodexToken` minting fresh over it. */
export function readCodexToken(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Create the data dir owner-only (0700) — the ONE place that mode is applied, shared by `openDb`,
 * `writeTokenFile`, and the boot sequence. The `chmod` after `mkdir` is not redundant: mkdirSync's
 * `mode` applies only when it CREATES the dir, so a dir reused from a prior run (possibly 0755 from an
 * older version) is tightened too. A 0700 dir protects every file inside it whatever their own modes,
 * umask-independently — and it lets the boot acquire the single-instance lock before opening the store.
 */
export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}
