# Memory View — UI Plan

> **Revision 2** — Updated from codebase audit. Key changes from rev 1: fix IPC layer to use BondClient (not `daemonRpc`), add BondClient methods, fix type declaration file path (`env.d.ts` not `preload/index.d.ts`), use shared types from `sense.ts` instead of redefining, enrich `sense.threads` RPC to return objects (not bare strings), add test steps, fix `PhBrain` icon confirmation, add optimistic UI consistency, clarify debrief visibility under filters.
>
> Companion to `sense-memory.md`. That plan built the backend (debriefs, facts, threads, decisions, auto-injection, CLI, RPC). This plan covers the renderer UI.

## Overview

Add a Memory view to the right panel, accessible alongside Sense (screen timeline). Memory is where you see what Bond knows — pinned facts, open threads from past sessions, recent decisions, and session debriefs.

The screen awareness viewer answers **"what happened?"** — it's temporal, timeline-driven.
The memory view answers **"what do I know?"** — it's a knowledge base with timestamps, not a timeline with knowledge.

---

## Information Architecture

Four data types, each with different access patterns:

| Type | Description | Volume | Access Pattern |
|------|-------------|--------|---------------|
| **Pinned Facts** | Explicit "remember this" items | 5–50 | Always visible, scan-and-manage |
| **Open Threads** | Unresolved work carried across sessions | 2–10 | Act on (resume/resolve) |
| **Decisions** | Conclusions from past sessions | 10–50 | Reference, search |
| **Debriefs** | Auto-generated session summaries | 50–500+ | Browse, drill into |

**Primary layout:** Single scrollable view with sections, not tabs. The total volume is small enough to show everything at once. A segmented filter (All / Facts / Threads / Decisions) lets you focus when needed, but the default "All" view is the main experience.

**Search** spans all four types — the most common access pattern after scanning.

---

## Design

### Structure

```
┌─────────────────────────────────┐
│ ■ Memory          🔍   [filter] │  ← ViewShell toolbar
├─────────────────────────────────┤
│                                 │
│ PINNED FACTS (4)                │  ← Always first, highest signal
│ ┌─────────┐ ┌─────────┐        │
│ │ 📌 fact  │ │ 📌 fact  │        │  ← 2-col grid, compact cards
│ └─────────┘ └─────────┘        │
│ ┌─────────┐ ┌─────────┐        │
│ │ 📌 fact  │ │ 📌 fact  │        │
│ └─────────┘ └─────────┘        │
│                                 │
│ OPEN THREADS (2)                │
│ ┌───────────────────────────┐   │
│ │ Thread title              │   │  ← Full-width cards
│ │ From "Session name" · Apr 9│  │
│ │                  Resume → │   │
│ └───────────────────────────┘   │
│                                 │
│ RECENT DECISIONS                │
│ ┌───────────────────────────┐   │
│ │ • Decision text (Session) │   │  ← Compact list items
│ │ • Decision text (Session) │   │
│ └───────────────────────────┘   │
│                                 │
│ SESSION DEBRIEFS                │
│ ┌───────────────────────────┐   │
│ │ Session title    Apr 9    │   │  ← Clickable → detail view
│ │ Summary preview...        │   │
│ │ [tag] [tag]  3 decisions  │   │
│ └───────────────────────────┘   │
│                                 │
└─────────────────────────────────┘
```

### Components

#### `MemoryView.vue`
Top-level view component. Uses `ViewShell` (same pattern as `SensePanelView`). Manages filter state, search, and list/detail navigation.

**Props:** `insetStart?: boolean`

**State:**
- `filter`: `'all' | 'facts' | 'threads' | 'decisions'`
- `searchQuery`: string
- `activeDebriefId`: string | null (for detail drill-in)
- Data refs from `useMemory` composable

**Sections (in order):**
1. **Pinned Facts** — 2-column grid of fact cards. Each shows the fact text, pin date, and a dismiss (unpin) action on hover. Hidden when filter is `threads` or `decisions`.
2. **Open Threads** — Full-width cards. Each shows the thread text, source session title + date, and a "Resume →" action. Hidden when filter is `facts` or `decisions`.
3. **Recent Decisions** — Compact list. Each shows decision text and source session title in parentheses. Hidden when filter is `facts` or `threads`.
4. **Session Debriefs** — Card list. Each shows session title, date, summary preview (first line), topic tags, and a count badge for decisions/threads. Clicking opens detail view. Visible when filter is `all` or `decisions` (debriefs contain decisions, so showing them under the decisions filter aids discovery).

