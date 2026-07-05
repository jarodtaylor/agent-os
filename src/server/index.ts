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
import { dbPath, ensureDataDir, resolveDataDir } from "../paths";
import { openDb } from "../store/db";
import { createRepo } from "../store/repo";
import { createRoutes } from "./routes";
import { generateToken, securityGate, writeTokenFile } from "./security";
import { acquireSingleInstanceLock } from "./single-instance";

const PORT = ((): number => {
  const n = Number(process.env.AGENT_OS_PORT);
  // A discoverable daemon needs a KNOWN port (the token + Host-allowlist contract keys off it), so any
  // invalid value — unset, non-numeric, <= 0, or > 65535 — falls back to the default rather than
  // slipping through to an opaque Bun.serve startup failure.
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 4319;
})();

const dataDir = resolveDataDir();

// Create the data dir (owner-only), THEN take the single-instance lock, THEN open the store. The order
// is load-bearing: openDb opens SQLite + runs migrations, so a rejected second instance must be turned
// away BEFORE it can touch or migrate the shared store. The lock is DATA-DIR-scoped (not port-scoped),
// so it also stops a second instance on a DIFFERENT port from clobbering the token / running a second
// writer (KTD9: one writer by construction). NOTE: this pid-file lock catches the common double-run; its
// crash-recovery + pid-recycle edges are a tracked fast-follow — a real flock OS lock landing in U15
// (open-findings U3-R3).
ensureDataDir(dataDir);
acquireSingleInstanceLock(dataDir);

const { db } = openDb(dbPath(dataDir));
const repo = createRepo(db);

const token = generateToken();
const gate = securityGate({ token, port: PORT });
const app = createRoutes({ repo, gate });

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
