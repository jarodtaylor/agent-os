---
title: Parser warnings are a read path — the yaml library echoes source lines to stderr unless logLevel is "error"
date: 2026-10-30
category: docs/solutions/architecture-patterns
module: provision render/targets + configwrite engine (U10 U7 Codex gate, PR for U7)
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - Parsing untrusted or secret-bearing config (live user files) with the `yaml` npm package
  - A code path promises "no content escapes" (decision #45) and wraps the parser in try/catch, assuming that makes it total and silent
  - A read pipeline gains a new, remotely triggerable caller (an MCP tool, an HTTP route)
---

# Parser warnings are a read path

## What happened

`parseConfigValue` in `src/provision/render.ts` wrapped `yaml.parse` in try/catch and documented itself as "total, discards parser messages/content". It discarded **errors**. But `yaml` v2's default `logLevel` is `"warn"`, and **warnings** (an unresolved tag such as `value: !custom sk-ant-…`, among others) go to the process warning channel with the offending source line, which means stderr. A secret on that line of a live config file reached the server log on every `plan`/`status` read.

Neither the CLI's suite nor nine review personas caught it. Two things made it visible:
- **U7 put the pipeline behind an MCP tool**, so agents could trigger the read remotely. Before that, only the operator could.
- **The Codex adversarial gate reproduced it** (Codex gate on U7).

## The fix

Pass `{ logLevel: "error" }` at **every** read site (`src/provision/render.ts`, `src/provision/targets.ts`, `src/configwrite/engine.ts`).

| `logLevel` | Warning printed? | Malformed YAML |
|---|---|---|
| default (`"warn"`) | **yes, with the source line** | throws |
| `"error"` | no | throws (fail-closed) ✅ |
| `"silent"` | no | **parses without throwing** ❌ |

`"silent"` is the trap. It sounds like the safe choice, but it also suppresses errors, so `a: [unclosed` parses to `{a: ["unclosed"]}` and a fail-closed reader quietly becomes fail-open.

The regression test (`tests/provision-render.test.ts`, "YAML warnings never echo a live file's line") spies on `process.stderr.write`, `console.warn` and `process.emitWarning`, and fails with the fix reverted.

## The general rule

A no-content-echo guarantee has to cover **every channel a dependency can write to**, not just its return value and its exceptions. "try/catch around the parser" covers the second, never stderr, the warning channel, or debug logging. When a read path handles secret-bearing input:
- check what the parser library logs by default;
- prefer an option that suppresses diagnostics but keeps errors fatal;
- pin it with a test that captures the side channels.

Re-check this whenever a read pipeline gains a new caller that can trigger it.