**Empty states:**
- No memory at all: "No memories yet. Bond builds memory as you archive sessions."
- No facts: "No pinned facts. Say 'remember that...' in a chat to pin one."
- No threads: "No open threads. Nice — everything's resolved."

#### `MemoryFactCard.vue`
Compact card for a pinned fact. 2-column grid layout.

```
┌──────────────────────┐
│ 📌 Fact text here,   │
│    wraps if needed   │
│ Pinned Apr 5    ✕    │  ← date left, unpin on hover right
└──────────────────────┘
```

**Props:** `fact: SenseFact` (from `shared/sense.ts`)
**Emits:** `forget: [id: string]`

Styling: `var(--color-surface)` background, `var(--color-border)` border, `var(--radius-md)` corners. Unpin button (`PhX` icon) appears on hover, `var(--color-muted)` → `var(--color-err)` on hover.

#### `MemoryThreadCard.vue`
Card for an open thread. Full-width.

```
┌────────────────────────────────┐
│ Thread text here               │
│ From "Session title" · Apr 9   │
│                      Resume →  │
└────────────────────────────────┘
```

**Props:** `thread: OpenThread` (from `shared/sense.ts` — see new type below)
**Emits:** `resume: [sessionId: string]`

"Resume →" creates a new session pre-loaded with context about the thread. Implementation: emit up to the parent, which calls the session creation flow with thread context injected. This is the killer interaction — picking up exactly where you left off.

**For v1:** Keep it simple. "Resume →" opens the original archived session in read-only mode (same as clicking an archived session in the sidebar). The user can then start a new session manually with the context fresh in mind. Full "auto-resume with context injection" is a v2 enhancement.

#### `MemoryDecisionItem.vue`
Minimal list row for a decision.

```
• Decision text here (Session Title)                     Apr 7
```

**Props:** `decision: DecisionWithContext` (from `shared/sense.ts` — see new type below)

Just text. No actions. Decisions are reference material, not actionable items.

#### `MemoryDebriefCard.vue`
Card for a session debrief. Clickable → opens detail.

```
┌────────────────────────────────────┐
│ Session Title                Apr 9 │
│ Summary text preview here...       │
│ [topic] [topic]   3 decisions      │
└────────────────────────────────────┘
```

**Props:** `debrief: SessionDebrief` (from `shared/sense.ts`)
**Emits:** `select: [id: string]`

Topic tags: small pills, styled like journal entry tags (`var(--color-tint)` bg, `var(--color-muted)` text). Decision/thread counts as small badges.

