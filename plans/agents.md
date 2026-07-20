# Agents — Bond's Specialist Roster

Generalize Felix into a definable roster of specialist agents Bond consults for focused work. Each agent is an isolated, read-only session with its own doctrine, verbs, evidence, and report contract. First candidates beyond Felix: **Q** (coding) and **Fleming** (writing).

Builds on `plans/felix.md` (shipped 2026-07-19). Felix stays the reference implementation and becomes the first roster entry.

---

## Why

Felix proved the shape: an isolated specialist with structured verbs, deterministic evidence, and a cited report beats a prompt section pretending to be a second opinion. But everything about him is hardcoded — doctrine, verbs, tools, evidence pipeline, report format. A second agent today means another `design/`-sized module. The roster makes an agent a *definition file* instead: the mechanisms (session runner, evidence runners, context docs, settings, UI) are built once and shared.

## Product rules

1. **Every agent is read-only and artifact-producing.** Agents return artifacts — a report, a draft, a patch — and Bond is the only pair of hands that applies them, through the normal edit/approval flow. No agent ever gets write or bash tools. This is what keeps agents available in every edit mode and keeps approvals plumbing out of nested sessions, permanently.
2. **Verbs are the API.** Each agent declares named workflows (Felix: critique/define/refine/migrate; Q: review/plan/patch/debug; Fleming: outline/draft/edit/tighten). Bond invokes a verb, never free-form chat. Verbs are what make output structured and quality repeatable.
3. **Definitions are files.** `~/.bond/agents/<name>/AGENT.md` — frontmatter for config, body for doctrine and verb workflows. Same scan-on-startup pattern as skills. Built-in agents (Felix) ship bundled; an on-disk definition with the same name overrides the bundled one.
4. **Evidence runners are user-approved commands.** Deterministic evidence (the generalization of the impeccable detector) comes from per-agent shell commands the *tool* pre-runs — the agent never executes anything. Because runners bypass the per-turn approval flow, every distinct command requires **one-time user approval** before it ever runs (persisted allowlist, keyed by command hash). Unapproved runners are skipped with an honest note in the evidence block. Bond can author agents like he authors skills, but he cannot approve runners — only the user can.
5. **Reports have contracts.** Each agent declares its report sections; the session prompt enforces them. Shared spine for every agent: a one-line VERDICT first, and QUESTIONS/ESCALATIONS sections whose contents Bond must relay to the user before acting.
6. **A missing context doc never blocks.** Same rule as Felix: declared context docs (DESIGN.md, style guides, CLAUDE.md) are loaded when found; absence is stated, never fatal.
7. **Settings layer over frontmatter.** Frontmatter carries the agent's defaults; per-agent settings keys (`agents.<name>.<field>`) override them; the Agents tab edits the settings layer, never the definition file.
8. **One level deep.** Agents cannot consult other agents. Bond orchestrates; specialists specialize.

---

## The definition format

`~/.bond/agents/<name>/AGENT.md`:

```markdown
---
name: q
label: Q
role: Coding Consultant
mark: Q
verbs: [review, plan, patch, debug]
tools: []                        # extra Bond tools beyond read/grep/find/ls (e.g. [web_search])
model: high                      # default tier; settings override
thinking: default                # reserved — wired only if the Pi SDK exposes a reasoning control
report: full                     # full | quick
policy: suggest                  # on-demand | suggest | auto
leash: 300                       # max consult wall-clock seconds
context-docs: [CLAUDE.md, CONTRIBUTING.md]
evidence:
  typecheck: npx vue-tsc --noEmit
  tests: npm run test:run
---

Doctrine prose — who the agent is, its rules, its bans.

## verb: review
Workflow for the review verb...

## verb: patch
Workflow for the patch verb...
```

- **Frontmatter** is the same simple parser as skills, extended with two shapes: `[a, b]` inline lists and one-level `key: value` maps (for `evidence:`). Nothing deeper.
- **Body**: doctrine first, then one `## verb: <name>` section per declared verb. The session prompt = shared agent spine (read-only rules, evidence-last anti-anchoring, report spine) + doctrine + the invoked verb's section + the agent's instructions setting.
- **Built-in Felix**: `design/doctrine.ts` is reshaped into a bundled definition with the same fields, registered ahead of the disk scan. His bespoke evidence (impeccable detector, migration inventory) stays native code, referenced as built-in runner names (`impeccable-detect`, `migration-inventory`) that only built-in agents may use.

## Shared controls (the settings layer)

The seven picked in brainstorming, as `agents.<name>.*` settings keys, all editable on the Agents tab:

