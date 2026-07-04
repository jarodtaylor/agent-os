# Lessons — agent-os

Project-specific patterns to avoid repeating. Review at session start.

## Review-roster scoping: know what each lens uniquely covers before trimming

**2026-07-04 (U14, ce-code-review).** I scoped the ce-code-review roster down to correctness + security + reliability (dropping the always-on **testing** and maintainability lenses) because ce-simplify-code had just run and Codex adversarial review was next. Defensible, but it had a concrete cost: the **testing lens is the one that checks per-format / per-serializer round-trip byte-stability**, and I nearly shipped an idempotency test that covered **JSON only**. The no-op short-circuit relies on `serialize(parse(x)) === x` being byte-stable, which is a *per-serializer* property — JSON is trivially stable, TOML/YAML are not obviously so. The advisor caught it; TOML is Codex's `config.toml`, the exact "installer re-runs every session" scenario the short-circuit exists for. (Verified stable in the end, but the coverage gap was real.)

**Rule:** When trimming a review roster, for each dropped lens name the specific class of defect it uniquely catches, and either keep it or manually add that coverage. The **testing lens** specifically catches: coverage that only exercises one variant of an N-variant surface (formats, serializers, platforms, encodings), and round-trip/idempotency stability. Don't assume "one format proves all formats."

**Also:** call the advisor before declaring a unit done — it caught this after three reviewer lenses + a simplify pass had already run. The independent "what's missing?" pass earns its keep at the done-boundary, not just pre-build.
