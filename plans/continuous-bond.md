# Continuous Bond — implementation handoff

## Goal

Bond must feel like one persistent assistant. The user never creates, names, favorites, archives, switches, or deletes chats. The visible transcript is continuous. Internally, Bond rotates short Pi sessions (**epochs**) before context gets bloated, maintains a small working state, extracts durable memory, and can search both memory and the exact raw transcript.

This is a greenfield cutover. Do not preserve the current chat/session schema or UI for compatibility. Existing Bond data may be deleted once.

### Handoff state warning

At the time this plan was finalized, another workstream had already created untracked prototypes under `src/daemon/transcript.ts`, `src/shared/transcript.ts`, `src/daemon/transcript.test.ts`, and `src/daemon/memory/`. Treat them as partial scaffolding, not accepted architecture. Before building further, reconcile them with this plan. Known mismatches in the prototype: it rebuilds the legacy messages table instead of doing the destructive cutover, requires an epoch before queueing, has no `queued` turn state, does not insert the assistant placeholder, allows renderer upserts to overwrite immutable role/epoch/turn fields, and lacks `observed_at_context_tokens`. Fix or replace those pieces rather than designing around them.

## Product rules

1. **There is one Bond.** No user-visible chat/session concept remains.
2. **Epochs are internal execution plumbing.** Never expose them in normal UI copy.
3. **The visible transcript never resets when an epoch rotates.**
4. **Pi JSONL is execution state, not the product transcript.** Bond SQLite is the canonical visible history.
5. **Context stays bounded.** Normal epoch rotation happens around 64k active-context tokens, not near the provider limit.
6. **Memory stays layered.** Do not turn `MEMORY.md` into a transcript-shaped junk drawer.
7. **Recall is source-linked.** Durable memories point back to exact Bond messages.
8. **Everything ships inside Bond.** Use bundled SQLite FTS5. No QMD, external daemon, model download, or separately installed CLI.
9. **Preserve the new tool-calling UX from commit `9bda2cc`.** One persisted `meta/activity` message per turn, inline thinking/tool/result history, and `ApprovalPrompt` above the composer must continue working.
10. **Do not add migration theater, analytics, baselines, feature flags, or compatibility shims.** Build the new product directly.

---

## Target architecture

```text
Vue: one transcript
       │
       ├── transcript.list / transcript.upsert
       ├── bond.send / bond.cancel / approvals
       │
Bond daemon
       ├── one foreground query at a time
       ├── epoch coordinator
       │     └── Bond-owned Pi JSONL under app data
       ├── memory coordinator (serialized background jobs)
       │     ├── observer → observations + working state
       │     ├── reflector → durable reflections
       │     └── bounded core-memory updater
       └── SQLite
             ├── epochs + turns + messages
             ├── observations + reflections + sources
             └── FTS5 indexes for transcript and memory
```

Use the ideas from `pi-observational-memory` and `pi-hermes-memory`; do **not** install either extension wholesale. Adapt only the small pieces Bond needs under `src/daemon/memory/`. Bond already disables normal Pi extensions, skills, prompts, and context files, which keeps terminal Pi and Bond isolated.

---

## Data cutover

### Reset policy

Add an application schema version constant in `src/daemon/db.ts`. On startup, if the stored schema version is absent or differs from the new version:

1. Close SQLite.
2. Delete `bond.db`, `bond.db-wal`, and `bond.db-shm`.
3. Delete Bond-owned Pi epoch JSONL files under `<dataDir>/pi/sessions/`.
4. Reopen SQLite and create the new schema.

This reset is intentional. Do not migrate legacy sessions, titles, debriefs, archives, favorites, or messages. Preserve image files only if doing so does not complicate the reset; otherwise clear the Bond image directory too. Shaun explicitly accepts a clean slate.

Keep only the non-chat schemas still used by the current server/UI: `settings`, collections + item comments, Sense capture/session tables, and images. Explicitly drop the dead todo/project/journal/operative schemas and all session-debrief tables; they are leftover bloat with no active server module. Remove `journal_entries.session_id`, `sense_debriefs`, and every other foreign key to legacy chat sessions. Rewrite `sense.search` to search Sense captures only; durable Bond memory/history has its own tools and RPCs. The one-time reset can erase all current rows.

### New chat/memory schema

Use these tables and names. Timestamps are ISO-8601 UTC strings.

