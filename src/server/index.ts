/**
 * The one long-lived local process (KTD9: dev = prod). `bun run src/server/index.ts` runs this
 * file's SOURCE directly via Bun — there is no dev server, no middleware layer, and no build step
 * standing between this file and what actually runs in "production" (a personal, local-only
 * process). Do NOT `bun build` this to a bundle: `store/db.ts`'s migrations folder is resolved
 * relative to `import.meta.dir`, and bundling to `dist/` would move that file and silently break
 * `migrate()` against the wrong path. `bun run build` (`tsc --noEmit`) is the compile gate instead
 * of a bundle step.
 *
 * Boot order matters (KTD6 / open-findings U3-R1): the server BINDS the port before it publishes the
 * token file. `Bun.serve` throws synchronously on EADDRINUSE, so a second boot that loses the port
 * race crashes before `writeTokenFile` runs — it can never overwrite the live instance's token with
 * one no listening server accepts. `openDb` (which creates the 0700 dataDir) runs first so the token
 * has a home to land in.
 */
import { codexConfigPath } from "../codex-credential";
import { dbPath, ensureDataDir, resolveDataDir, resolveMachineId, resolvePort } from "../paths";
import { openDb } from "../store/db";
import { createRepo } from "../store/repo";
import { createRoutes } from "./routes";
import { generateToken, securityGate, writeTokenFile } from "./security";
import { acquireSingleInstanceLock } from "./single-instance";

// A discoverable daemon needs a KNOWN port (the token + Host-allowlist contract keys off it); resolvePort
// (../paths) is the ONE definition, shared with the U6 hooks so a caller can never dial a port the server
// didn't bind. Any invalid AGENT_OS_PORT falls back to the default rather than an opaque Bun.serve failure.
const PORT = resolvePort();

const dataDir = resolveDataDir();

// Create the data dir (owner-only), THEN take the single-instance lock, THEN open the store. The order
// is load-bearing: openDb opens SQLite + runs migrations, so a rejected second instance must be turned
// away BEFORE it can touch or migrate the shared store. The lock is DATA-DIR-scoped (not port-scoped),
// so it also stops a second instance on a DIFFERENT port from clobbering the token / running a second
// writer (KTD9: one writer by construction). It's a real OS `flock` held on an fd for the process
// lifetime, auto-releasing on exit — clean OR crashed — so we intentionally DISCARD the returned
// release fn here; process exit is the release. See single-instance.ts / open-findings U3-R3.
ensureDataDir(dataDir);
acquireSingleInstanceLock(dataDir);

const { db } = openDb(dbPath(dataDir));
const repo = createRepo(db);

const token = generateToken();
// The stable Codex credential (U8 decision A): the gate reads it FRESH per request out of Codex's OWN
// `~/.codex/config.toml` (see securityGate#codexConfigPath), observing its lifecycle LIVE — a fresh install
// is picked up, and an uninstall's removal of the `mcp_servers.agent-os` entry revokes access with NO
// restart. The INSTALLER is the sole minter, and since issue #24 the credential exists in exactly ONE
// place — the bytes Codex itself sends — so there is no second copy for boot or install to race.
const gate = securityGate({ token, codexConfigPath: codexConfigPath(), port: PORT });
// machineId is this machine's federation discriminator (decision #13), stamped onto every record the MCP
// write path persists. A persisted opaque UUID (not os.hostname(), which can carry the user's name) so it
// doesn't bake a personal identifier into records that accumulate now and federate in v1.1 — see ../paths.
const app = createRoutes({ repo, gate, machineId: resolveMachineId(dataDir) });

// Bind loopback-only, BEFORE publishing the token. `hostname: "127.0.0.1"` because Bun.serve otherwise
// defaults to 0.0.0.0 (all interfaces), which would expose the gate-exempt /health off-box (KTD9 is
// strictly local). Explicit `Bun.serve` (not `export default {fetch}`) is deliberate: it lets the token
// write happen only AFTER a successful bind, so a port-race loser crashes here and can't clobber the
// live instance's token file (U3-R1). 127.0.0.1 is the IPv4 loopback macOS callers reach via
// `127.0.0.1`/`localhost`; the gate's Host allowlist still lists `[::1]` as Host-header defense in depth.
const server = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: app.fetch });

// We own the port now — publish the token (atomic temp-write + rename, see writeTokenFile) so
// same-machine callers can read the CURRENT token at call time.
writeTokenFile(dataDir, token);

console.log(`[agent-os] listening on http://127.0.0.1:${server.port}`);
