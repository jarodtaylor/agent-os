---
title: A harness's config schema is an undocumented contract — verify surfaces live, defer what you can't
date: 2026-07-16
last_updated: 2026-07-22
category: docs/solutions/conventions
module: src/scan (inventory scanners); src/provision (render/apply pipeline); any harness-surface scanner or installer
problem_type: convention
component: tooling
severity: medium
applies_when:
  - Writing a scanner or installer that reads another agent harness's on-disk config (Claude Code, Codex, Hermes, Cursor, Antigravity, OpenCode, Grok Build)
  - Enumerating skills / MCP servers / plugins / any named entries from a harness config, where "present" might not mean "active"
  - Assuming a discovery ROOT path (a skills dir, a config file) from a cursory `ls` or from memory rather than from a verified live instance
  - Deciding whether to ship a plausible-but-unverified surface or defer it
  - A cross-model or adversarial reviewer flags that a scanned surface does not match the live machine
  - Authoring or reviewing a role file, config patch, or any other structured source a provisioning/render pipeline will write verbatim into a harness's own config format — the destination's required keys are as unverified as a scanner's read side
  - The pipeline moving that content is deliberately content-blind (a secret-scanning or portability boundary that must not parse what it moves) — schema validation there did not survive the design that made it safe
tags: [harness-integration, undocumented-contract, config-schema, verify-against-live, enabled-flag, discovery-roots, defer-unverified, ship-verified-core, scanner, inventory, observe, codex, claude-code, agents-convention, content-blind-pipeline, provisioning, schema-assertion, render, secret-scanning-boundary]
related_components: [scan, capture, install, contract, provision]
---

## Context

U9 built the Observe-half inventory scanners (`src/scan/*`) — one typed inventory of skills, MCP servers, and plugins across Claude Code and Codex, read straight from their on-disk configs (R7/R8). Three separate times in one unit, an assumption about a harness's config *shape* was wrong, and each was invisible to a cursory read — only checking the **live** config (or a cross-model reviewer that did) exposed it. A harness config is an **undocumented contract** (the plan's own #1 risk), and it surprises you at exactly the fields you did not think to check.

## Guidance

For any scanner or installer that reads a harness's config, treat the config schema as untrusted and verify it against a live instance **before** writing the code — then hold that discipline through review:

1. **Inspect the live config structure first** (keys/shape, never secret values). Do not code the surface from memory or from `ls`. Use `jq 'keys'`, `grep '^\['` on TOML tables, etc., against a real config on the machine.
2. **Present is not active — look for a state flag on every enumerated entry.** A config that lists an entry may also carry `enabled: false` / a disabled marker; emitting a disabled entry as active violates R8 ("reflect the *actual* active stack, not everything ever installed"). Default to include unless *explicitly* disabled — a missing flag is not "off".
3. **Verify discovery ROOTS against a live instance + current docs, not an assumed path.** A skills/config dir you *expect* may be empty or a decoy; the real one may be a shared cross-tool convention (`~/.agents/...`) that blurs per-runtime attribution. A reviewer's *alternative* root is also just a guess until you verify it.
4. **A shallow live probe yields false ABSENCES as readily as false presences — never encode "does not exist" from one.** An empty dir + a `--help` with no matching subcommand is not evidence a surface doesn't exist; verify a surface's *existence* against the harness's authoritative docs before writing an absence finding. And for *control* surfaces (CLI flags, key sequences, pane protocols), reading `--help` is not verification at all — **drive the surface live** before encoding it.
5. **Ship the verified core; defer what you can't verify — with a detailed issue.** A plausible-but-wrong scanner (false absences, disabled-shown-as-active) is worse than a documented gap. Each defer gets an issue naming *what*, *why*, and the *build trigger*.
6. **When the pipeline that moves this content is deliberately content-blind, re-add the schema check explicitly at the boundary where the destination is known.** A render/apply pipeline that treats file bytes as opaque (by design — see "Why This Matters") cannot itself fail on a wrong key name; nothing downstream will either, because the bytes it wrote are exactly the bytes it was given. Add a test that, for every manifest row landing on a known structured surface, parses the rendered source and asserts the harness's documented required keys are present. Two rules make the assertion trustworthy rather than decorative:
   - **Assert the row set is non-empty first** (e.g. `expect(rows.length).toBeGreaterThan(0)`) — a schema check gated behind a `.filter(...)` that silently returns zero rows passes vacuously the day the shipped source stops producing that row, and a vacuous pass is indistinguishable from a real one in CI output.
   - **Verify by mutation**, not just by reading green: reintroduce the wrong key locally and confirm the same assertion turns red. A test that has never been watched to fail is unverified.