```sql
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE epochs (
  id TEXT PRIMARY KEY,
  pi_session_id TEXT NOT NULL UNIQUE,
  pi_session_file TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','closed')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 0,
  observed_through_seq INTEGER NOT NULL DEFAULT 0,
  observed_at_context_tokens INTEGER NOT NULL DEFAULT 0,
  reflected_through_seq INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_active_epoch ON epochs(status) WHERE status = 'active';

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  epoch_id TEXT REFERENCES epochs(id),
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  activity_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
  model TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  context_tokens INTEGER,
  context_window INTEGER
);
CREATE INDEX idx_turns_epoch ON turns(epoch_id, started_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  epoch_id TEXT REFERENCES epochs(id),
  turn_id TEXT REFERENCES turns(id),
  seq INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('user','bond','meta')),
  kind TEXT,
  text TEXT,
  data TEXT,
  image_ids TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_messages_cursor ON messages(seq DESC);
CREATE INDEX idx_messages_epoch ON messages(epoch_id, seq);

CREATE VIRTUAL TABLE message_fts USING fts5(
  message_id UNINDEXED,
  text,
  kind UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE working_state (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  source_epoch_id TEXT
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT,
  importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
  status TEXT NOT NULL CHECK(status IN ('active','superseded','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE observation_sources (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(observation_id, message_id)
);

CREATE TABLE reflections (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','superseded','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reflection_support (
  reflection_id TEXT NOT NULL REFERENCES reflections(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  PRIMARY KEY(reflection_id, observation_id)
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  record_id UNINDEXED,
  record_type UNINDEXED,
  content,
  scope,
  kind,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE pending_approvals (
  request_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL REFERENCES epochs(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  tool_name TEXT NOT NULL,
  input TEXT,
  title TEXT,
  description TEXT,
  created_at TEXT NOT NULL
);
```

Do not use complicated FTS triggers. The store functions that insert/update/delete messages or memories must update the corresponding FTS row in the same SQLite transaction.

Images no longer belong to sessions. Update `images.ts` so attachments set `source_message_id`, while media-library imports leave it null. Remove the fake “Screenshots” session created by `importImage()`, remove `deleteSessionImages()`, and remove `sessionId` from `ImageRecord`. A message's `image_ids` JSON controls display; deleting a transcript message does not delete the underlying media file.

Store core memory at `<dataDir>/MEMORY.md`, not in `~/.pi` and not in the repo. Create it with a short explanatory heading on first launch.

---

## IDs and ownership

The renderer generates these UUIDs before `bond.send`:

- `turnId`
- `userMessageId`
- `assistantMessageId`
- `activityMessageId`

Pass all four to the daemon. This gives the runtime, transcript, activity UI, and memory source links the same stable IDs.

The daemon assigns the active `epochId` and monotonic message `seq` values. Use `MAX(seq) + 1` inside a transaction; there is only one writer process.

The renderer may optimistically show the user/activity messages, but the daemon is responsible for inserting the canonical initial rows before starting Pi. Renderer updates to assistant/activity rows use upsert-by-ID, never whole-transcript replacement.

---

## RPC and stream cutover

### Remove

Delete these RPCs and all client/preload/Electron bridges for them:

- `session.list`
- `session.create`
- `session.get`
- `session.update`
- `session.delete`
- `session.deleteArchived`
- `session.getMessages`
- `session.saveMessages`
- `session.generateTitle`
- session-specific subscribe/unsubscribe
- session debrief RPCs and backfill

### Add

```ts
bond.send({
  text,
  images?,
  turnId,
  userMessageId,
  assistantMessageId,
  activityMessageId,
}) -> { ok, queued, imageIds? }

bond.cancel() -> { ok }                    // abort active turn only
bond.dequeue({ turnId }) -> { ok }          // remove queued turn and mark it cancelled
bond.subscribe() -> { ok }                 // one global stream + queue/approval replay
bond.approvalResponse({ requestId, approved }) -> { ok }

settings.getEditMode() -> EditMode
settings.setEditMode({ editMode }) -> { ok }

transcript.list({ beforeSeq?, limit? })
  -> { messages: TranscriptMessage[], nextBeforeSeq: number | null }
transcript.upsert({ messages: TranscriptMessage[] }) -> { ok }

memory.getState()
memory.search({ query, kind?, scope?, limit? })
memory.recall({ id })
memory.updateCore({ content })
memory.updateRecord({ id, content?, status?, scope?, kind? })
```

