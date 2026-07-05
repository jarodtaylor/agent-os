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

const PORT = Number(process.env.AGENT_OS_PORT) || 4319;

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
  port: PORT,
  fetch: app.fetch,
};
