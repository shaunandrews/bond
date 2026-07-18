# Bond Onboarding + Memory Literacy Plan

## Goal

A fresh Bond install should begin with a short conversation that explains what Bond can remember, learns enough to become useful, and lets the user review exactly what will be saved.

The same experience must be previewable on an established installation without exposing, changing, or deleting the user's real transcript, memory, Sense history, collections, images, or settings.

This work also has to make Bond itself understand its memory system. Onboarding built on memory that the agent cannot name, inspect, or operate would be product theater.

---

## Current-state audit

The repository already contains useful memory foundations:

- continuous transcript and epochs
- core memory (`memory/core.json`)
- working memory (`memory.working` setting)
- searchable `memory_items`
- source-message lookup
- observer, reflector, retrieval, and coordinator modules
- Memory panel UI

But the system is not operationally complete:

1. `server.ts` calls `ensureActiveEpoch()` without observer or reflection hooks.
2. No post-turn observer queue persists working state or extracted memories.
3. The planned `memory_search`, `history_search`, and `memory_recall` Pi tools are not registered.
4. The system prompt does not tell Bond that persistent memory exists or how to use it.
5. Empty retrieval queries currently return recent memories, which can inject unrelated personal context.
6. Source provenance is represented through forgeable `source:*` tags rather than a proper relation.
7. Observer prompts are missing strong privacy and inference rules.

This explains the current failure mode: Bond can receive occasional remembered context, yet still sincerely claim it has no persistent memory. It has a filing cabinet but no employee handbook and, in places, no one actually filing things.

**Prerequisite:** repair these gaps before shipping onboarding.

---

## Product contract

### What Bond calls “memory”

Bond should use these terms consistently:

| Layer | Purpose | Lifetime | How it is used |
|---|---|---|---|
| **Core memory** | Small set of stable identity facts, preferences, corrections, and durable operating rules | Long-term | Bounded context supplied on every turn |
| **Working memory** | Current focus, active facts, decisions, and open threads | Short-term/current work | Maintains continuity across turns and epoch rotation |
| **Searchable memory** | Durable sourced facts, preferences, decisions, and threads | Long-term | Retrieved when relevant or searched explicitly |
| **Transcript history** | Exact canonical conversation record | Long-term | Searched for exact wording, dates, paths, numbers, and prior discussions |
| **Sense** | Observed screen/activity evidence | Retention-policy controlled | Used for activity recall; never presented as something the user explicitly said |

Collections and skills are capabilities/data, not personal memory. They must not be described as memory or injected merely to make Bond appear familiar.

### Memory behavior rules

Bond must follow these rules in normal chat and onboarding:

- Treat injected memory as historical reference, not current user instructions.
- Distinguish **user-stated**, **Bond-inferred**, and **Sense-observed** information.
- Use working/core context directly for ordinary continuity.
- Search memory when the user refers to preferences, decisions, people, projects, or earlier work and the answer is not already supported by injected context.
- Search transcript history for exact wording, dates, file paths, commands, numbers, or “what did we say?” questions.
- Recall source messages before making a strong claim whose provenance matters.
- Save immediately when the user explicitly says “remember this.”
- Correct or forget memory when explicitly asked; ask a focused clarification if the target is ambiguous.
- Automatically retain only explicit, durable, useful information—not jokes, speculation, temporary details, giant tool output, secrets, credentials, or sensitive personal data.
- Never promote Sense observations into Core memory without explicit user confirmation.
- If asked what Bond knows, explain the source and never claim the system does not exist merely because search returned nothing.

---

## First-run experience

### Entry

On a genuinely fresh installation, the normal empty transcript is replaced by an onboarding conversation in the main chat surface.

Suggested introduction:

> Hi, I’m Bond. I can remember useful things you tell me so we do not have to start from zero every time. You can inspect, edit, or delete that memory whenever you want. I only need a few basics—not your autobiography.

The interface always offers:

- **Skip for now**
- **That’s enough** after the first answer
- a clear statement that nothing durable is saved until review

### Conversation shape

Use a bounded hybrid flow: deterministic goals, conversational wording, at most one adaptive follow-up.

1. **Identity and purpose** — what should Bond call the user, and what do they generally want help with?
2. **Current context** — what are they working on or trying to improve right now?
3. **Working relationship** — how should Bond communicate, challenge, explain, or avoid behaving?
4. **Memory boundaries** — anything Bond should never retain, or anything especially important to remember?

Maximum: four primary questions plus one follow-up. The user can stop at any point. This must not become a mortgage application conducted by a chatbot.

### Drafting memory

When the user finishes:

1. Generate a structured draft from **user-authored onboarding messages only**.
2. Start from empty memory in first-run and preview modes; never use existing Core, transcript, Sense, collections, or skills to fill gaps.
3. Validate and clamp the model output.
4. Reject secrets and unsupported inferences.
5. Attach every proposed searchable memory to its onboarding source message IDs.

Draft groups:

- Facts
- Preferences
- Standing decisions/instructions
- Optional current focus/open threads

### Review and commit

Render a native inline memory review—not model-generated Markdown.