Replace `TaggedChunk.sessionId` with `epochId` and `turnId`. Every active-turn chunk carries both. Queue notifications carry `turnId` but no epoch until execution begins. `assistant_text` also carries the preallocated `assistantMessageId`, so the renderer never guesses which message to append to. Keep `piEventToChunks()` request-agnostic: `server.ts` stamps epoch/turn/message IDs in `broadcastChunk`, just as it stamps `sessionId` today. Add a typed `queue_update` stream event containing the ordered queued turn IDs and visible text/image metadata.

There is one daemon-authoritative foreground query and one daemon-authoritative FIFO queue shared by Main and Quick Chat. Replace `activeQueries: Map<sessionId,...>` with `activeQuery: { epochId, turnId, ac, promise } | null` plus `queuedTurns: QueuedTurn[]`. Every `bond.send` inserts canonical queued transcript rows, acknowledges immediately with `{ok:true, queued:boolean}`, and starts an async queue processor. The processor runs `ensureActiveEpoch()`, assigns the queued turn/messages to that epoch, then broadcasts `query_start`. This means epoch rotation may take time without making the `bond.send` RPC hang. Broadcast `queue_update` whenever the queue changes so both windows render the same state. On daemon startup, mark orphaned `queued`/`running` turns cancelled rather than trying to resume half a tool run.

Replace per-session WebSocket subscribers with a single subscriber set. Pending approvals are associated with the active epoch/turn. Simplify Pi's approval map to turn-scoped entries; do not preserve the old chat-ID/session-ID overload.

Memory background jobs use no tools and never emit normal activity or approval chunks.

---

## Transcript implementation

Create `src/daemon/transcript.ts` and `transcript.test.ts`. Move only reusable row conversion logic from `sessions.ts`; do not preserve the `Session` abstraction.

Required store operations:

- `insertTurnStart(...)`: transactionally insert a `queued` turn plus user, initial `meta/activity`, and empty Bond assistant placeholder messages. The three messages receive consecutive `seq` values immediately, preserving transcript order even while queued. Hide empty Bond placeholders in the renderer and delete the placeholder at completion if no assistant text was produced.
- `upsertMessages(messages)`: update only supplied IDs. Never delete rows absent from the request. Existing rows may update only mutable payload fields (`text`, `data`, `image_ids`, `updated_at`); never accept renderer changes to `seq`, role, epoch, or turn. If the renderer sends a genuinely new meta error/system row, assign its `seq` in the daemon transaction and return the canonical row.
- `completeTurn(...)`: set turn status/usage and update the epoch usage.
- `listMessages({ beforeSeq, limit })`: newest-page query, returned oldest-to-newest for rendering.
- `getMessagesForRange(fromSeq, toSeq)`: observer input.
- `getSourceMessages(ids)`: exact recall.
- `searchMessages(query, filters)`: escaped/bounded FTS5 query.

Index only useful text:

- user and Bond message text
- error/system text
- compact searchable tool labels and outputs from activity data

Do not index raw base64 images or giant tool payloads. Cap indexed tool output to 4,000 characters, matching the current activity payload cap.

Refactor `useChat.ts` from per-session state into one state machine:

- remove `currentSessionId`, `busySessions`, `backgroundMessages`, per-session queues, switching locks, and per-session localStorage keys
- keep `messages`, `busy`, `pendingApprovals`, turn activity reducers, context usage, HMR survival, and crash stash
- make the displayed queue a projection of daemon `queue_update` events; submitting/dequeuing goes through RPC, so multiple windows cannot race independent client queues
- initial load fetches the newest 100 messages
- scrolling to the top fetches older pages and preserves scroll position
- changed streaming messages are upserted at most once every 2 seconds; flush immediately on query end
- use one crash key such as `bond:transcript-tail-backup`, containing only the newest 100 in-memory messages
- reconnect recovery simply upserts the backup rows by stable ID, then clears the backup after success; remove the current full-session count/text-length comparison because cursor paging cannot support it

Keep `TurnActivityData` and the current inline activity behavior. Do not regress thinking, tool inputs/outputs, timings, approval decisions, failed state expansion, or queue behavior.

---

## Epoch coordinator

Create `src/daemon/epochs.ts` and `epochs.test.ts`.

### Thresholds

After each completed Pi turn, read `session.getContextUsage()` **before disposing the Pi session**. Use its `tokens` and `contextWindow`; do not estimate from character count when Pi has usage.

