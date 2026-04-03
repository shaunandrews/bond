# Journal — Shared Logbook Between User & Bond

A persistent journal where both the user and Bond can write entries. Think of it as a blog that lives inside Bond — a space for reflections, decision logs, project summaries, and freeform notes that persist across sessions.

---

## Why

Memory is silent structured data Bond references behind the scenes. Todos are actionable items. Projects track goals. But there's no good place for narrative — the kind of writing you'd actually read back. A journal fills that gap:

- **User entries**: thoughts, reflections, decisions, notes that don't fit elsewhere
- **Bond entries**: chat summaries, project digests, decision logs, periodic recaps
- **Shared timeline**: both authors in one feed, creating a persistent conversation across sessions

---

## Data Model

### Database table

```sql
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,              -- 'user' or 'bond'
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,                -- markdown content
  tags TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  project_id TEXT,                   -- optional link to a project
  session_id TEXT,                   -- optional link to the chat session that spawned it
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_journal_created ON journal_entries(created_at DESC);
CREATE INDEX idx_journal_project ON journal_entries(project_id);
CREATE INDEX idx_journal_author ON journal_entries(author);
```

### No file mirroring in v1

The DB is the sole source of truth. All other Bond features (todos, projects, sessions) are SQLite-only and that pattern works well. Markdown file export/sync (`~/.bond/journal/`) is deferred to a future version — it adds significant complexity (conflict resolution, startup scanning, slug generation, frontmatter parsing) for a portability benefit that isn't critical yet.

---

## Shared Type

Add to `src/shared/session.ts`:

```ts
export interface JournalEntry {
  id: string
  author: 'user' | 'bond'
  title: string
  body: string
  tags: string[]
  projectId?: string
  sessionId?: string
  pinned: boolean
  createdAt: string   // ISO 8601
  updatedAt: string   // ISO 8601
}
```

---

## Implementation Plan

### Phase 1: Database + Daemon CRUD

**Files to modify:**

1. **`src/daemon/db.ts`** — Add `migrateCreateJournalTable()` migration
2. **`src/shared/session.ts`** — Add `JournalEntry` type

**File to create:**

3. **`src/daemon/journal.ts`** — CRUD module following `todos.ts` / `projects.ts` pattern

```ts
// Internal row type
interface JournalEntryRow {
  id: string; author: string; title: string; body: string;
  tags: string; project_id: string | null; session_id: string | null;
  pinned: number; created_at: string; updated_at: string;
}

// Conversion
function rowToEntry(r: JournalEntryRow): JournalEntry

// CRUD (matches existing pattern: snake_case DB → camelCase API)
export function listEntries(opts?: {
  author?: string; projectId?: string; tag?: string;
  limit?: number; offset?: number;
}): JournalEntry[]

export function getEntry(id: string): JournalEntry | null

export function createEntry(params: {
  author: 'user' | 'bond'; title: string; body: string;
  tags?: string[]; projectId?: string; sessionId?: string;
}): JournalEntry

export function updateEntry(id: string, updates: Partial<Pick<JournalEntry,
  'title' | 'body' | 'tags' | 'pinned' | 'projectId'
>>): JournalEntry | null

export function deleteEntry(id: string): boolean

export function searchEntries(query: string): JournalEntry[]
// v1: LIKE-based search on title + body. FTS5 deferred to future.
```

### Phase 2: Server RPC + Client + IPC

**Files to modify:**

1. **`src/daemon/server.ts`** — Register `journal.*` RPC methods + `broadcastJournalChanged()`
2. **`src/shared/client.ts`** — Add `BondClient` methods + `journalChangeListeners`
3. **`src/main/index.ts`** — Add `ipcMain.handle('journal:*')` proxies
4. **`src/preload/index.ts`** — Expose `window.bond.journal*` methods

**RPC methods** (registered in server.ts switch statement):

| Method | Params | Returns |
|--------|--------|---------|
| `journal.list` | `{ author?, projectId?, tag?, limit?, offset? }` | `JournalEntry[]` |
| `journal.get` | `{ id }` | `JournalEntry \| null` |
| `journal.create` | `{ author, title, body, tags?, projectId?, sessionId? }` | `JournalEntry` |
| `journal.update` | `{ id, updates }` | `JournalEntry \| null` |
| `journal.delete` | `{ id }` | `boolean` |
| `journal.search` | `{ query }` | `JournalEntry[]` |

**Broadcast:** `broadcastJournalChanged()` — same pattern as `broadcastTodoChanged()` / `broadcastProjectsChanged()`. Fires after every create/update/delete.

**BondClient additions** (`src/shared/client.ts`):

