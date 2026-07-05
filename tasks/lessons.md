# Lessons — agent-os

Project-specific patterns to avoid repeating. Review at session start.

## Review-roster scoping: know what each lens uniquely covers before trimming

**2026-07-04 (U14, ce-code-review).** I scoped the ce-code-review roster down to correctness + security + reliability (dropping the always-on **testing** and maintainability lenses) because ce-simplify-code had just run and Codex adversarial review was next. Defensible, but it had a concrete cost: the **testing lens is the one that checks per-format / per-serializer round-trip byte-stability**, and I nearly shipped an idempotency test that covered **JSON only**. The no-op short-circuit relies on `serialize(parse(x)) === x` being byte-stable, which is a *per-serializer* property — JSON is trivially stable, TOML/YAML are not obviously so. The advisor caught it; TOML is Codex's `config.toml`, the exact "installer re-runs every session" scenario the short-circuit exists for. (Verified stable in the end, but the coverage gap was real.)

**Rule:** When trimming a review roster, for each dropped lens name the specific class of defect it uniquely catches, and either keep it or manually add that coverage. The **testing lens** specifically catches: coverage that only exercises one variant of an N-variant surface (formats, serializers, platforms, encodings), and round-trip/idempotency stability. Don't assume "one format proves all formats."

**Also:** call the advisor before declaring a unit done — it caught this after three reviewer lenses + a simplify pass had already run. The independent "what's missing?" pass earns its keep at the done-boundary, not just pre-build.

## The Codex adversarial review is a required GATE before the PR — run it, don't auto-ship past it

**2026-07-04 (U3, build loop).** I ran ce-work → ce-simplify-code → ce-code-review, then a weak self-substitute "adversarial pass," committed all three commits, and opened PR #4 — skipping the real Codex adversarial-review gate. Jarod flagged it. (First fix was "hand back for Jarod to run `/codex:adversarial-review`"; he then decided he'd rather **I run it autonomously** — the slash command is `disable-model-invocation: true`, but its companion script isn't gated, so I invoke it via `bash ~/.claude/scripts/codex-adversarial-review.sh --base main`.)

**Rule:** After `ce-code-review` + its fixes, the **Codex adversarial review is a required step before the PR** — I run it autonomously via the wrapper, fold its findings, *then* commit + PR. It is NOT satisfied by `ce-code-review`'s internal adversarial persona or an ad-hoc `codex exec` prompt — use the plugin's companion script (the same review Jarod would run). Re-run it after CodeRabbit/Copilot fixes if the diff changed materially. **Don't declare a unit done until the Codex adversarial review has actually run on the final diff.** Canonical: [[jarod-compound-engineering-pipeline]].