Set rotation pending when:

```ts
const softLimit = Math.min(64_000, Math.floor(contextWindow * 0.40))
contextTokens >= softLimit
```

Keep Pi auto-compaction enabled only as emergency overflow protection. Construct `SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 30_000, keepRecentTokens: 10_000 } })`. Normal operation must rotate well before that path.

### `ensureActiveEpoch()`

Called at the start of every `bond.send`:

1. Return the existing active epoch if it is below its rotation limit.
2. If it is rotation-pending, wait for the serialized memory queue to flush.
3. Force one final observer pass for unprocessed messages.
4. Run reflection if enough unreflected observations exist.
5. Mark the old epoch closed with reason `context_limit`.
6. Create a new epoch row and fresh Pi session ID.
7. Return the new epoch.

A new Pi epoch starts only on the next user turn. Do not generate an empty model turn merely to initialize it.

If observer/reflection fails at rotation, log the error, mark the old epoch closed anyway, and seed the next epoch from current working state plus the most recent 12 substantive user/Bond messages. Never trap the user in an oversized epoch because background memory had a bad day.

### Pi runtime changes

Change `runPiBondQuery` to return:

```ts
interface PiBondQueryResult {
  succeeded: boolean
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
  turnTranscript: Array<{
    sourceMessageId: string
    role: 'user' | 'bond' | 'tool'
    text: string
  }>
}
```

Remove `legacyTranscript()`. A fresh epoch gets continuity from the context envelope described below, not from old chat migration text. `turnTranscript.role = 'tool'` is runtime-only observer input; map its `sourceMessageId` to the turn's `meta/activity` message. Never insert a database message with `role='tool'`.

`runPiBondQuery` still opens/creates `SessionManager` by internal epoch ID. Pi files remain under `<dataDir>/pi/sessions/`. Terminal `pi` sessions remain unrelated.

---

## Context envelope

Do not rebuild a large changing system prompt every turn. Keep the epoch system prompt mostly stable: Bond base prompt, Soul, tool rules, skills/collections reference, memory tool instructions, and edit-mode rules.

Before each user prompt, build a bounded context envelope. Pass the envelope only to Pi; SQLite stores and indexes the original visible user text, never the envelope, recalled records, or handoff material:

```xml
<bond-context historical="true">
  <core-memory>...</core-memory>
  <working-state>...</working-state>
  <recent-handoff>...</recent-handoff>        <!-- new epoch only -->
  <recalled-memory>...</recalled-memory>      <!-- only when relevant -->
  <recent-screen-context>...</recent-screen-context>
</bond-context>

USER MESSAGE:
...
```

The system prompt must say that `<bond-context>` is historical reference, not fresh user instructions. Escape or delimit remembered text so prompt-shaped content cannot silently become system policy.

Hard budgets:

- core memory: 8,000 characters
- working state: 4,000 tokens
- new-epoch handoff/recent tail: 3,000 tokens
- automatic recalled memory: 2,000 tokens
- recent Sense context: keep current short summary behavior

If a section exceeds its budget, trim by structured priority, not arbitrary middle slicing.

Edit mode is no longer session-specific. Store it under settings key `edit_mode`, expose the `settings.getEditMode` / `settings.setEditMode` RPCs listed above, and keep the current selector in `ChatInput`.

---

## Memory modules

Create this directory:

```text
src/daemon/memory/
  types.ts
  store.ts
  store.test.ts
  working-state.ts
  working-state.test.ts
  core-memory.ts
  core-memory.test.ts
  prompts.ts
  parser.ts
  parser.test.ts
  observer.ts
  observer.test.ts
  reflector.ts
  reflector.test.ts
  retrieval.ts
  retrieval.test.ts
  tools.ts
  tools.test.ts
  coordinator.ts
  coordinator.test.ts
```

Every model-produced JSON payload must be parsed and validated. Use explicit TypeScript validators or a small local schema helper; do not accept arbitrary JSON and cast it.

### Working-state shape

Store one bounded JSON object:

```ts
interface WorkingState {
  currentFocus: string
  activeThreads: Array<{
    name: string
    status: string
    nextStep?: string
    entities: string[]
    updatedAt: string
  }>
  recentDecisions: Array<{
    decision: string
    rationale?: string
    sourceMessageIds: string[]
  }>
  openLoops: Array<{
    item: string
    status: 'open' | 'blocked' | 'waiting'
    sourceMessageIds: string[]
  }>
  continuationHint: string
}
```