```ts
type JournalChangeListener = () => void
private journalChangeListeners = new Set<JournalChangeListener>()

// In message handler, add: else if (msg.method === 'journal.changed') { ... }

async listJournalEntries(opts?): Promise<JournalEntry[]>
async getJournalEntry(id: string): Promise<JournalEntry | null>
async createJournalEntry(params): Promise<JournalEntry>
async updateJournalEntry(id: string, updates): Promise<JournalEntry | null>
async deleteJournalEntry(id: string): Promise<boolean>
async searchJournalEntries(query: string): Promise<JournalEntry[]>
onJournalChanged(fn: JournalChangeListener): () => void
```

**Main process IPC** (`src/main/index.ts`):

```ts
// Journal
ipcMain.handle('journal:list', (_e, opts?) => client.listJournalEntries(opts))
ipcMain.handle('journal:get', (_e, id: string) => client.getJournalEntry(id))
ipcMain.handle('journal:create', (_e, params) => client.createJournalEntry(params))
ipcMain.handle('journal:update', (_e, id: string, updates) => client.updateJournalEntry(id, updates))
ipcMain.handle('journal:delete', (_e, id: string) => client.deleteJournalEntry(id))
ipcMain.handle('journal:search', (_e, query: string) => client.searchJournalEntries(query))
```

**Preload bridge** (`src/preload/index.ts`):

```ts
listJournalEntries: (opts?) => ipcRenderer.invoke('journal:list', opts),
getJournalEntry: (id: string) => ipcRenderer.invoke('journal:get', id),
createJournalEntry: (params) => ipcRenderer.invoke('journal:create', params),
updateJournalEntry: (id: string, updates) => ipcRenderer.invoke('journal:update', id, updates),
deleteJournalEntry: (id: string) => ipcRenderer.invoke('journal:delete', id),
searchJournalEntries: (query: string) => ipcRenderer.invoke('journal:search', query),
onJournalChanged: (fn: () => void) => {
  const listener = () => fn()
  ipcRenderer.on('bond:journalChanged', listener)
  return () => ipcRenderer.removeListener('bond:journalChanged', listener)
},
```

**Main process forwarding** — add `journal.changed` notification forwarding to renderer (same pattern as `todo.changed` / `project.changed`):

```ts
client.onJournalChanged(() => {
  mainWindow?.webContents.send('bond:journalChanged')
})
```

### Phase 3: CLI

**File to create:** `src/cli/journal.ts`

Follows the exact pattern from `todo.ts` / `project.ts` — WebSocket connect, JSON-RPC `call()`, subcommand switch, ANSI color output.

```
bond journal                              List recent entries (default: last 20)
bond journal ls                           Same as above
bond journal ls --author bond             Filter by author
bond journal ls --project <name>          Filter by project
bond journal ls --tag <tag>               Filter by tag
bond journal show <id|number>             Show full entry (rendered markdown)
bond journal add <title>                  Create entry (opens $EDITOR or reads stdin)
bond journal add <title> --body "..."     Create with inline body
bond journal edit <id|number>             Edit entry (opens $EDITOR)
bond journal rm <id|number>               Delete entry
bond journal search <query>               Full-text search
bond journal pin <id|number>              Pin/unpin toggle
```

Entry lookup: by ID prefix, 1-based numeric index (from most recent listing), or title substring — same `findEntry()` pattern as `findTodo()`.

**Build config** — add to `package.json` `build:cli` script:

```diff
- "build:cli": "esbuild src/cli/todo.ts src/cli/media.ts src/cli/project.ts src/cli/screenshot.ts ...
+ "build:cli": "esbuild src/cli/todo.ts src/cli/media.ts src/cli/project.ts src/cli/screenshot.ts src/cli/journal.ts ...
```

**CLI entry point** — add to `bin/bond`:

```bash
cmd_journal() {
  _ensure_cli
  node "$PROJECT_DIR/out/cli/journal.js" "$@"
}

# In the case statement:
journal) shift; cmd_journal "$@" ;;
```

### Phase 4: Agent Integration

**`src/daemon/agent.ts`** — Add journal instructions to the system prompt:

```
JOURNAL:
Bond has a shared journal where both you and the user can write entries.
- Use `bond journal add "Title" --body "..."` to write an entry
- Use `bond journal ls` to list recent entries
- Use <bond-embed type="journal" /> to show entries in chat
- Write journal entries when the user asks, or when a chat produces a meaningful summary, decision, or milestone worth preserving
- Always set author to "bond" when you write entries
- Link entries to projects with --project when relevant
- Use tags to categorize entries: --tag design, --tag decision, etc.
```

### Phase 5: Renderer

**New files:**

1. **`src/renderer/composables/useJournal.ts`** — Composable matching `useProjects.ts` pattern
2. **`src/renderer/components/JournalView.vue`** — Main journal view (timeline + detail + composer)
3. **`src/renderer/components/JournalEmbed.vue`** — Chat embed for inline journal entries

**Modified files:**

4. **`src/renderer/composables/useAppView.ts`** — Add `'journal'` to `AppView` type
5. **`src/renderer/components/SessionSidebar.vue`** — Add Journal nav button (PhNotebook icon)
6. **`src/renderer/App.vue`** — Mount JournalView, pass journalCount to sidebar, handle `@journal` emit
7. **`src/renderer/components/ArtifactFrame.vue`** — Add `type="journal"` handling for embeds

