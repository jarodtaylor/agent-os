---
title: Write the threat model down, or the adversarial gate can't tell a real catch from a void one
date: 2026-07-16
category: docs/solutions/conventions
module: "src/scan/* (runScanners backstop catch); .claude/skills/unit-loop/references/codex-gate.md (adversarial gate)"
problem_type: convention
component: development_workflow
severity: medium
symptoms:
  - "Codex adversarial gate returned 4 consecutive no-ship verdicts on U9, the last three fixating on one surface: how scanner composition logs a degraded/thrown source"
  - "Round 2: console.warn logged the raw smol-toml parse error, whose message quotes the offending config line (configs legitimately hold secrets)"
  - "Round 3: fixed to log err.name instead — still flagged, because err.name is mutable data that can carry a secret"
  - "Round 4: a `name` getter can itself throw, escaping the catch and voiding the degrade-one-runtime guarantee the backstop exists to provide"
  - "Each fix still inspected the caught unknown in some way, so the reviewer always found the next angle on the same surface"
applies_when:
  - "Running the Codex adversarial gate (or any adversarial/security review) on code with a catch block, a fallback path, or a degrade-gracefully guarantee"
  - "Deciding whether a caught-error log site is safe to log (message, name, stack) for a local single-user tool that reads the user's own configs"
  - "A gate or reviewer keeps escalating on the same surface across rounds — that pattern signals an unscoped threat model, not a code defect"
  - "Writing or reviewing any backstop catch meant to guarantee one runtime degrades without crashing the whole scan or run"
  - "Scoping what 'no secret escapes any read path' means before starting a security-flavored adversarial pass"
root_cause: inadequate_documentation
resolution_type: workflow_improvement
related_components: [scan, unit-loop, codex-gate, contract]
tags: [adversarial-gate, threat-model, codex-gate, structural-throw-proofing, catch-block-hygiene, unit-loop, decision-45, degrade-not-crash]
---

# Write the threat model down, or the adversarial gate can't tell a real catch from a void one

## Context

U9 (the inventory-scanner "Observe half" — `src/scan/index.ts`, `src/scan/internal.ts`) went through four consecutive rounds of this project's cross-model Codex adversarial gate (`.claude/skills/unit-loop/references/codex-gate.md`) before it could ship. Rounds 2 through 4 all fixated on the same single surface: what `runScanners`'s composition-level catch (`src/scan/index.ts:42-64`) is allowed to log when a scanner throws.

The escalation, each round looking terminal to its author and then defeated the next:

- **Round 2** (the `fix(adversarial): scanner read-boundary hardening` commit on the U9 branch): `readParsed` in `src/scan/internal.ts` warned with the raw parse error attached — `smol-toml`'s error message quotes the offending source line, and a `config.toml` legitimately holds MCP bearer headers and env secrets. Fix: strip the warns down to the path only (`src/scan/internal.ts:138` and `src/scan/internal.ts:150` — both now end `(degraded)` with no error object appended).
- **Round 3** (the `fix(adversarial): close the secret-log + phantom classes at their remaining sites` commit): the *composition*-level catch in `runScanners` had the same defect at a second site — it still logged the caught value directly. The round-3 fix narrowed this to `(err as Error)?.name`, reasoning that the error's *class* (`"TypeError"`, `"SyntaxError"`) carries no config content, only its `message` does.
- **Round 4** (fixed on `feat/u9-inventory-scanners` in the same change that adds this doc; PR pending as of this writing): `err.name` is not a fixed enum — it is a plain, assignable, and in this catch *attacker-shaped* JavaScript property. A thrown value can set `.name` to anything (including a secret), and worse, `.name` can be a **getter that itself throws**, which would escape the catch entirely and silently void the exact guarantee the catch exists to provide (AE4/R9: one throwing scanner degrades only its own runtime, never the whole sweep).