Enforce deterministic limits after parsing: 6 active threads, 8 decisions, 12 open loops, 12 entities per thread, and a 4,000-token rendered cap. Drop oldest/lowest-priority entries first.

### Observer

Run on a serialized background queue after either:

- `epoch.context_tokens - epoch.observed_at_context_tokens >= 8_000`, or
- an epoch is about to rotate.

Input:

- current working state
- unobserved user/Bond messages with stable IDs and timestamps
- compact activity/tool summaries for those turns

Output schema:

```ts
interface ObserverOutput {
  observations: Array<{
    content: string
    kind: 'preference' | 'correction' | 'decision' | 'fact' | 'project' | 'person' | 'failure' | 'open_loop'
    scope?: string
    importance: 1 | 2 | 3 | 4 | 5
    sourceMessageIds: string[]
  }>
  workingState: WorkingState
  coreCandidates: Array<{
    content: string
    reason: string
    sourceMessageIds: string[]
  }>
}
```

Observer rules in the prompt:

- write atomic, standalone observations
- preserve explicit user corrections and preferences
- record decisions with rationale when present
- do not infer personal facts from jokes/speculation
- do not store secrets or credential material
- do not copy giant code/tool outputs
- source IDs must come from the supplied messages only
- return no observation rather than inventing importance

Use the `fast` model through `runPiTextPrompt`; retry malformed output once with a repair prompt, then log and leave the range unprocessed for the next pass.

### Reflector

Run when unreflected active observations exceed roughly 16,000 tokens, or at epoch rotation if at least 10 meaningful observations are waiting.

Input active observations plus any existing reflections returned by FTS for the same scopes/entities. Output:

```ts
interface ReflectorOutput {
  upsert: Array<{
    id?: string
    content: string
    kind: string
    scope?: string
    supportObservationIds: string[]
  }>
  supersedeReflectionIds: string[]
  supersedeObservationIds: string[]
}
```

Reflections are durable conclusions/patterns, not session summaries. Validate every support ID. Apply the entire output transactionally. Never delete source observations; mark them superseded.

### Core `MEMORY.md`

Core memory contains only identity additions, stable Shaun preferences/corrections, important people, and durable operating rules. It is not required to represent every observation.

When the observer emits importance-5 core candidates, run a bounded updater with the current file and candidates. It may merge, replace, or omit duplicates, but output must remain under 8,000 characters. Write to a temp file and atomically rename. If validation fails, keep the old file. The Memory panel must also allow direct editing.

---

## Retrieval

### Search implementation

Create a safe FTS query builder:

1. Normalize Unicode and lowercase.
2. Extract quoted phrases plus alphanumeric tokens.
3. Remove a small local stopword list.
4. Escape FTS syntax; never interpolate raw user input directly.
5. Join remaining terms with `OR` for candidate retrieval.
6. Return at most 20 candidates from SQLite and rerank in TypeScript using:
   - FTS/BM25 rank
   - exact phrase/name overlap
   - recency
   - importance
   - active over superseded status

No embeddings. No QMD.

### Automatic pre-turn recall

Working state handles immediate pronouns and follow-ups. Automatic archive recall should run only when the message is substantive:

- at least 4 non-stopword tokens, **or**
- contains an explicit historical cue such as `remember`, `last time`, `earlier`, `we decided`, `you know`, `again`, or `before`.

Retrieve up to 8 candidates, keep at most 3 after reranking, require either two query-token overlaps or one exact quoted/proper-name overlap, and cap the injected result at 2,000 tokens. If nothing clears the gate, inject nothing.

This avoids the known failure mode where memory systems inject irrelevant garbage for messages like “fix it.”

### Agent tools

Register these as Bond-owned Pi tools via `extensionFactories` in `pi/runtime.ts`:

- `memory_search(query, kind?, scope?, limit?)`
- `history_search(query, before?, after?, limit?)`
- `memory_recall(id)`

`memory_recall` accepts an observation/reflection ID and returns its exact source messages. `history_search` returns concise excerpts plus message IDs/timestamps; it must not dump whole epochs.

The system prompt tells Bond to use these tools when the user asks for exact past wording, dates, paths, numbers, previous decisions, or details not present in working state. High-level continuity should not require a tool call every turn.