#### `MemoryDebriefDetail.vue`
Full detail view for a single debrief. Replaces the list (same pattern as SensePanelView's selected capture → detail).

```
┌────────────────────────────────────┐
│ ← Session Title                    │  ← Back button in toolbar
├────────────────────────────────────┤
│ Summary                            │
│ Full summary text here.            │
│                                    │
│ DECISIONS                          │
│ • Decision 1                       │
│ • Decision 2                       │
│                                    │
│ OPEN THREADS                       │
│ • Thread 1                         │
│ • Thread 2                         │
│                                    │
│ KEY FACTS                          │
│ • Fact 1                           │
│ • Fact 2                           │
│                                    │
│ ─────────────────────────────────  │
│ 12 messages · 45 min · Apr 9 4:30  │
└────────────────────────────────────┘
```

**Props:** `debrief: SessionDebrief` (from `shared/sense.ts`)
**Emits:** `back: []`, `pinFact: [fact: string]`

Key facts show a pin icon on hover — clicking promotes the fact to `sense_facts` (pinned). This bridges debrief-extracted facts into permanent memory.

---

### Shared Types (`src/shared/sense.ts`)

The backend types `SessionDebrief` and `SenseFact` already exist in `shared/sense.ts`. Two new types are needed for the enriched RPC responses:

```typescript
// Add to src/shared/sense.ts

/** Open thread enriched with source session context (returned by sense.threads RPC) */
export interface OpenThread {
  thread: string
  sessionId: string
  sessionTitle: string
  createdAt: string      // debrief creation date
}

/** Decision enriched with source session context (returned by sense.decisions RPC) */
export interface DecisionWithContext {
  decision: string
  sessionTitle: string
  createdAt: string
}
```

**Important:** The `useMemory` composable uses these shared types directly — no redefined interfaces.

---

### `useMemory.ts` Composable

Singleton state pattern (same as `useSense.ts`).

```typescript
import { ref, computed } from 'vue'
import type { SessionDebrief, SenseFact, OpenThread, DecisionWithContext } from '../../shared/sense'

// Singleton state
const facts = ref<SenseFact[]>([])
const threads = ref<OpenThread[]>([])
const decisions = ref<DecisionWithContext[]>([])
const debriefs = ref<SessionDebrief[]>([])
const loading = ref(false)
const searchQuery = ref('')
const searchResults = ref<SearchResult[]>([])

// Cross-channel search result — unified type for mixed results
interface SearchResult {
  channel: 'see' | 'chat' | 'fact'
  id: string
  text: string            // display text (fact text, summary, capture text_content)
  date: string            // ISO 8601
  sessionTitle?: string   // for chat channel
  appName?: string        // for see channel
}

async function loadMemory() {
  loading.value = true
  try {
    const [memData, threadData, decisionData] = await Promise.all([
      window.bond.senseMemory(),
      window.bond.senseThreads(),
      window.bond.senseDecisions(),
    ])
    facts.value = memData.facts
    debriefs.value = memData.debriefs
    threads.value = threadData
    decisions.value = decisionData
  } catch (err) {
    console.error('Failed to load memory:', err)
  } finally {
    loading.value = false
  }
}

async function forgetFact(id: string) {
  // Optimistic: remove immediately
  const backup = facts.value
  facts.value = facts.value.filter(f => f.id !== id)
  try {
    await window.bond.senseForget(id)
  } catch {
    // Rollback on failure
    facts.value = backup
  }
}

async function pinFact(fact: string, projectId?: string) {
  // Optimistic: also remove immediately, rollback on failure
  try {
    const created = await window.bond.senseRemember(fact, projectId)
    facts.value.unshift(created)
  } catch (err) {
    console.error('Failed to pin fact:', err)
  }
}

async function search(query: string) {
  searchQuery.value = query
  if (!query.trim()) { searchResults.value = []; return }
  const results = await window.bond.senseSearch(query, 50)
  // senseSearch returns mixed results — normalize to SearchResult
  searchResults.value = results.map(normalizeSearchResult)
}

function normalizeSearchResult(r: unknown): SearchResult {
  // The daemon's sense.search returns a union of capture/debrief/fact rows
  // each with a `channel` field — map to our SearchResult shape
  const obj = r as Record<string, unknown>
  return {
    channel: (obj.channel as 'see' | 'chat' | 'fact') ?? 'see',
    id: (obj.id as string) ?? '',
    text: (obj.summary as string) ?? (obj.fact as string) ?? (obj.text_content as string) ?? '',
    date: (obj.created_at as string) ?? (obj.captured_at as string) ?? '',
    sessionTitle: obj.session_title as string | undefined,
    appName: obj.app_name as string | undefined,
  }
}

async function getDebrief(id: string): Promise<SessionDebrief | null> {
  return window.bond.senseDebrief(id)
}

export function useMemory() {
  return {
    facts, threads, decisions, debriefs,
    loading, searchQuery, searchResults,
    loadMemory, forgetFact, pinFact, search, getDebrief,
  }
}
```

---

## Plumbing: Full IPC Pipeline

The daemon RPC methods exist (`sense.memory`, `sense.threads`, etc. in `server.ts`). To make them callable from the renderer, three layers need wiring: **BondClient → Main IPC handlers → Preload bridge → Type declarations.**

### Step 1: BondClient methods (`src/shared/client.ts`)

Add after the existing `senseStats()` method (line ~641):

```typescript
// --- Sense Memory ---

async senseMemory(limit?: number): Promise<{ debriefs: SessionDebrief[]; facts: SenseFact[] }> {
  return await this.call('sense.memory', { limit }) as { debriefs: SessionDebrief[]; facts: SenseFact[] }
}

async senseThreads(limit?: number, projectId?: string): Promise<OpenThread[]> {
  return await this.call('sense.threads', { limit, projectId }) as OpenThread[]
}

async senseDecisions(limit?: number, projectId?: string): Promise<DecisionWithContext[]> {
  return await this.call('sense.decisions', { limit, projectId }) as DecisionWithContext[]
}

async senseDebrief(id?: string, sessionId?: string): Promise<SessionDebrief | null> {
  return await this.call('sense.debrief', { id, sessionId }) as SessionDebrief | null
}

async senseRemember(fact: string, projectId?: string): Promise<SenseFact> {
  return await this.call('sense.remember', { fact, projectId }) as SenseFact
}

async senseFacts(projectId?: string): Promise<SenseFact[]> {
  return await this.call('sense.facts', { projectId }) as SenseFact[]
}

async senseForget(id: string): Promise<{ ok: boolean }> {
  return await this.call('sense.forget', { id }) as { ok: boolean }
}
```

**Import:** Add `SessionDebrief`, `SenseFact`, `OpenThread`, `DecisionWithContext` to the existing `sense.ts` imports in `client.ts`.

### Step 2: Main process IPC handlers (`src/main/index.ts`)

Add after the existing `sense:stats` handler (line ~696):

```typescript
// Sense Memory IPC handlers
ipcMain.handle('sense:memory', (_e, limit?: number) => client.senseMemory(limit))
ipcMain.handle('sense:threads', (_e, limit?: number, projectId?: string) => client.senseThreads(limit, projectId))
ipcMain.handle('sense:decisions', (_e, limit?: number, projectId?: string) => client.senseDecisions(limit, projectId))
ipcMain.handle('sense:debrief', (_e, id?: string, sessionId?: string) => client.senseDebrief(id, sessionId))
ipcMain.handle('sense:remember', (_e, fact: string, projectId?: string) => client.senseRemember(fact, projectId))
ipcMain.handle('sense:facts', (_e, projectId?: string) => client.senseFacts(projectId))
ipcMain.handle('sense:forget', (_e, id: string) => client.senseForget(id))
```

### Step 3: Preload bridge (`src/preload/index.ts`)

Add after the existing `senseStats` line (line ~267):

```typescript
// Sense Memory
senseMemory: (limit?: number) =>
  ipcRenderer.invoke('sense:memory', limit),
senseThreads: (limit?: number, projectId?: string) =>
  ipcRenderer.invoke('sense:threads', limit, projectId),
senseDecisions: (limit?: number, projectId?: string) =>
  ipcRenderer.invoke('sense:decisions', limit, projectId),
senseDebrief: (id?: string, sessionId?: string) =>
  ipcRenderer.invoke('sense:debrief', id, sessionId),
senseRemember: (fact: string, projectId?: string) =>
  ipcRenderer.invoke('sense:remember', fact, projectId),
senseFacts: (projectId?: string) =>
  ipcRenderer.invoke('sense:facts', projectId),
senseForget: (id: string) =>
  ipcRenderer.invoke('sense:forget', id),
```

### Step 4: Type declarations (`src/renderer/env.d.ts`)

Add to the `Window.bond` interface after the existing Sense section (line ~116):

```typescript
// Sense Memory
senseMemory: (limit?: number) => Promise<{ debriefs: import('../../shared/sense').SessionDebrief[]; facts: import('../../shared/sense').SenseFact[] }>
senseThreads: (limit?: number, projectId?: string) => Promise<import('../../shared/sense').OpenThread[]>
senseDecisions: (limit?: number, projectId?: string) => Promise<import('../../shared/sense').DecisionWithContext[]>
senseDebrief: (id?: string, sessionId?: string) => Promise<import('../../shared/sense').SessionDebrief | null>
senseRemember: (fact: string, projectId?: string) => Promise<import('../../shared/sense').SenseFact>
senseFacts: (projectId?: string) => Promise<import('../../shared/sense').SenseFact[]>
senseForget: (id: string) => Promise<{ ok: boolean }>
```

---

## Daemon Change: Enrich `sense.threads` RPC

The current `getRecentOpenThreads()` in `debriefs.ts` returns `string[]` — just thread text, no session context. The UI needs the source session title, session ID, and date to render `MemoryThreadCard` properly and to power the "Resume →" action.

### New function: `getRecentOpenThreadsEnriched()`

Add to `src/daemon/debriefs.ts`:

```typescript
export interface OpenThreadRow {
  thread: string
  sessionId: string
  sessionTitle: string
  createdAt: string
}

export function getRecentOpenThreadsEnriched(options?: {
  limit?: number
  projectId?: string
  excludeResolved?: boolean
}): OpenThreadRow[] {
  const db = getDb()
  const limit = options?.limit ?? 10
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()

  let sql = 'SELECT open_threads, decisions, session_id, session_title, created_at FROM sense_debriefs WHERE created_at >= ?'
  const params: (string | number)[] = [fiveDaysAgo]

  if (options?.projectId) {
    sql += ' AND project_id = ?'
    params.push(options.projectId)
  }

  sql += ' ORDER BY created_at DESC LIMIT 20'

  const rows = db.prepare(sql).all(...params) as {
    open_threads: string; decisions: string;
    session_id: string; session_title: string; created_at: string
  }[]

  const allDecisions: string[] = []
  const allThreadEntries: OpenThreadRow[] = []

  for (const row of rows) {
    allDecisions.push(...parseJsonArray(row.decisions))
    for (const thread of parseJsonArray(row.open_threads)) {
      allThreadEntries.push({
        thread,
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        createdAt: row.created_at,
      })
    }
  }

  // Deduplicate by normalized thread text
  const seen = new Set<string>()
  const unique: OpenThreadRow[] = []

  for (const entry of allThreadEntries) {
    const normalized = entry.thread.toLowerCase().trim()
    if (seen.has(normalized)) continue
    seen.add(normalized)

    if (options?.excludeResolved) {
      const resolved = allDecisions.some(d =>
        d.toLowerCase().includes(normalized.slice(0, 40))
      )
      if (resolved) continue
    }

    unique.push(entry)
    if (unique.length >= limit) break
  }

  return unique
}
```

### Update `server.ts` `sense.threads` handler

Change the handler (line ~1306) to use the enriched function:

```typescript
case 'sense.threads': {
  const limit = getNumberParam(p, 'limit') ?? 10
  const projectId = getStringParam(p, 'projectId')
  const threads = getRecentOpenThreadsEnriched({ limit, projectId: projectId ?? undefined, excludeResolved: true })
  return JSON.stringify(makeResponse(id, threads))
}
```

**Note:** The existing `getRecentOpenThreads()` (returns `string[]`) is still used by the auto-injection pipeline in `agent.ts`, which only needs plain text. Don't remove it.

---

## Panel Integration

### Right panel registration (`App.vue`)

Add `'memory'` to the `RightPanelContent` type (line 133):

```typescript
type RightPanelContent = 'todos' | 'projects' | 'browser' | 'operatives'
  | 'collections' | 'sense' | 'media' | 'memory'
```

Add a menu item in the overflow menu (next to Sense):

```html
<button :class="['overflow-menu-item', { active: rightPanelOpen && rightPanelContent === 'memory' }]"
  @click="openPanelFromOverflow('memory')">
  <PhBrain :size="16" />
  <span>Memory</span>
</button>
```

Update the overflow button active check (line 566) to include `'memory'`:

```typescript
:class="{ 'panel-toggle-active': rightPanelOpen && ['collections', 'sense', 'media', 'memory'].includes(rightPanelContent) }"
```

Render in the panel (after `SensePanelView`, line ~671):

```html
<MemoryView v-else-if="rightPanelContent === 'memory'" />
```

Update the panel min-size conditional (line 636) to explicitly include memory:

```typescript
:minSize="rightPanelContent === 'browser' ? 360 : ['sense', 'memory'].includes(rightPanelContent) ? 300 : 260"
```

**Icon:** `PhBrain` from Phosphor (confirmed present in `@phosphor-icons/vue`).

---

## Interactions

### Resume Thread

The most important interaction. When the user clicks "Resume →" on an open thread:

1. Create a new session
2. Inject the thread context as a system-level prompt prefix: "Continuing from a previous session: [thread text]. Original session: [session title]."
3. Navigate to the chat view with the new session active

This requires a new flow — `startSessionFromThread(thread)` — that creates the session and sets up the context. The composable emits up to App.vue which handles session creation.

**For v1:** Keep it simple. "Resume →" opens the original archived session in read-only mode (same as clicking an archived session in the sidebar). The user can then start a new session manually with the context fresh in mind. Full "auto-resume with context injection" is a v2 enhancement.

### Forget Fact

Hover over a fact card → X button appears → click → fact is deactivated (soft delete). No confirmation dialog — facts are cheap and the action is reversible via CLI (`bond sense remember` to re-add).

Optimistic UI: remove from the list immediately, call the RPC in the background. If it fails, re-add (rollback from backup array) with an error toast.

### Pin Fact from Debrief

In the debrief detail view, key facts show a pin icon on hover. Click → calls `senseRemember(fact)` → on success, fact appears in the pinned facts section. The icon changes to a filled pin to indicate it's already pinned.

**Not optimistic** — wait for the RPC to return the created `SenseFact` before adding it to the list. This avoids inserting a fact with a wrong ID/timestamp that would need replacing.

### Search

Search input in the toolbar (same pattern as SenseSearch). Searches across all memory types via the existing cross-channel `sense.search` RPC. Results replace the section layout with a flat list grouped by channel (`fact`, `chat`, `see`).

Each search result renders based on its `channel`:
- `fact`: Fact text + pin date
- `chat`: Debrief summary + session title + date
- `see`: Capture text excerpt + app name + time

---

## Relationship to Sense View

Memory and Sense (screen timeline) are **separate panel views**, not tabs within one view. They serve different purposes and have different layouts:

- **Sense** = temporal, visual (screenshots), timeline-driven
- **Memory** = knowledge, textual, section-driven

They share the `senseSearch` RPC for cross-channel search, but `useMemory` is its own composable with its own state.

Both appear in the overflow menu. They could eventually be unified under a single "Sense" panel with sub-tabs, but starting as separate views is cleaner — less complexity, easier to iterate on each independently.

---

## Implementation Order

| Step | What | Files | Effort |
|------|------|-------|--------|
| 1 | Shared types: `OpenThread`, `DecisionWithContext` | `shared/sense.ts` | Small |
| 2 | Enrich `sense.threads` RPC: add `getRecentOpenThreadsEnriched()` | `daemon/debriefs.ts`, `daemon/server.ts` | Small |
| 3 | BondClient methods for all 7 sense memory RPCs | `shared/client.ts` | Small |
| 4 | Main process IPC handlers | `main/index.ts` | Small |
| 5 | Preload bridge: expose 7 new methods | `preload/index.ts` | Small |
| 6 | Type declarations for `window.bond` | `renderer/env.d.ts` | Small |
| 7 | `useMemory.ts` composable | `renderer/composables/useMemory.ts` | Small |
| 8 | `useMemory.test.ts` | `renderer/composables/useMemory.test.ts` | Small |
| 9 | `MemoryView.vue` — list view with all sections | `renderer/components/MemoryView.vue` | Medium |
| 10 | Sub-components: FactCard, ThreadCard, DecisionItem, DebriefCard | `renderer/components/Memory*.vue` | Medium |
| 11 | `MemoryDebriefDetail.vue` — detail drill-in | `renderer/components/MemoryDebriefDetail.vue` | Small |
| 12 | Panel registration in App.vue | `App.vue` | Small |
| 13 | Search integration | `MemoryView.vue`, `useMemory.ts` | Small |
| 14 | Component tests for MemoryView + sub-components | `renderer/components/MemoryView.test.ts` | Medium |

**Build order:**
1. Steps 1–6: Wire up all plumbing. No UI yet, but data flows from daemon → BondClient → main IPC → preload → renderer. Verify with `window.bond.senseMemory()` in the dev console.
2. Steps 7–8: Composable + tests. State management works, can verify data loading.
3. Steps 9–11: Build the main view. This is the core — get the layout right, make sure all four sections render with real data.
4. Step 12: Panel hookup. Now it's usable.
5. Steps 13–14: Search + component tests. Polish.

**Estimated: 1–2 focused sessions.**

---

## Testing

Per CLAUDE.md rules: every new composable and component with logic gets tests.

### `useMemory.test.ts`
- Mock `window.bond` memory methods
- Test `loadMemory()` populates all four state arrays
- Test `forgetFact()` optimistic removal + rollback on error
- Test `pinFact()` waits for RPC before inserting
- Test `search()` clears results on empty query

### `MemoryView.test.ts`
- Test renders all four sections with mock data
- Test filter hides/shows correct sections
- Test clicking debrief card sets `activeDebriefId` and shows detail
- Test back from detail returns to list
- Test empty states render when data arrays are empty

### Sub-component tests (where there's logic)
- `MemoryFactCard`: emits `forget` on X click
- `MemoryThreadCard`: emits `resume` with correct sessionId
- `MemoryDebriefCard`: emits `select` on click

`MemoryDecisionItem` is pure presentational (no events, no logic) — skip tests.

---

## Open Questions

- **Unified Sense panel vs. separate Memory panel?** Starting separate. Could merge later with a tab bar (`Timeline | Memory`) in the Sense toolbar. Merging is additive — splitting later would be harder.

- **Real-time updates?** When a session is archived during use, should the memory view auto-refresh with the new debrief? For v1: no, manual refresh on panel open. For v2: listen for a `sense.debriefGenerated` event and append.

- **Thread resolution from UI?** Should threads have a "Mark resolved" action? The backend supports deactivation (debrief regeneration handles it). A simple dismiss button could set a flag. Defer — let the heuristic handle it first, add manual resolution if users ask for it.

- **Project filtering?** Memory could filter by project (show only facts/threads/decisions for the current project). The RPC methods already support `projectId`. Worth adding a project dropdown in the toolbar, but not in v1.