**`useJournal.ts` structure:**

```ts
export interface JournalDeps {
  listJournalEntries: (opts?) => Promise<JournalEntry[]>
  getJournalEntry: (id: string) => Promise<JournalEntry | null>
  createJournalEntry: (params) => Promise<JournalEntry>
  updateJournalEntry: (id: string, updates) => Promise<JournalEntry | null>
  deleteJournalEntry: (id: string) => Promise<boolean>
  searchJournalEntries: (query: string) => Promise<JournalEntry[]>
  onJournalChanged: (fn: () => void) => () => void
}

export function useJournal(deps: JournalDeps = window.bond) {
  const entries = ref<JournalEntry[]>([])
  const activeEntryId = ref<string | null>(null)
  const loading = ref(false)

  const activeEntry = computed(...)
  const pinnedEntries = computed(...)

  async function load() { ... }
  async function create(params) { ... }
  async function update(id, updates) { ... }
  async function remove(id) { ... }
  async function search(query) { ... }
  function select(id: string | null) { ... }
  async function togglePin(id) { ... }

  return { entries, activeEntryId, activeEntry, pinnedEntries, loading,
           load, create, update, remove, search, select, togglePin }
}
```

**JournalView.vue design:**

A single view component that handles list, detail, and composition — no need for 3 separate components. Uses ViewShell wrapper.

- **List mode**: Timeline of entries, newest first. Each entry card shows author icon (user vs Bond), title, date, tags, body preview snippet. Pinned entries at the top. Search input in header. Filter by author/project/tag.
- **Detail mode**: Click an entry to see full rendered markdown (using MarkdownMessage), metadata, and edit/delete actions for user entries.
- **Compose mode**: "New entry" button opens an inline editor — title input, markdown body textarea, optional tag/project pickers. No separate composer component needed.

**Sidebar integration:**

```vue
<!-- In SessionSidebar.vue, inside .sidebar-nav -->
<button :class="['sidebar-nav-item', { active: activeView === 'journal' }]" @click="emit('journal')">
  <PhNotebook :size="16" weight="bold" />
  <BondText size="sm">Journal</BondText>
  <span v-if="journalCount > 0" class="media-count-badge">{{ journalCount }}</span>
</button>
```

**Embed syntax:**

```
<bond-embed type="journal" />                              — recent entries
<bond-embed type="journal" ids="id1,id2" />                — specific entries
<bond-embed type="journal" project="Bond" />               — entries linked to a project
<bond-embed type="journal" author="bond" />                — only Bond's entries
<bond-embed type="journal" search="connectors" />          — search results
<bond-embed type="journal" limit="5" />                    — cap results
```

### Phase 6: Tests

**Test files to create:**

1. **`src/daemon/journal.test.ts`** — Unit tests for CRUD operations, search, edge cases
2. **`src/renderer/composables/useJournal.test.ts`** — Composable tests using `withSetup` + mock `JournalDeps`

---

## Build Order

1. **Shared type + database migration** — `session.ts` type, `db.ts` migration
2. **Daemon CRUD** — `journal.ts` with all exports
3. **Server RPC + broadcast** — Wire up `journal.*` methods in `server.ts`
4. **Client + IPC + preload** — `client.ts`, `main/index.ts`, `preload/index.ts`
5. **CLI** — `cli/journal.ts` + `bin/bond` + `package.json` build script
6. **Agent prompt** — Update system prompt in `agent.ts`
7. **Renderer composable** — `useJournal.ts`
8. **Renderer view** — `JournalView.vue` + sidebar/app integration
9. **Renderer embed** — `JournalEmbed.vue` + `ArtifactFrame.vue` integration
10. **Tests** — Daemon + composable tests

Steps 1–6 can be built and tested entirely via CLI before any UI work. Steps 7–9 are the renderer buildout. Step 10 runs throughout but is listed last for clarity.

---

## Future Ideas (not v1)

- **Markdown file mirroring**: Sync entries to `~/.bond/journal/*.md` for portability and direct editing in external editors
- **FTS5 full-text search**: Replace LIKE-based search with SQLite FTS5 for better performance and ranking
- **Scheduled writing**: Bond writes daily/weekly summaries automatically (needs scheduler/cron)
- **Entry reactions**: User can react to Bond's entries, Bond can react to user's
- **Entry threads**: Replies/comments on entries, creating mini-conversations
- **Rich embeds in entries**: Entries can contain bond-embeds (todos, project cards) for richer recaps
- **Export**: Export journal as a static site, PDF, or structured archive
- **Templates**: Recurring entry templates (daily standup, weekly review, etc.)
- **Right panel mode**: Show journal in the right panel alongside chat (add `'journal'` to `RightPanelContent`)
