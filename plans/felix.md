# Felix — Bond's Design Consultant

Felix Leiter is Bond's designer pal: a subagent Bond consults for design work, specialized in **design systems** — defining them, using them, refining them, and migrating designs that have none or ignore the one they have. Bond asks; Felix reads, judges, and reports; Bond does the work.

---

## Why

Bond does design work today with nothing but base-prompt taste. That produces the statistical average of training data — the exact "AI slop" problem (Inter everywhere, purple gradients, nested cards, cream backgrounds) that impeccable (github.com/pbakaus/impeccable) was built to fight. Three specific failures Felix fixes:

1. **No independent judgment.** Critique from the same context that wrote the code anchors on its own reasoning. Impeccable's own `critique` command flags itself DEGRADED when it can't run isolated sub-assessments. Felix IS the isolated assessment.
2. **No system discipline.** Nothing stops Bond from inventing off-token values mid-task. Drift compounds silently.
3. **No migration story.** Even impeccable — the strongest tool in this space — can *report* "hard-coded colors in 15+ components" but has no flow for remapping an off-system design onto its tokens. Nobody has built this. Felix's migrate verb is genuinely new ground.

Felix's doctrine is distilled from a full read of the impeccable corpus (~40 reference files + 46 detector rules + scripts, Apache-2.0). We vendor its governance mechanics and document formats, shell out to its deterministic detector, and skip its 23-command surface. See "Vendored vs. built" below.

---

## Product rules