## Why This Matters

The inventory drives cross-runtime **parity** decisions (F4: "present in harness A, absent in B → propagate"). A scanner that misreports — a disabled server shown as active, or 0 skills where 13 exist — makes every downstream parity/provision action unsafe on data that *looks* authoritative. And the misreads are silent: the code compiles, the tests pass against the fixtures you wrote, and the live scan even *looks* plausible — because today nothing happens to be disabled and the empty root happens to match your assumption. The bug ships and waits for the first time reality diverges from the assumption.

**Content-blind pipelines lose schema validation as a side effect of a choice made for an unrelated, good reason.** U10 U6's provisioning `copy` transform (`src/provision/render.ts`) moves a source file's bytes to its destination without parsing them — `content: source.content`, untouched. That opacity is deliberate and correct: the front-gate's secret-scanning and machine-path checks must not interpret what they move, because interpreting is itself a place a scan can be fooled (an escaped secret that only resolves once something parses the file). Nobody chose to drop schema validation — it fell out as an unnamed side effect of a choice made to keep the secret boundary honest. The result: a wrong required key in a shipped source file lands on disk, applies cleanly, and fails nothing, at any layer, forever — 671/671 green is not evidence the bytes moved are the bytes the destination harness will accept, only that the pipeline faithfully moved *some* bytes. The countermeasure is not "make the pipeline less blind" (that reintroduces the exact risk the opacity was protecting against) — it is asserting the schema explicitly at the one place that still knows the destination's shape: a test scoped to that harness's config format, as in guidance step 6.

## When to Apply

Every harness-surface scanner or installer — the whole future roster (Hermes, Cursor, Antigravity, OpenCode, Grok Build) rides this same spine (a per-harness module owns the format knowledge; fixtures pin the observed shape). Apply it hardest when enumerating named entries (skills/servers/plugins), resolving a discovery root, or when a cross-model reviewer says the scan does not match the machine. Apply the mutation-verified schema-assertion countermeasure (guidance step 6) specifically whenever a *write* path — a provisioning render, an installer, any pipeline authoring a structured source another harness will parse — is content-blind by design; that is exactly the condition under which "all tests green" stops being evidence about the destination's schema.

## Examples

The three live-config surprises from U9 plus the dogfood scaffold's false-absence, each caught only by reality:

**1. Claude Code `enabledPlugins` has `false` entries.** `~/.claude/settings.json .enabledPlugins` is `{ "<name>@<mkt>": boolean }`; 1 of 24 was `false`. A cursory "enumerate the keys" emits a disabled plugin as active. Fix: filter `=== true`.

**2. Codex writes `enabled = true` into every table.** Each `[mcp_servers.x]` and `[plugins."y"]` in `~/.codex/config.toml` carries `enabled = true/false`. The first scanner enumerated table keys blindly, so a disabled Codex server/plugin would be reported active. It *looked* correct only because nothing was disabled. Fix: skip entries explicitly `enabled = false` (the `namedItems` helper in `src/scan/internal.ts`).

```toml
# ~/.codex/config.toml — the enabled flag is real, on every table
[mcp_servers.codebase-memory-mcp]
enabled = true                        # a scanner that ignores this over-reports when it is false
[plugins."github@openai-curated"]
enabled = true
```

**3. Codex skills are not in `~/.codex/skills`.** That dir held only a `.system` entry (0 real skills); the real discovery root is a shared `~/.agents/skills` convention (13 `SKILL.md` files there) + repo `.agents/skills` + `[[skills.config]]` disables — and the same shared root leaves the Claude Code skill scan only *plausible*, not verified. The naive `~/.codex/skills` scan was verified-**wrong** against the live machine. Response: ship the confirmed `config.toml` surfaces (MCP + plugins) and **defer** Codex skill discovery + holistic skill-root verification to an issue, rather than switch to the reviewer's own unverified alternative.

