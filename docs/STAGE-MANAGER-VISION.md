# Stage-Manager Vision — agent-os as cross-harness project scaffolder

> **Status: captured brain dump + CTO reflections, 2026-07-16. NOT decisions.** Jarod deferred the deep
> discussion to the post-foundation **MVP-definition session** (after the in-flight U9 → U10 → U15 land).
> This doc exists so the thinking isn't lost; that session refines it, it is not treated as spec. Feeds
> decision **#44**. Parallels `MEMORY-SYSTEM-VISION.md` (a vision doc for one facet).

## The pain that spawned agent-os (Jarod, faithful)

He pays for multiple harnesses/subscriptions (Claude Code, **Codex Pro — barely touched**, Grok Build,
Cursor, …) and wants them across every project, dev and non-dev. Today he works ~one harness per
project (agent-os itself: 100% Claude Code) because there is **no coordination layer and no per-project
orchestration** — the harnesses are isolated at the project / memory / skills / hooks / persona layers.

## The framing

- **agent-os is NOT a harness. It's the stage manager.**
- Skills, memory, personas, hooks, plugins **belong IN the harnesses** — agent-os eliminates the
  isolation, it does not replace the harness.
- **agent-os must NOT be a hard requirement.** He must still open Claude Code in his terminal and work
  with the project's setup intact. It's a wrapper/capability, not a dependency.

### What agent-os owns & provides (his list)
Skills · Memory/Context · Agents/Personas · Hooks · Plugins

### Provisioning before orchestration
First agent-os scaffolds each harness with what it needs; only **later** does it fire off workflows
itself.

### The target capability — the SDLC spread across harnesses
> Architect/Advise/Plan → Execute → E2E QA → Review → PR — each phase a possibly-different harness.
> e.g. Claude Code (Architect/Planner) → Codex (Executor) → Claude Code (Review/adversarial) →
> Grok/Cursor/Agy (E2E QA) → Claude Code (PR).
- **Phase 1:** that exact flow, fixed harnesses.
- **Phase 2:** same flow, swap the harness per phase.

### The MVP question Jarod posed
1. Does agent-os **kick off** the workflow (orchestration)? OR
2. Does agent-os **design & provision** the processes/instructions/skills/personas/hooks each harness
   needs to run it? OR
3. Both?

His lean: **provisioning first (2)**, orchestration (1) later.

### Dogfood path
Run the flow manually via **Herdr** (an agent multiplexer, tmux-like): Claude as orchestrator opens
Herdr panes for Codex (code), loops review subagents over the diff, feeds back to Codex, then a QA pane,
then Claude opens the PR. Once the manual flow works, agent-os automates the sequence.

### His load-bearing claim
**Each harness needs its skills/instructions/roles regardless of agent-os's role.** → therefore
provisioning that setup is agent-os's first, foundational job.

---

## CTO reflections (my read — to pressure-test in the session)

**1. This validates the in-flight foundation; it does not change it.**
- "Observe skills/MCP/hooks across harnesses" = **U9** (in flight).
- "Provision X into harness Y, natively" = **U10 + installers** (U6/U8 already write native Claude Code /
  Codex config).
- "Shared memory across harnesses" = the **Brain seed** (shipped).
- **No impede. Validates + extends.** And it confirms provisioning-first is the right order: because the
  harness-native setup is required either way, owning+provisioning it is the highest-value first move;
  orchestration is an optional layer on top (Herdr can do it by hand).

