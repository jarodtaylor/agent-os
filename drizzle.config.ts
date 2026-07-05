/**
 * drizzle-kit config (U2). Used ONLY by the `drizzle-kit generate` CLI to diff `src/store/schema.ts`
 * against the committed snapshots in `drizzle/meta` and emit new SQL migrations into `drizzle/`.
 *
 * `dbCredentials.url` is a CLI-connection detail drizzle-kit's sqlite dialect type requires, not the
 * app's runtime database path — the real path is resolved at runtime by `src/store/db.ts` (a per-OS
 * data dir, or a test's temp file). `generate` never opens this path; it only diffs schema vs. the
 * committed migration history. Push/introspect are not part of this project's workflow (see the U2
 * build brief's migration-bootstrap discipline: `db.ts` and tests both bootstrap via `migrate()`
 * against the committed SQL, never via `drizzle-kit push`), so this file stays a placeholder.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/store/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "./drizzle/local.db", // inert for `generate`; matches the *.db .gitignore pattern
  },
});