**4. The false-absence mirror image (agent-cost-tracker dogfood scaffold, 2026-07-16→18).** The provisioning pass declared `.codex/agents/*.toml` "does not exist" from an empty `~/.codex/agents/` + a top-level `codex --help` with no `agents` subcommand, treating the authoritative docs as "optional confirmation" — **the spec was right; the finding was wrong** (Codex custom subagents are real, project-scoped TOML; verified live by delegating to a provisioned `executor.toml`). Same run, same spine on a *control* surface: the Herdr orchestration was authored against `--help` and was wrong in three ways (submit primitive, output source, spawn pattern) — each caught only by driving a live pane. Full record: `~/Code/personal/agent-cost-tracker/FRICTION.md` + `PROVISIONING.md` §Corrections.

**Companion pattern — a fail-soft-everywhere composition's error backstop is invisible to real inputs.** `scanAll` wraps each scanner in try/catch (R9: one source's throw degrades only its runtime). But every helper is fail-soft (returns `null`/`[]`), so no *real* scanner ever throws — the backstop had zero coverage and could be deleted with the suite still green ("green-while-red", flagged by three reviewers). To test a defense-in-depth handler whose real inputs never trigger it, expose a seam that **injects a failure**: factor the loop into `runScanners(ctx, scanners)` and pass a deliberately-throwing scanner.

```ts
// the source-level backstop is only reachable via an injected throw
const boom: SourceScanner = () => { throw new Error("scanner blew up"); };
const out = await runScanners(ctx, [
  { runtime: "claude-code", scan: boom },        // degrades to nothing...
  { runtime: "codex", scan: () => [survivor] },  // ...while codex still returns
]);
expect(out.map((i) => i.name)).toEqual(["survivor"]);
```

**5. The seed blueprint's Codex executor role shipped `instructions`; the live key is `developer_instructions`.** U10 U6's seed template (`templates/blueprint-seed/roles/executor/agent.toml`) authored its Codex role's system prompt under `instructions = """..."""`. The real per-agent config key, verified against a live install at `~/.codex/agents/tldraw-offline.toml`, is `developer_instructions`. The consequence was silent: Codex would load the executor role with no system prompt at all — the entire behavioral contract (run-state protocol, hand-off rules) never reached the model, and nothing anywhere signaled the loss. This is a write-side instance of the same trap example 3 shows on the read side (Codex skill discovery): the harness's config shape is unverified until checked against a live instance, whichever direction the data flows.

A review lens scoped to "does the rendered surface actually load in its target harness?" is what caught it — not a broader review, and not documentation (Codex's own docs on custom agent config were consulted and still didn't surface this key by name; only the live file did). The countermeasure landed as `tests/provision-cli.test.ts`'s `"seed template renders surfaces the target harness will actually accept"` block: it globs the manifest for every `.codex/agents/*.toml` row, asserts that row set is non-empty (`expect(rows.length).toBeGreaterThan(0)`) so the check cannot pass vacuously if the seed ever stops shipping that row, then parses each source and asserts `developer_instructions` is present and non-empty. Reintroducing `instructions` locally turns the assertion red, confirming the test would have caught U6's own mistake.

```ts
// tests/provision-cli.test.ts — the schema check the content-blind copy transform can no longer perform itself
const rows = manifest.roles
  .flatMap((role) => role.files)
  .filter((file) => file.destination.startsWith(".codex/agents/") && file.destination.endsWith(".toml"));
expect(rows.length).toBeGreaterThan(0); // guard the guard — a vacuous pass looks identical to a real one

for (const row of rows) {
  const parsed = parseToml(readFileSync(join(SEED_ROOT, row.source!), "utf8")) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual(expect.arrayContaining(["description", "developer_instructions", "name"]));
  expect(typeof parsed.developer_instructions).toBe("string");
}
```

Full record: branch `feat/u10-u6-cli-seed-template`, commit subject "fix(review): drift means divergence, init refuses before writing, Codex seed key" (unmerged, no PR yet as of this writing).

Evidence: the U9 branch `feat/u9-inventory-scanners` (the `feat(scan)` + `fix(adversarial)` commits; PR pending); defer issues #35 (project scope), #36 (Codex skills / holistic root verification), #37 (degradation metadata). U10 U6 branch `feat/u10-u6-cli-seed-template` (PR pending).