**2. Sharpen "owns" → "owns the blueprint, not the live config."** (The sync trap.)
- If agent-os owns the *live* harness config, it recreates the two-writer problem that wrecked both
  reference apps (self-reported sync never verified; silent overwrite of a hand-edited skill —
  see FEATURE-CATALOG's reliability findings).
- Cleaner: agent-os owns the **blueprint** (harness-agnostic "what this project needs: Claude=Architect
  + these skills + this workflow"), **provisions** it into each native format, and **observes drift** —
  *proposing* reconcile (#34 propose-first), never silently overwriting.
- The one thing agent-os genuinely *owns* is **Memory** (the Brain substrate; harnesses access via MCP).
- Two tiers fall out of the "not a hard requirement" constraint: (a) the **provisioned native config** =
  the "works even with agent-os off" guarantee; (b) the **running server** = the live shared-brain +
  observe/control layer. Different jobs, both real.

**3. The scope edge = Personas & Plugins.** Foundation covers Skills ✓, Memory ✓, Hooks ✓ (installers).
**Personas and Plugins are not provisioned yet** (deferred). Personas are the crux of the
SDLC-across-harnesses idea — "Claude=Architect, Codex=Executor" *is* persona provisioning. So the bridge
from today's provision engine to the workflow vision = **teach it to provision roles, not just skills.**
Additive, not a rewrite. Likely the core MVP extension.

**4. The workflow roles ARE provisionable objects.** Architect/Executor/Reviewer/QA = personas+skillsets.
So "provision the workflow" = provision the right role-bundle to the right harness. That cleanly
separates the layers: agent-os's MVP job = make each harness *ready to play its role*; the *sequencing*
stays manual (Herdr) until agent-os automates it. Confirms the provisioning-before-orchestration instinct.

**5. Idea — dogfood Herdr NOW; the friction IS the spec.** The plan's biggest written risk: the
Observe+Control pains are "anticipated, not lived." Running Claude→Codex→review→QA→PR by hand converts
anticipated→lived. Every "ugh, I re-pasted context / set up Codex's role by hand / it didn't know where
we left off" is a grounded MVP backlog item. Want that friction list *before* locking the MVP at U11.

---

## Open questions for the MVP-definition session
- **Blueprint-owner vs config-owner:** confirm drift-observe-propose over silent-overwrite. What's the
  per-harness translation of one blueprint (Claude subagents/output-styles/CLAUDE.md ↔ Codex AGENTS.md ↔
  Cursor rules ↔ Hermes)?
- **Which of the five** (Skills/Memory/Personas/Hooks/Plugins) does the MVP actually provision? Personas
  is the swing vote.
- **Is the "project blueprint / profile" a first-class object** in the MVP, or does provisioning stay
  item-by-item? This may reshape U11 from "inventory view" into "blueprint → provision."
- **Minimum felt win:** is it the workflow *scaffolded* (each harness role-ready) even if sequencing is
  100% manual via Herdr?
- **Herdr:** a tool Jarod is committed to, or a stand-in for "some multiplexer"? Does agent-os target it
  specifically or stay multiplexer-agnostic?
- **QA-before-review vs review-before-QA** in the flow (Jarod flagged the uncertainty).
- **Observe/act tagging:** every provisioned capability and every screen element tags observe / act /
  observe-then-act (Jarod's correction — observe is co-equal with act, not the lesser half).

---

## Refinements — skills & personas as versioned per-harness bundles (2026-07-16, same session)

Jarod corrected "own" → **single source of truth**, and added the technical reality that reshapes the
blueprint model.

**Skills are NOT one-size-fits-all across harnesses.** Simple skills port cleanly; complex ones
(scripts, personas, subagents) typically need a **per-harness implementation** — same intent/info,
different handling. Evidence: Claude Code's built-in skill-creator (`anthropics/skills`) vs Codex's
built-in skill-creator (`openai/skills/.system`) are distinct by design. **Primary source to pull when
we do this:** Paul's *"The Dark Arts of Skill Engineering"*, captured at
`~/Obsidian-Vaults/PARA/01-Projects/Agent OS/Skill Design/The Dark Arts of Skill Engineering`.

**So the SSOT is not one canonical form auto-expanded to N harnesses.** It's a **versioned bundle** =
a shared spec/intent + per-harness variants (+ scripts/subagents), kept together in version control.
"Provision" = *select the right variant for the target harness and write it (and its assets) into the
harness's native location*; mechanical translation only for the simple/portable cases.

**Why SSOT matters to Jarod (the real drivers, not "control"):**
- **Version control.** Harnesses mutate their own config constantly (CLI installs, on-the-fly updates),
  so skills drift and are a pain to reproduce via dotfiles.
- **Portability.** New machine (Mac Mini, VPS) is painful today. With bundles in git: clone + run the
  provisioner → every harness gets its native setup. **This is the U10 provisioner + a versioned bundle
  store — no new machinery.**

**Persona/agent formats also differ per harness** (⚠️ UNVERIFIED — research before deciding): Claude
Code `.claude/agents` (Markdown + frontmatter); Codex `.codex/agents` (**TOML**); Cursor `.cursor/agents`.
Same "shared spec + per-harness variant" shape as skills. **Due diligence first** — verify each
harness's current format against live docs (they change fast), never from memory or this doc.

**New instinct — decouple skill authoring into its own module.** An `agent-skill-designer` that
authors/maintains/versions these bundles, usable **without** agent-os; agent-os *composes* it. Fractal
of the core philosophy (agent-os is a wrapper, not a requirement).
- **CTO sharpening:** adopt the **module boundary** now (keep authoring decoupled from agent-os core),
  but a designer is a **boundary, not an MVP mandate.** For the MVP, "SSOT in version control" =
  **a versioned bundle directory + the provisioner (U10).** Hand-authored bundle files are fine —
  probably better — for a long time. A designer earns its existence only if hand-authoring becomes the
  bottleneck. Don't let "it could be its own module" become "build the module."

**The drift model is bidirectional — both explicit, neither silent:**
- **provision-down:** bundle → harness native config (U10).
- **adopt-up:** U9 observes a skill a harness added on the fly that the bundle lacks → surfaces it →
  Jarod picks "adopt into the bundle" or "leave harness-local." This makes the SSOT non-totalitarian and
  directly answers "harnesses add and update things on the fly."

**Secret hygiene:** bundles in version control must not carry embedded tokens or machine-specific
absolute paths — the redaction/secret discipline (KTD2) applies at the authoring/commit boundary, not
just the read path.

---

## Refinement — the dogfood needs a scaffolded project first (2026-07-16)

**Correction to the CTO's "the dogfood needs nothing from us to start" — wrong, and Jarod pushed back
correctly.** True only of our *code* (U9/U10 don't gate it); false about *prep*. Dropping into Herdr
with no role definitions is a shit show — Claude-as-orchestrator has no idea it's meant to open a Codex
pane, wait for completion, hand back, spin up review subagents, etc.

**The dogfood requires a "dogfood project":** something simple, a simple plan, and the **hand-authored
harness instruction/role files** — `CLAUDE.md` + `.claude/agents/`, `AGENTS.md` + `.codex/agents`, skill
files, and an explicit role/responsibility definition per harness for one workflow
(Architect→Execute→QA→Review→PR).

**Key insight — the dogfood project is the precursor + reference spec for agent-os's scaffolding.** By
hand-authoring what one multi-harness workflow needs in each harness, we learn the exact spec the
**provisioner (U10)** should eventually generate automatically. The dogfood setup = the reference
implementation the MVP reproduces. Not just a test — the grounding artifact for U10/U11.

**Sequencing (Jarod):** proceed with in-flight work (U9 …) **until the dogfood becomes critical** — the
natural trigger is **before U10/U11**, since that's what the friction + reference spec ground. Then spend
a focused block creating the dogfood project and deciding what it requires. This is a distinct block from
the MVP-definition session, though they feed each other.