Three fix attempts, three defeats, all on one `catch` block. That repetition — not the code — is the thing worth extracting a lesson from. See `docs/DECISIONS.md` decision #45 (the ruling that closed the loop) and the "Threat model (decision #45)" section now in `.claude/skills/unit-loop/references/codex-gate.md`.

## Guidance

**1. An adversarial gate without a written threat model applies unbounded-adversary assumptions everywhere, whether or not they fit — and nobody can adjudicate its findings without one.**

Codex's default posture is "assume attacker-controlled everything." For agent-os — a local, single-user tool reading and writing the user's own config files — that posture is right for some surfaces and wrong for others, but nothing said which was which. Rounds 2 and 3 happened to land on a genuine invariant this project actually holds ("no secret escapes any read path" — your own configs hold your own secrets; don't leak them into your own logs), so they were real catches. Round 4 crossed into a different territory (reproducing the finding requires the reviewer to inject a hostile scanner through `runScanners`'s exported test seam — `SourceScanner` — which is not a capability any real attacker-of-this-tool has without already owning the process), and with no written scope, neither Codex nor the author had a way to tell that the surface had changed.

The durable fix was not a fourth patch — it was writing the threat model down once, in `docs/DECISIONS.md` #45 and in the gate's own reference doc, so every future run is scoped against it via the focus text (`"… (threat model: local single-user tool, own configs — decision #45; adversary-injected in-process code is out of scope)"`). In scope: secrets-in-own-logs, and crash-safety invariants the code itself claims. Out of scope: adversary-injected in-process code, and attacker-owns-HOME beyond the bounded-read/no-hang guarantees already built (the 16 MiB cap and regular-file stat guard in `readParsed`, `src/scan/internal.ts:110-153`).

**2. When successive fixes on one surface keep getting defeated, look for whether each fix still *inspects* the untrusted thing — because any inspection has another angle. The terminal fix is structural, not a better judgment call.**

Round 2 stopped logging the error's `message`. Round 3 stopped logging the error's `message` *and* introduced a "safe" derived value (`err.name`) instead of eliminating the read. Both fixes still read *something* off an attacker-shaped value and made a judgment call about which fragment was safe — and each judgment call turned out to have an angle the previous round's author didn't see. The pattern only closes at the point where the catch reads **nothing** off the thrown value at all:

```ts
// src/scan/index.ts:48-61 (current tree, the round-4 fix)
try {
  inventory = inventory.concat(await scan(ctx));
} catch {
  // The caught value is NEVER inspected — not even `.name`. Any read of an unconstrained thrown value
  // has an angle: its message can quote config content (a config legitimately holds secrets — the same
  // rule `readParsed` follows), and ANY property access can itself throw (a getter), which would abort
  // this catch and void the very degrade-one-runtime guarantee it exists to provide. A fixed
  // runtime-only line is structurally terminal: no data flows from the throw to the log. The runtime is
  // enough to know which source degraded; the "roughly why" belongs to structured degradation metadata
  // (issue #37), not stderr.
  console.error(`[agent-os] inventory scan: '${runtime}' threw and was degraded`);
}
```

Note the tell: `catch {}` (no bound identifier at all), not `catch (err) {}` with careful handling inside. There is no `err` in scope to read a property off of by mistake later. Terminality here is checkable **by inspection** — zero data flow from the throw to the log is a structural fact about the code, not a claim you have to trust the author's judgment on. That is strictly stronger than round 3's "we log only the safe-looking part," which read as terminal to its author and wasn't. This is the same shape as this repo's `presence-semantics-not-byte-level-noop-checks.md` learning from U14: a design pass that closes a whole defect class, not one more guard bolted onto a surface that keeps growing new instances.

**3. A gate finding can be void as *security* and right as *engineering* at the same time — split it, keep the surviving half, and say so explicitly rather than accepting or rejecting the finding whole.**

Round 4's finding had two components bundled together:

- *Security claim*: a secret can escape through `err.name`. This requires a real scanner to put a secret into `.name`, or a hostile scanner to be registered in the first place — and anything that can register a hostile scanner through `runScanners`'s exported seam already has arbitrary in-process code execution and doesn't need the logs to exfiltrate anything ("the other side of the airtight hatchway"). Under decision #45's threat model this half is **void**.
- *Engineering claim*: a crash-safety backstop's `catch` must be structurally throw-proof. A throwing `.name` getter escaping the catch would silently defeat the very guarantee (`AE4`/`R9`, degrade-one-runtime) the backstop exists to provide, independent of any adversary — a buggy real scanner that happens to define a throwing getter would break it too. This half is **right**, and worth fixing regardless of the security framing.

The resolution kept the engineering half (zero-inspection catch) and discarded the security framing rather than either dismissing the whole round-4 finding as a false positive or accepting it uncritically as "one more secret-leak fix" like rounds 2–3. Recognize when a finding is doing double duty and treat each half on its own merits.

## Why This Matters

Four rounds of a real adversarial gate on one surface is expensive — it is real engineer time and real review cycles, and past a certain point it reads as the gate being broken rather than the code needing another fix. The actual root cause here was neither: it was that nobody had ever written down what kind of adversary this tool defends against, so a genuinely scoped reviewer (Codex, defaulting to maximal adversarial assumptions) kept surfacing findings the author had no principled way to accept or reject. Writing the threat model once converts the gate from an unbounded adversary that will find *something* on every local-file-reading surface forever, into a calibrated reviewer whose findings can actually be adjudicated — which is what makes "fold the real ones, defer the rest" a decision instead of a guess. It also protects shipping cadence: decision #45 is explicit that over-hardening loops against a threat that doesn't exist for this tool (a single-user local app) are a cost with no corresponding safety benefit.

Separately, the zero-inspection catch is a small, general instance of a large idea: a security/crash-safety backstop is only as strong as its weakest read of untrusted data, and "which read is safe" is a question that degrades under repeated adversarial pressure — because there's always another property, another getter, another angle — until the only remaining answer is "don't read any of it."

## When to Apply

