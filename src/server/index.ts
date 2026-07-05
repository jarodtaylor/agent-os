/**
 * The one long-lived local process (KTD9: dev = prod). `bun run src/server/index.ts` runs this
 * file's SOURCE directly via Bun — there is no dev server, no middleware layer, and no build step
 * standing between this file and what actually runs in "production" (a personal, local-only
 * process). Do NOT `bun build` this to a bundle: `store/db.ts`'s migrations folder is resolved
 * relative to `import.meta.dir`, and bundling to `dist/` would move that file and silently break
 * `migrate()` against the wrong path. `bun run build` (`tsc --noEmit`) is the compile gate instead
 * of a bundle step.
 *
 * Boot order matters (KTD6): `openDb` creates the dataDir as a side effect (mkdir -p on its
 * parent), so it runs before the token is generated/written — the token file must land in a
 * directory that already exists.
 */
import { dbPath, resolveDataDir } from "../paths";
import { openDb } from "../store/db";
import { createRepo } from "../store/repo";
import { createRoutes } from "./routes";
import { generateToken, securityGate, writeTokenFile } from "./security";

const PORT = ((): number => {
  const n = Number(process.env.AGENT_OS_PORT);
  // A discoverable daemon needs a KNOWN port (the token + Host-allowlist contract keys off it), so any
  // invalid value — unset, non-numeric, <= 0, or > 65535 — falls back to the default rather than
  // slipping through to an opaque Bun.serve startup failure.
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 4319;
})();

const dataDir = resolveDataDir();
const { db } = openDb(dbPath(dataDir));
const repo = createRepo(db);

const token = generateToken();
writeTokenFile(dataDir, token);

const gate = securityGate({ token, port: PORT });
const app = createRoutes({ repo, gate });

// Bun's "export default syntax": a file whose default export has a `fetch` handler is passed into
// `Bun.serve` under the hood when the file is executed directly — no explicit `Bun.serve(...)` call
// needed. Hono's `app.fetch` is a bound arrow-function property, so handing it off by reference
// here (rather than `export default app`) is safe and is how `port` gets configured alongside it.
export default {
  // Bind loopback-only. Bun.serve defaults to 0.0.0.0 (ALL interfaces), which would make even the
  // gate-exempt GET /health reachable off-box on an untrusted LAN — but the whole server is meant to
  // be local-only (KTD9). 127.0.0.1 is the IPv4 loopback macOS callers reach via `127.0.0.1`/`localhost`;
  // the gate's Host allowlist still lists `[::1]` as defense in depth for the Host header itself.
  hostname: "127.0.0.1",
  port: PORT,
  fetch: app.fetch,
};