---

## UI cutover

### Main shell

In `src/renderer/App.vue`:

- remove `useSessions`
- delete all new/select/archive/unarchive/favorite/rename/title-generation handlers
- remove `⌘N`
- set `ViewShell` title to `Bond` and disable title editing
- keep the existing left `BondPanel` and collapse control, but render an intentionally empty placeholder surface; do not invent replacement features yet
- remove session context labels from approvals
- bind edit mode to the global setting
- keep Collections, Sense, Media, and Memory right-panel buttons

Delete these session-only components and their tests/usages:

- `SessionSidebar.vue`
- `SessionItem.vue`
- `SessionCard.vue`
- `SessionPreview.vue`
- `useSessions.ts`
- `generate-title.ts`
- `generate-debrief.ts`
- `debriefs.ts`
- old debrief UI components

Update `CLAUDE.md`, `AboutView.vue`, `DevComponents.vue`, and any field-manual copy so none describes chats, titles, archives, or per-session edit modes.

### Quick Chat

Quick Chat is another window onto the same Bond, not a temporary session.

- remove session creation/title generation from `src/main/quick-chat.ts`
- subscribe it to the global Bond stream
- sending from Quick Chat uses the same active epoch and writes to the same transcript
- when opening, query the daemon for the current maximum transcript `seq` and store it as `openSeq`; Quick Chat renders only messages with `seq > openSeq`, while the main window renders everything
- remove session-based window routing; route by window subscription and turn ID

### Memory panel

Replace debrief tabs with:

- **Core** — edit bounded `MEMORY.md`
- **Working** — current focus, threads, decisions, open loops
- **Memory** — search/filter observations and reflections
- **Source** — exact source messages for the selected record

Allow editing memory content, changing scope/kind, and marking a record deleted. Do not expose epochs here. A tiny epoch/debug inspector may be added later under developer settings, but it is not required for this implementation.

---

## File-by-file change map

### Delete/retire

- `src/daemon/sessions.ts` → replace with `transcript.ts`
- `src/daemon/generate-title.ts` and test
- `src/daemon/generate-debrief.ts`
- `src/daemon/debriefs.ts`
- `src/renderer/composables/useSessions.ts` and test
- session list/card/preview/sidebar components and tests
- debrief-specific Memory components and tests
- legacy `Session`, `SessionDebrief`, title/archive/favorite types and APIs

### Major edits

- `src/daemon/db.ts` — destructive schema-version cutover and new tables/FTS
- `src/daemon/server.ts` — global stream/query/queue; new transcript/memory/edit-mode RPCs; make `sense.search` capture-only
- `src/daemon/agent.ts` — remove debrief context; stable prompt + bounded context envelope
- `src/daemon/pi/runtime.ts` — epoch IDs, memory tools, context usage result, no legacy transcript
- `src/shared/stream.ts` — epoch/turn tags and assistant message ID
- `src/shared/protocol.ts` — update comments/types for global conversation
- `src/shared/client.ts` — remove sessions, add transcript/memory APIs
- `src/shared/session.ts` — split/rename to transcript-oriented types; retain image/collection/edit-mode types
- `src/preload/index.ts`, `src/renderer/env.d.ts`, `src/main/index.ts` — bridge new APIs
- `src/main/quick-chat.ts`, `src/main/window-router.ts` — global stream/turn routing
- `src/renderer/App.vue` — one Bond UI
- `src/renderer/composables/useChat.ts` — one transcript, cursor loading, upsert persistence
- `src/renderer/components/MemoryView.vue` — new memory browser/editor
- `CLAUDE.md` and `README.md` — current architecture and commands

### New

- `src/daemon/epochs.ts`
- `src/daemon/transcript.ts`
- `src/daemon/memory/*` listed above
- shared transcript/memory types, either in `src/shared/transcript.ts` and `src/shared/memory.ts` or cleanly split from the current `session.ts`

---

## Build sequence

Each phase should leave tests and typecheck green. Do not attempt the whole rewrite in one enormous diff; that is how innocent files end up in witness protection.

### Phase 1 — destructive schema + continuous transcript

1. Add schema reset/versioning.
2. Add epochs/turns/messages and transcript store.
3. Replace session RPC/client/preload types with global transcript APIs.
4. Refactor `useChat` to one transcript and upsert persistence.
5. Remove session UI/title/archive/favorite code.
6. Make Quick Chat use the same transcript.