- Configuring or re-running a cross-model adversarial gate (Codex or otherwise) on code whose blast radius is genuinely bounded (local tool, single user, own files) — write the threat model into the gate's reference doc / focus text *before* the run, not after the second no-ship.
- A `catch` block, error boundary, or any other crash-safety backstop is about to read a property off a caught/untrusted value ("just log the safe part") — ask whether the read itself could throw or could carry attacker- or secret-bearing data, not just whether the specific field you picked looks safe today.
- The same adversarial-gate finding keeps recurring on one surface across rounds, each time patched by a slightly narrower version of the same read/transform — that is the signal to stop patching and look for the structural (zero-inspection / zero-data-flow) fix instead of round N+1.
- Reviewing a gate finding that mixes a security claim with an engineering claim (or vice versa) — evaluate and resolve each half independently rather than accepting or rejecting the finding as one unit.
- Onboarding a new harness/surface into an existing scanner or write engine (per `src/scan/index.ts`'s SPINE comment, decisions #40/#44) — the threat model in decision #45 travels with the pattern, so the new surface doesn't reopen the same four-round loop.

## Examples

**Before (round 3 state, `src/scan/index.ts`, prior to the round-4 fix on `feat/u9-inventory-scanners`):**

```ts
} catch (err) {
  // Log the error CLASS only, never its message/stack: an unexpected throw could carry config content,
  // and a config legitimately holds secrets (no secret escapes any read path — the same rule `readParsed`
  // follows). The runtime + class is enough to know which source degraded and roughly why.
  console.error(`[agent-os] inventory scan: '${runtime}' threw ${(err as Error)?.name ?? "an error"} and was degraded`);
}
```

This reads as terminal — "we only log the class, never the message" — and was defeated by the observation that `.name` is ordinary mutable data (any thrown value can set it to anything) and that reading it at all (even via optional chaining) does not guard against a `.name` *getter* that throws.

**After (current tree, `src/scan/index.ts:52-61`):**

```ts
} catch {
  console.error(`[agent-os] inventory scan: '${runtime}' threw and was degraded`);
}
```

Fixed, runtime-only string; nothing derived from the caught value at all. Pinned by two regression tests added in the same change (`tests/scan.test.ts:355-393`):

```ts
// tests/scan.test.ts:355 — a secret smuggled into err.name must never appear in the log
test("runScanners never logs a thrown error's NAME (a name can carry a secret too)", async () => {
  const SECRET = "sk-secret-smuggled-via-error-name";
  const hostileName: SourceScanner = () => {
    const err = new Error("boom");
    err.name = SECRET;
    throw err;
  };
  // ... asserts console.error fired but no logged line contains SECRET
});

// tests/scan.test.ts:377 — a throwing `.name` getter must not escape the catch and abort the sweep
test("runScanners survives a thrown value whose `name` getter throws (backstop never re-throws)", async () => {
  const boobyTrapped: SourceScanner = () => {
    throw Object.defineProperty(new Error("boom"), "name", {
      get(): string {
        throw new Error("getter bomb");
      },
    });
  };
  const ok: SourceScanner = (c) => [
    { runtime: "codex", kind: "mcp", name: "survivor", machineId: c.machineId, source: "agent-os" },
  ];
  const out = await runScanners(ctx(), [
    { runtime: "claude-code", scan: boobyTrapped },
    { runtime: "codex", scan: ok },
  ]);
  expect(out.map((i) => i.name)).toEqual(["survivor"]); // the other runtime completed; nothing escaped
});
```

**The threat model, written once and reused (`.claude/skills/unit-loop/references/codex-gate.md`, "Threat model (decision #45)"):**

```markdown
## Threat model (decision #45) — judge every finding against this, and put it in the focus text

agent-os is a **local, single-user tool operating on the user's OWN files**. Codex defaults to
maximal adversarial assumptions (attacker-controlled everything) unless scoped — an unwritten
threat model is what turned U9's error-logging surface into a 4-round no-ship loop. The scope:

- **In:** "no secret escapes any read path." ...
- **In:** crash-safety/robustness invariants the code claims ...
- **Out:** adversary-injected in-process code ... ("other side of the airtight hatchway")
- **Out:** attacker-owns-HOME beyond bounded-read/no-hang ...

Append a one-line pointer to the focus text, e.g. `"… (threat model: local single-user tool,
own configs — decision #45; adversary-injected in-process code is out of scope)"`.
```

That last line is the compounding mechanism: every future `unit-loop` gate run quotes this scope in its focus text, so the reviewer starts from a calibrated model instead of maximal adversarial defaults, and a future round-4-shaped finding gets adjudicated in one round instead of discovered by attrition.

## Related

- `docs/solutions/architecture-patterns/presence-semantics-not-byte-level-noop-checks.md` — the same shape from U14: repeated adversarial-review rounds each closing one instance of a defect class, resolved only once the fix became a design pass (one shared primitive) instead of another guard. "A design pass, not a fourth guard" is the same move this doc's lesson #2 describes.
- `docs/solutions/conventions/verify-harness-surfaces-against-live-instances.md` — this same unit's (U9) earlier learning, on verifying harness config schemas against live instances rather than assumption.
- `docs/solutions/architecture-patterns/cross-harness-credential-second-location-race-generator.md` — a prior adversarial-gate grind on a different unit that likewise ended in a written design ruling rather than another patch.
- `docs/DECISIONS.md` decision #45 — the full ruling: roster scope, the three deferred issues (#35, #36, #37), and the threat-model text verbatim.
- `.claude/skills/unit-loop/references/codex-gate.md` — the gate's reference doc, now carrying the threat model for every future run. (Note: `.claude/` is gitignored in this repo, so that file is a durable *local* artifact — the git-versioned record of the threat model is decision #45.)