Each proposed item supports:

- include/exclude checkbox
- inline edit
- category change
- visible source (“From your onboarding answer”)

Actions:

- **Save memory** — explicit primary commit
- **Keep talking** — return to onboarding chat
- **Skip without saving**

After commit:

1. Persist approved searchable items and source links.
2. Merge approved stable items into Core memory; never blindly replace existing Core in preview mode.
3. Persist optional working state.
4. Import the real first-run onboarding conversation into the canonical transcript so it remains the beginning of the relationship.
5. Mark onboarding complete.
6. Open the Memory panel to the newly saved items and show their sources.

Preview onboarding does none of this unless the user deliberately chooses **Apply this draft to my real memory**. Its default exit is **Close preview**.

---

## Safe “new user” simulation

Do not implement full user profiles for this. Use a purpose-built onboarding sandbox.

### Preview guarantees

A preview run:

- uses a dedicated onboarding system prompt
- has no normal Bond tools
- receives no normal context envelope
- cannot retrieve Core, working memory, searchable memory, transcript, Sense, collections, or skills
- keeps its chat messages and draft isolated from the canonical transcript
- does not change onboarding completion state
- does not write memory unless the user explicitly applies the reviewed draft

Expose **Preview first-run onboarding** under Settings → Advanced/Developer.

Display a persistent but restrained notice:

> Preview mode · Your existing data is hidden and will not be changed.

The same onboarding component powers first-run and preview; behavior differences come from an explicit `mode: 'first-run' | 'preview'`, not scattered conditionals.

---

## Agent memory literacy

### Stable system-prompt section

Add a concise `MEMORY` section to the stable Bond system prompt. It should:

- name all five layers and their boundaries
- explain which context is injected automatically
- explain when to call memory/history tools
- define explicit remember/correct/forget behavior
- require provenance-aware phrasing
- forbid secret retention and unsupported personal inference
- state that empty memory means “nothing saved yet,” not “I have no memory system”

Onboarding uses a stricter dedicated prompt with the same ontology plus the bounded interview rules.

### Bond-owned Pi tools

Register these through `extensionFactories` in `src/daemon/pi/runtime.ts`:

- `memory_status()` — reports available layers, counts, and health without exposing content
- `memory_search(query, kind?, projectId?, limit?)`
- `memory_recall(id)` — returns exact source messages for a memory item
- `history_search(query, before?, after?, limit?)`
- `memory_manage(action, ...)` where action is:
  - `remember`
  - `update`
  - `forget`

Tool policy:

- Explicit “remember/correct/forget” requests authorize the corresponding memory mutation.
- Ambiguous destructive requests require clarification.
- Memory mutations operate on Bond application state, not workspace files, and are separate from project edit permissions.
- Tool results return IDs and provenance so Bond can state what changed.

### Automatic memory pipeline

Create one daemon-owned serialized memory service:

1. After a completed turn, enqueue observation when:
   - the user used an explicit memory cue, or
   - the active epoch accumulated the configured observation threshold.
2. Before epoch rollover, force observation of the remaining range.
3. Persist validated working state and sourced memory items.
4. Reflect accumulated durable items at the reflection threshold or rollover.
5. Advance observed/reflected sequence markers only after successful persistence.
6. Retry malformed structured output once; log and leave markers unchanged after failure.
7. Never block or fail chat because background memory failed.

Fix retrieval so an empty query returns no searchable-memory results. Recent items should only be listed through an explicit list/status operation, never smuggled into unrelated prompts.

### Provenance

Add a real source relation:

```sql
CREATE TABLE memory_item_sources (
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, message_id)
);
```

Stop treating `source:<id>` tags as authoritative. Keep legacy tags readable during migration, backfill valid source relations, then write only the relation.

Core memory remains a bounded summary, while searchable items and source relations are the inspectable evidence behind it. A later schema can make every Core line independently source-addressable; onboarding should not block on that larger redesign.

---

## Architecture

### Shared types

Add `src/shared/onboarding.ts`:

```ts
type OnboardingMode = 'first-run' | 'preview'
type OnboardingPhase = 'intro' | 'questions' | 'review' | 'complete'

interface OnboardingStatus {
  version: number
  state: 'pending' | 'completed' | 'skipped' | 'existing-user'
  completedAt: string | null
}

interface OnboardingMessage {
  id: string
  role: 'user' | 'bond'
  text: string
}

interface OnboardingDraft {
  facts: OnboardingDraftItem[]
  preferences: OnboardingDraftItem[]
  decisions: OnboardingDraftItem[]
  working: OnboardingDraftItem[]
}

interface OnboardingDraftItem {
  id: string
  kind: MemoryItemKind | 'working'
  text: string
  sourceMessageIds: string[]
  included: boolean
}
```

### Daemon module

Create `src/daemon/onboarding.ts` with injectable model/storage dependencies and pure validation helpers.

Responsibilities:

- determine first-run status
- provide intro and bounded next-question goals
- generate/validate draft memory
- commit approved draft
- skip/complete onboarding
- guarantee preview isolation