| Setting | Values | Maps to |
|---|---|---|
| `model` | high / balanced / fast / inherit | tier passed to the agent session (inherit = parent turn's) |
| `thinking` | default / extended | reserved until the Pi session API is verified to expose it |
| `report` | full / quick | report-contract prompt switch (quick = VERDICT + top findings) |
| `policy` | on-demand / suggest / auto | Bond's prompt paragraph for this agent (whether he's told to consult proactively) |
| `leash` | seconds | consult timeout → abort + honest partial-report error |
| `instructions` | text | per-agent "soul" appended to the agent's system prompt (e.g. "we're a WordPress shop; tokens live in theme.json") |
| `tools` | subset of grantable Bond tools | extra read-only Bond tools activated in the agent session (`web_search`, `fetch_content`; later: the eyes tool) |

Storage: existing key-value `settings.ts`, one JSON blob per agent (`agents.felix`), typed accessor `getAgentSettings(name)`.

## Output contracts

- **Report** (all agents): VERDICT → agent-declared sections → EXCEPTIONS/ESCALATIONS/QUESTIONS → NEXT.
- **Draft** (Fleming): the artifact is the prose itself, fenced, plus a short rationale and a list of what he cut. Bond writes it to a file only when asked, via normal approvals.
- **Patch** (Q): unified-diff blocks per file, each preceded by a one-line risk note, plus a what-to-test list. Bond applies hunks via its own edit/write tools — every hunk rides the normal approval flow, so Q's work is reviewable exactly like Bond's own edits. A patch that doesn't apply cleanly is reported back verbatim, never force-fitted.

## Architecture

- **`agents.ts` (daemon)** — scanner + registry: bundled definitions + `~/.bond/agents/` scan, frontmatter parsing, verb-section splitting, validation (unknown tools, undeclared verbs, empty doctrine → skip with a logged reason). Mirrors `skills.ts`.
- **`consult_agent` tool** — one generic tool replacing `consult_designer` (nothing is public yet; clean rename): `consult_agent({ agent, verb, brief, paths?, register? … })` with per-agent extras validated against the definition. The Bond-facing tool description is generic; the roster itself is injected into Bond's system prompt as an "Available agents" section (name, role, verbs, policy) — the same pattern as `buildSkillsPrompt`, so adding an agent needs no runtime.ts edit and the required-tools check stays static.
- **Session runner** — `felix.ts` generalizes to `run-agent.ts`: tool set = `read/grep/find/ls` + granted extras, model from settings→frontmatter→inherit, leash timer wired to abort, in-memory persistence, SSE. Unchanged in spirit.
- **Evidence pipeline** — `evidence.ts`: resolve the agent's runners → check the approval allowlist (`agents.runnerApprovals`, command-hash keyed) → run approved ones with the leash's budget → inject as labeled `<evidence>` blocks (evidence-last ordering preserved). First encounter of a new command surfaces an approval ask through Bond's normal chat flow before anything executes.
- **Agents tab** — AgentsView becomes roster-driven (one RPC: `agents.list` + `agents.updateSettings`): each card gains a settings section (tier, report depth, policy, instructions textarea, leash, tool grants) and a runner-approvals list with revoke.
- **Felix migration** — `design/` keeps the detector + migration inventory as built-in runners; doctrine moves into the bundled definition; `consult_designer` → `consult_agent(agent: 'felix')`; Bond's prompt paragraph regenerates from the roster.

## Out of scope (parked, deliberately)

- **Per-agent, per-project memory** (accepted exceptions, learned voice, known gotchas) — the "agents learn" layer; needs provenance design. Next after this ships.
- **Cost/duration per consult** in the activity row — mostly display work; ride along when convenient.
- **Agent-to-agent consults** — no (rule 8).
- **Eyes** (screenshot/render tool) — separate track; becomes a grantable tool when it exists.
- **Marketplace/sharing** of agent definitions — they're just directories; sharing is copying. Nothing to build.

## Build plan

**Phase 1 — registry + generic runner (~a day):** `agents.ts` scanner/registry with the extended frontmatter parser, `run-agent.ts`, `consult_agent`, roster prompt section, Felix migrated to a bundled definition with his native runners. `consult_designer` removed. Tests: parser, registry validation, runner, tool routing.

**Phase 2 — settings layer + Agents tab (~half a day):** `getAgentSettings`, the seven controls, `agents.list`/`agents.updateSettings` RPCs (protocol bump), roster-driven AgentsView with editable settings. Tests: settings precedence, RPC, component.

**Phase 3 — evidence runners + first new agent (~a day):** `evidence.ts` with the hash-approval allowlist and chat-surfaced approval ask; ship **Q** as the proving agent (review + patch verbs, typecheck/tests runners, patch contract). Fleming follows as a definition-only exercise — if adding him requires code, phase 1 failed.

Dogfood target: Q reviews one of Bond's own PR-sized diffs and returns an applying patch; Felix keeps working identically through the generic path.