**Acceptance:** Relaunching Bond shows one transcript titled Bond; send, streaming, tool activity, approval, cancel, daemon-owned queue, image attach, restart recovery, and Quick Chat all work without any session ID in renderer-facing APIs. Two near-simultaneous sends from Main and Quick Chat execute once each in FIFO order.

### Phase 2 — epoch lifecycle

1. Add epoch coordinator and internal Pi session IDs.
2. Return Pi `getContextUsage()` after turns.
3. Store epoch/turn usage.
4. Add soft rotation and new-epoch creation.
5. Keep a temporary last-12-message handoff until memory exists.

**Acceptance:** Lower the test threshold to a tiny value, send enough turns to force rotation, and verify the Pi session ID changes while the visible transcript remains continuous and the next response knows the recent thread.

### Phase 3 — working state + observations

1. Add memory store/types/parser.
2. Add serialized coordinator queue.
3. Implement observer prompt and validated output.
4. Persist observations/source links and working state.
5. Inject bounded working state/core memory into the context envelope.
6. Force observer flush before rotation.

**Acceptance:** A preference, decision, correction, and open loop survive a forced epoch rotation; every observation links to existing message IDs; malformed observer output does not corrupt state or block chat.

### Phase 4 — reflections + bounded core

1. Add reflector/consolidation.
2. Add supersession/status behavior.
3. Add bounded `MEMORY.md` updater for importance-5 candidates.
4. Add direct core editing RPC.

**Acceptance:** Repeated/contradictory observations consolidate without deleting evidence; explicit correction supersedes stale memory; `MEMORY.md` never exceeds 8,000 characters.

### Phase 5 — search, tools, and automatic recall

1. Add FTS maintenance and safe query parser.
2. Add memory/history/recall tools to Pi.
3. Add gated automatic pre-turn retrieval.
4. Add exact source recall.

**Acceptance:** Bond can recover an old exact phrase/path/decision after several forced rotations. “Fix it” injects no archive results. Search works on a clean packaged install with no external binary.

### Phase 6 — Memory UI and cleanup

1. Rebuild Memory panel.
2. Delete remaining debrief/session code and stale docs.
3. Search the repo for legacy product vocabulary and remove accidental references.
4. Restore normal rotation thresholds.

**Acceptance:** Core/working/search/source inspection and edits work; normal UI contains no new chat, archive, favorite, title, or session-management controls.

---

## Required tests

Follow the repo rule: every new logic file gets a sibling test, every modified logic path gets coverage, and `npm run test:run` is mandatory.

At minimum add tests for:

- destructive schema initialization and exactly one active epoch
- transcript upsert does not delete omitted messages
- cursor pagination has no duplicates/gaps
- activity JSON survives persistence and reload
- FTS rows update on message/memory edit and disappear on deletion
- FTS query escaping for quotes, punctuation, `OR`, `NEAR`, `*`, and empty input
- global send/cancel/subscription and approval replay
- context usage capture before Pi disposal
- soft-limit calculation across different context windows
- forced rotation waits for memory flush
- rotation fallback after observer failure
- observer parser rejects unknown/missing source IDs
- working-state deterministic caps
- reflector transactional supersession
- core-memory atomic write and size cap
- automatic recall skips trivial prompts and caps results/tokens
- memory tools return bounded source-linked results
- Quick Chat and main window receive the same turn
- `useChat` one-stream behavior, queue, activity, reconnect, and transcript paging

Final verification after every phase:

```bash
npm run test:run
npx tsc --noEmit
npm run build
```

After daemon/shared changes, use `bin/bond rebuild daemon` or restart the full app before manual testing; renderer hot reload does not reload the daemon.

---

## Final definition of done

- Shaun opens Bond and simply talks to Bond.
- There is no user-visible chat/session lifecycle.
- The transcript remains continuous across app restarts and many internal epoch rotations.
- Active Pi context normally stays around or below the 64k soft boundary rather than growing toward the provider limit.
- Current work survives rotation through bounded working state and recent handoff.
- Durable preferences, corrections, decisions, facts, people, projects, failures, and open loops are searchable.
- Bond can retrieve exact old wording and evidence by source message.
- `MEMORY.md` remains small and inspectable.
- Tool activity and approvals from `9bda2cc` still work.
- A clean packaged Bond install needs only Bond and a connected Pi-supported subscription—no QMD or other sidecar software.