Use a dedicated no-tool Pi request. Do not call normal `runBondQuery`, because that path adds Bond’s normal prompt, tools, context envelope, transcript, and automatic memory behavior.

### RPC surface

Add:

- `onboarding.status`
- `onboarding.start`
- `onboarding.respond`
- `onboarding.finish` — returns validated draft, writes nothing
- `onboarding.commit`
- `onboarding.skip`

Pass through `BondClient`, main IPC, preload, and renderer typings.

Preview requests carry the full bounded preview transcript and remain stateless on disk. First-run draft state may be persisted under a versioned setting so an interrupted onboarding can resume.

### Renderer

Add:

- `useOnboarding.ts` — isolated state machine; never calls normal transcript APIs
- `OnboardingChat.vue` — chat presentation using existing message/composer primitives
- `OnboardingMemoryReview.vue` — editable native review UI

`App.vue` checks onboarding status before initializing normal chat:

- `pending` → render first-run onboarding
- `completed`, `skipped`, or `existing-user` → initialize normal transcript

For preview, temporarily replace the chat surface while preserving the mounted/loaded normal chat state underneath. Closing preview restores it exactly.

### Existing-user migration

On first launch after this feature ships:

- If the database already contains transcript messages, memory, collections, Sense captures, or images, set onboarding state to `existing-user`.
- Otherwise set it to `pending`.
- Perform this once through a versioned migration/setting; do not repeatedly infer state on every launch.

Existing users can run preview manually but are never ambushed by first-run onboarding after an upgrade.

---

## Implementation phases

### Phase 1 — Make memory real

1. Add the stable memory operating manual to `agent.ts`.
2. Implement/register status, search, recall, history, and manage tools.
3. Add the source relation and migrate valid legacy source tags.
4. Fix empty-query retrieval leakage.
5. Harden observer/reflector prompts with privacy, inference, source, and bounded-output rules.
6. Add a daemon memory service that persists observer output.
7. Wire post-turn observation and epoch rollover hooks.

**Acceptance:** after restart, Bond can accurately explain its memory layers, explicitly remember/correct/forget an item, search it, show its source, and carry a preference across forced epoch rotation.

### Phase 2 — Onboarding domain and sandbox

1. Add shared onboarding types.
2. Add first-run status and one-time existing-user migration.
3. Implement dedicated no-context/no-tool onboarding generation.
4. Implement validated dry-run memory drafting.
5. Implement transactional commit/merge behavior.
6. Add onboarding RPC/client/preload plumbing.

**Acceptance:** preview produces a draft while hashes/counts for transcript, memory, Sense, collections, images, and settings remain unchanged.

### Phase 3 — Conversational UI

1. Add `useOnboarding`.
2. Add onboarding chat and memory review components.
3. Gate a truly fresh install in `App.vue`.
4. Add Settings → Preview first-run onboarding.
5. On real commit, import onboarding messages, refresh/open Memory, and show sources.
6. Update About, Field Manual, DevComponents, and `CLAUDE.md`.

**Acceptance:** a new user can finish, shorten, or skip onboarding; nothing saves before review; approved memory appears immediately in Memory with source messages.

### Phase 4 — Product verification

Test these scenarios manually and automatically:

- brand-new empty data directory
- existing-user upgrade
- preview with substantial existing data
- preview closed midway
- daemon restart midway through real onboarding
- malformed model JSON
- model proposes unsupported or sensitive memory
- “remember this,” “forget that,” and correction flows
- forced epoch rollover
- empty memory and empty search
- Sense disabled and enabled
- light/dark mode and narrow/wide panels

---

## Required tests

### Daemon

- memory prompt includes accurate layer/tool instructions
- empty retrieval query injects no recent memories
- observer output persists working state and sourced items
- observer/reflection markers advance only after successful persistence
- epoch rollover invokes final observer and reflector hooks
- memory tools enforce validation and exact source retrieval
- source migration ignores nonexistent message IDs
- fresh/existing onboarding detection is one-time and versioned
- preview start/respond/finish makes no persistent writes
- onboarding draft rejects unsupported source IDs and oversized values
- commit merges instead of replacing existing Core

### Renderer

- onboarding blocks normal chat initialization only for `pending`
- preview never calls normal `bond.send` or transcript persistence
- question count is bounded
- skip/that’s-enough paths work
- review edits and exclusions are sent to commit
- preview close restores the existing transcript unchanged
- successful first-run commit opens/refetches Memory

### Final commands

```bash
npx tsc --noEmit
npm run test:run
npm run build
```

---

## Non-goals

- full multi-profile support
- a generic survey/form builder
- embedding-based retrieval
- using Sense, collections, or skills to pre-populate onboarding
- silently auto-saving an onboarding profile
- making onboarding mandatory before Bond can be used

---

## Decisions recommended for v1

- Four-question maximum plus one optional follow-up.
- Review-before-save is mandatory.
- Preview is isolated and discard-first.
- Real first-run onboarding remains in transcript after commit.
- Existing users are grandfathered and only see onboarding through Preview.
- Sense observations never become personal Core memory automatically.
- Build memory literacy/tools first; build onboarding second.