1. **Felix is a consultant, not an editor.** v1 Felix is read-only: he reads code, runs no writes, triggers no approvals, and returns a report. Bond applies changes. (This also sidesteps the approvals registry entirely — a nested agent with write tools needs turn-scoped approval plumbing we don't want yet.)
2. **The system is the boundary.** When a design system exists (DESIGN.md, tokens, theme files, shared components), Felix treats it as law. He never recommends new colors, fonts, radii, shadows, or effects as one-offs — expansion goes through the escalation protocol (rule 4).
3. **Every deviation gets a root cause.** Felix classifies all drift as one of three kinds, each with a different fix: **missing token** (the value should exist in the system but doesn't → add it), **one-off implementation** (a shared component/token exists but wasn't used → swap to it), or **conceptual misalignment** (the flow/IA/hierarchy diverges from neighboring features → rework it). Fixing the symptom without naming the cause is how drift compounds.
4. **Extension by escalation, never by accident.** If the system is genuinely too limited, Felix stops and names: the exact proposed additions, the role each plays, and why existing primitives can't do the job. If Shaun approves, the additions are written into the tokens/DESIGN.md *alongside* the implementation. Extension is legal; undocumented extension is not.
5. **Two graders, not one taste.** Felix infers or asks the **register** before judging: `brand` surfaces (marketing, landing) are graded on distinctiveness — safe = invisible; `product` surfaces (app UI) are graded on disappearing into the task — consistency IS an affordance. Per-surface overrides are legal but must be named.
6. **Evidence, not vibes.** Every verdict cites file/selector/value — never a bare "looks good." Detector output is defect evidence, never proof of finish: a clean scan is a floor, not a verdict (an on-token but monotone design passes every rule).
7. **A missing DESIGN.md never blocks a scoped request.** No system? The existing code is the context; Felix proceeds and offers the define verb once, as a suggestion.
8. **Felix runs isolated.** Own Pi session, own system prompt, in-memory persistence, no streaming into the parent transcript, killed by the parent turn's abort signal. His report returns as the tool result; the turn activity row shows "Consulting Felix…" while he works.
9. **Felix never fabricates iteration.** No inventing defects to demonstrate rigor. "First pass clean" is a legal verdict.

---

## The four verbs

Bond routes design asks to one of four Felix verbs. The verb is a tool parameter, not something Felix guesses.

### 1. `critique` (use the system — the default verb)

Bond's "what does Felix think of this?" Also the verb Bond calls mid-build to check his own work.

Flow:
1. **Context load** — read PRODUCT.md/DESIGN.md if present (resolution order matches impeccable's `context.mjs`: project root → `.agents/context/` → `docs/`), plus at least one real token/component file. Determine register.
2. **Deterministic evidence** — the `consult_designer` tool pre-runs the detector (see Architecture) and injects its JSON findings into Felix's context *alongside*, not instead of, his own judgment pass. Felix runs his assessment checklist first, then reconciles against detector output, so machine findings don't anchor visual judgment.
3. **Judge** — against the register rubric + the doctrine's mechanical rules (contrast ≥4.5:1 body / ≥3:1 large, 65–75ch measure, type ratio ≥2:1 max/min, all interactive states present, motion conveys state, reduced-motion honored) + the ban list (side-stripes, gradient text, glassmorphism-as-default, identical card grids, eyebrow-chip-above-every-heading, numbered section scaffolding, cream-by-default).
4. **Report** — see Report format.

### 2. `define` (create the system)

Two modes, vendored nearly whole from impeccable's `document`:

- **Scan mode** (code exists): grep tokens (`--color-`, `--font-`, `--spacing-`, `--radius-`, `--shadow-`), Tailwind `theme.extend`, token JSON, the main button/card/input/nav components → auto-extract the palette, type ramp, radii, spacing → then ask Shaun for what can't be extracted: a Creative North Star (one named metaphor), color character in descriptive names ("Deep Muted Teal-Navy," not "blue-800"), elevation philosophy → write DESIGN.md.
- **Seed mode** (pre-code): five questions in one round — color strategy (Restrained: accent ≤10% / Committed: one color 30–60% / Full palette: 3–4 roles / Drenched: the surface IS the color), typography direction, motion energy, 2–3 *named* references (products, not adjectives), one anti-reference → write a seed-marked scaffold, values `[to be resolved during implementation]`.

DESIGN.md follows the Google Labs DESIGN.md/Stitch spec (YAML frontmatter: `colors`/`typography`/`rounded`/`spacing`/`components`, token refs as `{path.to.token}`, components alias primitives, primitives never alias each other; six fixed prose sections). Staying spec-compatible keeps the file consumable by impeccable's detector and every other DESIGN.md-aware tool. Prose sections use **Named Rules** ("**The One Voice Rule.** The primary accent is used on ≤10% of any screen. Its rarity is the point.") in forceful design-director voice — one-sentence audit tests beat paragraphs of principle. Every PRODUCT.md anti-reference reappears as a Don't in the same language. Honesty rules: don't tokenize one-offs, don't invent components that don't exist, omit roles rather than fabricate them.

Never silently overwrite an existing DESIGN.md — offer refresh, overwrite, or merge.

### 3. `refine` (grow and curate the system)

The spec↔code round-trip impeccable never closes:

- **Extraction candidates**: patterns used **3+ times with the same intent** become component/token proposals ("two buttons that look similar but serve different purposes stay separate"). Premature abstraction is worse than duplication.
- **Spec reconciliation**: diff DESIGN.md against reality — tokens documented but unused, values used but undocumented, components drifted from their documented snippet. Output: a refresh plan for the doc AND a fix list for the code, classified by rule 3's taxonomy.
- **Token lifecycle**: rename/deprecate proposals come with a consumer inventory (every usage site) and a staged rollout, never a bare "rename X to Y."
- Any addition approved through the escalation protocol (rule 4) gets written into DESIGN.md as part of the same change — refine keeps the doc and the code moving together.

### 4. `migrate` (adopt the system — the new machinery)

For no-system and ignored-system designs. The campaign:

1. **Inventory** — detector drift rules + targeted greps (literal hex/rgb/oklch, `font-size:`, `border-radius:`, arbitrary Tailwind `p-[`/`text-[`/`gap-[`) over the target paths. `var(...)` usages are by definition on-system; only literals are drift.
2. **Cluster** — canonicalize values (colors → rgb, sizes → px) and group near-duplicates; 14 slightly-different grays are one decision, not 14.
3. **Map** — each cluster to its nearest existing token, using tolerance matching (±6 per RGB channel, ±0.5px radii/sizes — impeccable's own thresholds). Three buckets: *exact/near match* (mechanical swap), *close-but-questionable* (Felix judges: intent match or coincidence?), *no candidate* (goes to the escalation protocol as a proposed token or gets flagged as a deliberate exception).
4. **Plan** — a staged remap: batch by component/route, each batch small enough to verify, with expected visual deltas named up front (a true migration is near-pixel-identical; anything that visibly changes gets called out for approval).
5. **Report** — Bond executes batches; Felix re-runs inventory to verify the literal count trends to zero.

---

## Report format

One structure for all verbs, so Bond and the UI can rely on it:

```
VERDICT: one sentence, plain language.
REGISTER: brand | product (+ how determined)
SYSTEM: found at <path> | none found (offered define)

SCORES (0–4 each, 4 = genuinely excellent, not "good enough"):
  hierarchy, color/contrast, typography, spacing/layout,
  states/interaction, system-compliance

FINDINGS (P0–P3, each):
  [P1] <file>:<line> — <what> — root cause: missing-token | one-off | misalignment
       fix: <specific action, named token/component>

EXCEPTIONS: deviations judged deliberate and fine, with reasons.
ESCALATIONS: proposed system additions (exact tokens, role, why existing
  primitives can't do the job) — awaiting approval.
NEXT: the single most valuable follow-up verb, if any.
```

P0 = broken/inaccessible, P1 = visibly wrong or systemic drift, P2 = polish, P3 = nice-to-have.

---

## Vendored from impeccable vs. built

| Piece | Decision |
|---|---|
| Governance mechanics (drift taxonomy, Design-System Lock + escalation, register split, "clean scan is a floor," evidence-cited verdicts) | **Vendor into Felix's prompt** — distilled, with attribution |
| DESIGN.md + PRODUCT.md formats (Google Labs spec) | **Adopt as-is** — interop is the point |
| Deterministic detector (46 rules, 4 design-system drift rules that read DESIGN.md) | **Shell out**: `npx -y impeccable@<pinned> detect --json` — don't rebuild; treat as optional evidence (offline/missing npx degrades gracefully, Felix says so in the report) |
| Mechanical rule numbers (contrast, measure, ratios, ban list) | **Distill into doctrine** — the numbers, not the prose |
| 23-command surface, slash routing, post-edit hooks, live browser mode, palette seeds | **Skip** — Bond speaks verbs, not commands; hooks and live mode are harness glue we don't need |
| Migrate campaign machinery (cluster → nearest-token map → staged remap) | **Build** — doesn't exist anywhere |
| Spec↔code reconciliation + token lifecycle | **Build** |

License: Apache-2.0 — vendoring and distillation are sanctioned; keep a NOTICE line in the doctrine files.

---

## Architecture

### The tool

`consult_designer` (label: "Consult Felix"), a Bond-owned Pi tool following the `web/tools.ts` pattern:

```
consult_designer({
  verb: 'critique' | 'define' | 'refine' | 'migrate',
  brief: string,          // what Bond wants Felix's take on
  paths?: string[],       // scope; defaults to cwd heuristics
  register?: 'brand' | 'product'  // when Bond already knows
}) → report (markdown, the tool result text) + details { verb, register, paths, contextDocs }
```

Available in **all edit modes including readonly** — Felix never writes.

### The session

`runFelixQuery` in `src/daemon/design/felix.ts`, modeled on `runPiTextPrompt` (`pi/runtime.ts:490`):

- `createAgentSession` with Felix's own `systemPromptOverride` (doctrine + verb workflow + report format).
- Tools: `read`, `glob`, `grep` only. No bash, no writes → no approvals plumbing needed.
- `SessionManager.inMemory()` + `SettingsManager.inMemory()` — Felix never touches the epoch JSONL.
- Parent tool `execute`'s `signal` wired to session abort — cancelling the turn kills Felix.
- No `onChunk` — Felix works silently; the parent turn activity shows the running tool. (Later: a sub-stream sink for live Felix narration, only if silence feels bad in practice.)
- Model: inherit the parent turn's tier.

### Detector pre-run

`src/daemon/design/detector.ts`: before spawning Felix, the tool runs `npx -y impeccable@<pinned> detect --json <paths>` (10s timeout) and passes results into Felix's first user message under a clearly-labeled evidence block. Rationale for pre-run vs. giving Felix bash: keeps Felix read-only/approval-free, keeps the detector version pinned, and the prompt orders his checklist pass *before* the evidence block to preserve the no-anchoring principle.

### Doctrine

`src/daemon/design/doctrine.ts` — prompt fragments as TS string constants (the `BOND_BASE_PROMPT` pattern; no esbuild loader or typecheck shims needed): identity, core rules + bans, the two registers, one block per verb, and the DESIGN.md format contract. Baked into the daemon bundle so Felix works everywhere without filesystem setup; per-project state lives in the project's own PRODUCT.md/DESIGN.md. Apache-2.0 attribution to Impeccable rides in the prompt itself.

### Registration (the three mechanical edits)

1. `createDesignExtensionFactory` added to `extensionFactories` (`pi/runtime.ts:360`).
2. `DESIGN_TOOL_NAMES` added in `toolsForEditMode` (`pi/runtime.ts:306`) — all modes.
3. Names flow into the required-tools check (`pi/runtime.ts:427`) automatically.

Plus one system-prompt paragraph in `agent.ts` telling Bond who Felix is and when to consult him (design/UI/UX asks, before shipping visual changes, when a user mentions tokens/consistency/redesign).

### Files

```
src/daemon/design/
  tools.ts          # consult_designer registration (+ tools.test.ts)
  felix.ts          # runFelixQuery — session lifecycle (+ felix.test.ts)
  doctrine.ts       # distilled knowledge as prompt constants (attributed)
  prompt.ts         # doctrine assembly per verb/register (+ prompt.test.ts)
  context-docs.ts   # PRODUCT.md/DESIGN.md resolution (+ context-docs.test.ts)
  detector.ts       # impeccable detect wrapper, graceful degradation (+ detector.test.ts)
  migrate.ts        # inventory → cluster → token mapping (+ migrate.test.ts)
src/daemon/pi/
  model.ts          # pickModel/selectModel extraction (+ model.test.ts) — breaks the runtime↔felix cycle
```

**Built 2026-07-19, all phases in one pass** (critique/define/refine/migrate shipped together; the phase split below is the original estimate, kept for the record).

---

## Out of scope (later, separate conversations)

- **Eyes** — a screenshot/render tool returning image blocks so Felix can judge pixels, not just code. The capture primitives exist (`captureScreenshot` surface member, the hidden render host in `src/main/web.ts`); wiring them into tool results is its own task. v1 Felix judges source + any screenshots already attached to the conversation.
- **Felix edits files** — requires nested-approval plumbing through `approvals.ts`.
- **An agent roster** — generalizing to `~/.bond/agents/*.md` definitions (Pi's example subagent extension is the template) so Felix becomes the first of many. Only after Felix earns it.
- **Full impeccable install** as a Bond skill — superseded by this design; revisit only if we want its build commands (`craft`/`shape`) verbatim.

---

## Build plan

**Phase 1 — Felix critiques (~a day):** doctrine files (core + registers + critique verb), `prompt.ts`, `felix.ts`, `detector.ts`, `tools.ts`, runtime registration, Bond's system-prompt paragraph, tests for all four modules. Ship when: Bond can ask "have Felix look at SettingsView" and a cited, scored report comes back.

**Phase 2 — define + refine (~half day):** the two DESIGN.md-authoring verbs (doctrine + the never-overwrite-silently flow). Ship when: Felix can generate a spec-valid DESIGN.md for Bond's own renderer from `app.css` + the component library.

**Phase 3 — migrate (~a day):** inventory/cluster/map machinery (pure functions in `design/migrate.ts`, heavily unit-tested — this is the part with real logic), the staged-plan report. Ship when: Felix can produce a full remap plan for a deliberately off-system test fixture.

Dogfood target after phase 2: run `define` on Bond itself — the design-token table in CLAUDE.md is already half a DESIGN.md.
