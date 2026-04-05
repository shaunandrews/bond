# Operatives — Background Claude Agents Managed by Bond

Bond can dispatch **operatives** — autonomous Claude agents that work on coding tasks in the background. Bond spawns them, tracks their status, streams their output, and reports back when they're done. Think of it as Bond deploying field agents: each operative gets a mission (prompt), a location (working directory), and works independently while Bond monitors from HQ.

---

## Why

Bond is good at conversation, research, and quick edits. But some tasks — building a feature, refactoring a module, writing a test suite — benefit from a dedicated agent that can run autonomously with full tool access. Rather than switching to a terminal and managing `claude` processes manually, Bond should be able to dispatch these directly and show their progress in the UI.

This also opens the door to parallelism: spin up three operatives on independent tasks and watch them all work simultaneously.

---

## How It Works (High Level)

1. Bond (the AI) decides to spawn an operative — either because the user asked, or because the task warrants it
2. Bond calls `bond operative spawn` (via Bash) or the daemon receives an `operative.spawn` RPC call
3. The daemon calls the Agent SDK's `query()` directly — each operative is a separate Claude Code subprocess with its own context window
4. The daemon converts SDK messages to `BondStreamChunk` events (same format as chat) and stores them in SQLite
5. The renderer shows operative status in the sidebar and operative detail in a panel
6. When the operative completes, the daemon notifies the spawning chat session and updates the UI

### Why Agent SDK, not `claude -p`

The plan uses `query()` from `@anthropic-ai/claude-agent-sdk` directly in the daemon — the same function `runBondQuery()` already wraps for chat. This is better than spawning `claude -p` as a child process because:

- **No cold start overhead** — `query()` reuses the daemon's Node.js process instead of spawning a new `claude` CLI process (~12s startup)
- **Native streaming** — SDK messages come as an async iterable of typed `SDKMessage` objects, no NDJSON parsing needed
- **No extra dependencies** — no `node-pty` (native module that needs Electron rebuilds), no PTY management
- **Consistent architecture** — operatives use the same `bondMessageToChunks()` pipeline as chat, producing identical `BondStreamChunk` events
- **Better control** — can set `canUseTool`, `permissionMode`, `systemPrompt`, tools, and model directly via the SDK options object

The trade-off is no raw terminal output for xterm.js replay. That's fine — the structured event view (tool calls, text, thinking) is the primary interface. Terminal view can be added later if needed.

---

## Data Model

### Database tables

```sql
CREATE TABLE IF NOT EXISTS operatives (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                    -- short descriptive name, e.g. "Build login page"
  prompt TEXT NOT NULL,                  -- the full prompt sent to the agent
  working_dir TEXT NOT NULL,             -- cwd for the agent process
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | completed | failed | cancelled
  session_id TEXT,                       -- Bond chat session that spawned this operative
  sdk_session_id TEXT,                   -- Agent SDK session ID (for future resume support)
  worktree TEXT,                         -- git worktree path if worktree isolation was used
  branch TEXT,                           -- git branch name in the worktree
  model TEXT,                            -- model used (optional override)
  result_summary TEXT,                   -- final text result (on completion)
  error_message TEXT,                    -- error details (on failure)
  exit_code INTEGER,                     -- 0 = success, non-zero = failure
  input_tokens INTEGER DEFAULT 0,        -- total input tokens consumed
  output_tokens INTEGER DEFAULT 0,       -- total output tokens consumed
  cost_usd REAL DEFAULT 0,              -- estimated cost in USD
  timeout_ms INTEGER,                    -- wall-clock timeout (null = no limit)
  max_budget_usd REAL,                  -- max spend cap (null = no limit)
  started_at TEXT,                       -- when the agent actually started running
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operatives_status ON operatives(status);
CREATE INDEX IF NOT EXISTS idx_operatives_session ON operatives(session_id);
```

```sql
CREATE TABLE IF NOT EXISTS operative_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operative_id TEXT NOT NULL REFERENCES operatives(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- matches BondStreamChunk.kind: assistant_text, thinking_text, assistant_tool, result, raw_error, system
  data TEXT NOT NULL DEFAULT '{}',       -- JSON-serialized BondStreamChunk (minus the kind field)
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operative_events_operative ON operative_events(operative_id, id);
```

Events use the same `BondStreamChunk` kinds as chat streaming. This means the renderer can reuse `MessageBubble`, `MarkdownMessage`, and `ActivityBar` components to display operative output without any adaptation.

### No raw terminal output table in v1

The original plan included an `operative_output` table for raw PTY bytes and xterm.js replay. This is removed from v1 because:
- Using the Agent SDK directly produces structured events, not raw terminal output
- The structured event view (tool calls, text, thinking) covers the primary use case
- Adding `node-pty` requires native module rebuilds for Electron — significant complexity
- Terminal replay can be added in a future version if needed

---

## Shared Types

New file: `src/shared/operative.ts`

```ts
export type OperativeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Operative {
  id: string
  name: string
  prompt: string
  workingDir: string
  status: OperativeStatus
  sessionId?: string             // Bond chat session that spawned this
  sdkSessionId?: string          // Agent SDK session ID
  worktree?: string              // git worktree path
  branch?: string                // git branch in worktree
  model?: string
  resultSummary?: string
  errorMessage?: string
  exitCode?: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  timeoutMs?: number
  maxBudgetUsd?: number
  startedAt?: string             // ISO 8601
  completedAt?: string
  createdAt: string
  updatedAt: string
}

export interface OperativeEvent {
  id: number
  operativeId: string
  kind: string                   // BondStreamChunk kind
  data: Record<string, unknown>  // remaining chunk fields
  createdAt: string
}

export interface SpawnOperativeOptions {
  name: string
  prompt: string
  workingDir: string
  sessionId?: string             // link to the Bond chat that triggered the spawn
  worktree?: boolean             // create a git worktree for isolation
  model?: string                 // model override (default: current Bond model)
  allowedTools?: string[]        // tool restrictions (default: all tools)
  maxBudgetUsd?: number          // per-operative spend cap
  timeoutMs?: number             // wall-clock timeout
  systemPromptSuffix?: string    // additional context appended to system prompt
}
```

---

## Daemon: Process Management

New file: `src/daemon/operatives.ts`

### Spawning

Each operative runs via the Agent SDK's `query()` function — the same one `runBondQuery()` uses for chat. Key differences from chat queries:

- **`permissionMode: 'dangerously_skip_permissions'`** — operatives run autonomously, no tool approvals
- **Dedicated `cwd`** — each operative gets its own working directory (or worktree)
- **No `canUseTool` callback** — all tools are auto-allowed
- **Separate `AbortController`** — for cancellation independent of chat sessions
- **Custom system prompt** — operative identity + task context

```ts
// Simplified — the actual implementation handles errors, cleanup, etc.
async function runOperative(op: Operative, options: SpawnOperativeOptions): Promise<void> {
  const ac = new AbortController()
  activeOperatives.set(op.id, ac)

  // Timeout enforcement
  let timer: NodeJS.Timeout | undefined
  if (op.timeoutMs) {
    timer = setTimeout(() => ac.abort(), op.timeoutMs)
  }

  const q = query({
    prompt: op.prompt,
    options: {
      abortController: ac,
      cwd: op.workingDir,
      model: options.model ?? currentModel,
      tools: options.allowedTools ?? ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch'],
      allowedTools: options.allowedTools ?? ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch'],
      permissionMode: 'dangerously_skip_permissions',
      systemPrompt: buildOperativeSystemPrompt(options),
      includePartialMessages: true,
      env: { ...process.env }
    }
  })

  for await (const message of q) {
    if (ac.signal.aborted) break
    for (const chunk of bondMessageToChunks(message)) {
      storeEvent(op.id, chunk)
      broadcastOperativeEvent(op.id, chunk)

      // Extract usage from result chunks
      if (chunk.kind === 'result') {
        updateUsage(op.id, message)
      }
    }
  }

  clearTimeout(timer)
  activeOperatives.delete(op.id)
}
```

### System Prompt

Operatives get a focused system prompt — much shorter than Bond's chat prompt:

```
You are an operative — a standalone coding agent deployed by Bond to work on a specific task.
Focus exclusively on the task described in your prompt.

Rules:
- Do not ask questions — make reasonable decisions and document your choices.
- If something is ambiguous, pick the most sensible path and note the assumption.
- When you finish, provide a clear summary of what you did, what files you changed, and any issues encountered.
- Stay focused. Don't explore unrelated code or make improvements beyond what was asked.
```

Bond (the AI) can append additional context via `systemPromptSuffix` when spawning — project conventions, relevant file paths, what NOT to touch, etc.

### Git Worktree Isolation

When `worktree: true` is passed:

1. Check that `workingDir` is a git repo
2. Create a uniquely-named branch: `operative/<id-short>` 
3. Run `git worktree add <path> -b <branch>` in the repo
4. Set the operative's `cwd` to the worktree path
5. Store the worktree path and branch name on the operative record

On completion/failure/cancellation:
- Do NOT auto-remove the worktree — the user may want to review changes, merge, or cherry-pick
- Store the branch name so Bond can reference it: "Your changes are on branch `operative/abc123`"

### Process Lifecycle

```
spawn → queued → running → completed | failed | cancelled
```

- **queued**: operative is created in DB, waiting for a slot (if at max concurrency)
- **running**: `query()` is active, events are streaming
- **completed**: query finished successfully, result captured
- **failed**: query errored or process died, error captured
- **cancelled**: user or Bond explicitly aborted (SIGTERM via `AbortController`)

### Concurrency Limit

Default maximum: **3 concurrent operatives**. Configurable via settings.

When an operative is spawned and the limit is reached, it enters `queued` status. When a running operative finishes, the daemon dequeues the next queued operative (FIFO).

### Safety Controls

- **`maxBudgetUsd`** — per-operative spend cap. Checked against accumulated `costUsd` after each result chunk. Aborts if exceeded.
- **`timeoutMs`** — wall-clock timeout. The `AbortController` fires after this duration.
- **Default budget** — if no `maxBudgetUsd` is specified, use a global default from settings (e.g. $5.00). Prevents runaway operatives.
- **Concurrent limit** — prevents spawning too many simultaneous agents.

### Cleanup

- **Daemon shutdown**: abort all running operatives via their `AbortController`s. The Agent SDK handles subprocess cleanup internally.
- **Daemon restart recovery**: on startup, mark any `status = 'running'` or `status = 'queued'` operatives as `failed` with message "Process lost — daemon restarted". The SDK subprocess is gone, so there's nothing to resume.
- **Worktree cleanup**: worktrees are NOT auto-cleaned. The user can manually remove them or Bond can clean up on request.

---

## Daemon: RPC Methods

Add to `server.ts`'s `handleRequest` switch. Follow the same pattern as `todo.*`, `project.*`, etc.

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `operative.spawn` | `SpawnOperativeOptions` | `Operative` | Spawn a new operative (may queue if at limit) |
| `operative.list` | `{ status?, sessionId? }` | `Operative[]` | List operatives with optional filters |
| `operative.get` | `{ id }` | `Operative` | Get operative details |
| `operative.events` | `{ id, afterId?, limit? }` | `OperativeEvent[]` | Get events (paginated, default limit 200) |
| `operative.cancel` | `{ id }` | `{ ok: true }` | Cancel a running/queued operative |
| `operative.remove` | `{ id }` | `{ ok: true }` | Delete an operative and its events (CASCADE) |
| `operative.clear` | `{ status? }` | `{ deleted: number }` | Bulk delete by status (e.g. all completed) |

### WebSocket Notifications

Push to all connected clients via `broadcastOperativeChanged()`:

| Notification | Payload | When |
|-------------|---------|------|
| `operative.changed` | `{}` | Any operative created, updated, or deleted |
| `operative.event` | `{ operativeId, event }` | New event from a running operative |

Using a single `operative.changed` notification (rather than granular started/completed/etc.) follows the same pattern as `todo.changed` and `project.changed`. The renderer re-fetches the full list on change.

The `operative.event` notification is separate because it's high-frequency during active runs and needs to stream to the detail panel without triggering a full list refresh.

---

## Integration Stack

Every Bond entity follows the same 5-layer integration pattern. Operatives must too:

### 1. Daemon CRUD (`src/daemon/operatives.ts`)
SQLite operations + process management. Exports: `spawnOperative()`, `listOperatives()`, `getOperative()`, `getOperativeEvents()`, `cancelOperative()`, `removeOperative()`, `clearOperatives()`.

### 2. Server RPC (`src/daemon/server.ts`)
Import from operatives.ts, add `case 'operative.*'` handlers, add `broadcastOperativeChanged()` and `broadcastOperativeEvent()` functions.

### 3. Client methods (`src/shared/client.ts`)
Add to `BondClient`:
```ts
// --- Operatives ---
async spawnOperative(opts: SpawnOperativeOptions): Promise<Operative>
async listOperatives(filters?: { status?: string; sessionId?: string }): Promise<Operative[]>
async getOperative(id: string): Promise<Operative | null>
async getOperativeEvents(id: string, afterId?: number, limit?: number): Promise<OperativeEvent[]>
async cancelOperative(id: string): Promise<{ ok: boolean }>
async removeOperative(id: string): Promise<{ ok: boolean }>
async clearOperatives(status?: string): Promise<{ deleted: number }>

onOperativeChanged(fn: () => void): () => void
onOperativeEvent(fn: (payload: { operativeId: string; event: OperativeEvent }) => void): () => void
```

Add listener sets: `operativeChangeListeners`, `operativeEventListeners`. Handle `operative.changed` and `operative.event` notifications in the message handler.

### 4. Main process IPC (`src/main/index.ts`)
Add `ipcMain.handle` proxies:
```ts
ipcMain.handle('operative:list', (_e, filters?) => client.listOperatives(filters))
ipcMain.handle('operative:get', (_e, id: string) => client.getOperative(id))
ipcMain.handle('operative:spawn', (_e, opts) => client.spawnOperative(opts))
ipcMain.handle('operative:events', (_e, id, afterId?, limit?) => client.getOperativeEvents(id, afterId, limit))
ipcMain.handle('operative:cancel', (_e, id: string) => client.cancelOperative(id))
ipcMain.handle('operative:remove', (_e, id: string) => client.removeOperative(id))
ipcMain.handle('operative:clear', (_e, status?: string) => client.clearOperatives(status))
```

Relay notifications to renderer:
```ts
client.onOperativeChanged(() => {
  mainWindow?.webContents.send('bond:operativeChanged')
})
client.onOperativeEvent((payload) => {
  mainWindow?.webContents.send('bond:operativeEvent', payload)
})
```

### 5. Preload bridge (`src/preload/index.ts`)
Add to `window.bond`:
```ts
listOperatives: (filters?) => ipcRenderer.invoke('operative:list', filters),
getOperative: (id: string) => ipcRenderer.invoke('operative:get', id),
spawnOperative: (opts) => ipcRenderer.invoke('operative:spawn', opts),
getOperativeEvents: (id, afterId?, limit?) => ipcRenderer.invoke('operative:events', id, afterId, limit),
cancelOperative: (id: string) => ipcRenderer.invoke('operative:cancel', id),
removeOperative: (id: string) => ipcRenderer.invoke('operative:remove', id),
clearOperatives: (status?: string) => ipcRenderer.invoke('operative:clear', status),
onOperativeChanged: (fn) => {
  const listener = () => fn()
  ipcRenderer.on('bond:operativeChanged', listener)
  return () => ipcRenderer.removeListener('bond:operativeChanged', listener)
},
onOperativeEvent: (fn) => {
  const listener = (_e, payload) => fn(payload)
  ipcRenderer.on('bond:operativeEvent', listener)
  return () => ipcRenderer.removeListener('bond:operativeEvent', listener)
},
```

---

## CLI: `bond operative`

New file: `src/cli/operative.ts`

Connects to daemon via WebSocket and calls RPC methods. Follows the same pattern as `src/cli/todo.ts`, `src/cli/project.ts`, etc.

```
bond operative                              List all operatives
bond operative ls                           Same as above
bond operative ls --running                 Filter by status
bond operative spawn "<prompt>"             Spawn with prompt (cwd = current directory)
bond operative spawn "<prompt>" --dir <d>   Spawn with explicit working directory
bond operative spawn "<prompt>" -w          Spawn with git worktree isolation
bond operative spawn "<prompt>" --name <n>  Spawn with a display name
bond operative spawn "<prompt>" --model <m> Spawn with model override
bond operative spawn "<prompt>" --budget <$> Per-operative spend cap
bond operative show <id|number>             Show operative details + recent events
bond operative logs <id|number>             Stream events (tail -f style via WebSocket)
bond operative cancel <id|number>           Cancel a running operative
bond operative rm <id|number>               Delete an operative
bond operative clear                        Delete all completed/failed operatives
```

Register in `bin/bond`:
```bash
cmd_operative() {
  _ensure_cli
  node "$PROJECT_DIR/out/cli/operative.js" "$@"
}
```

Add `operative` to the `_ensure_cli` file list and the main case statement.

---

## Renderer: Composable

### `useOperatives` (`src/renderer/composables/useOperatives.ts`)

Follows the pattern of `useProjects`, `useSessions`, etc.

```ts
export function useOperatives() {
  const operatives = ref<Operative[]>([])
  const activeOperativeId = ref<string | null>(null)
  const loading = ref(false)

  // Computed
  const activeOperative = computed(...)
  const runningOperatives = computed(() => operatives.value.filter(o => o.status === 'running'))
  const runningCount = computed(() => runningOperatives.value.length)

  // Methods
  async function load() { ... }        // window.bond.listOperatives()
  async function spawn(opts) { ... }   // window.bond.spawnOperative(opts)
  async function cancel(id) { ... }    // window.bond.cancelOperative(id)
  async function remove(id) { ... }    // window.bond.removeOperative(id)
  function select(id) { ... }

  // Listener — re-fetch on change notification
  let unsub: (() => void) | null = null
  onMounted(() => {
    load()
    unsub = window.bond.onOperativeChanged(() => load())
  })
  onUnmounted(() => unsub?.())

  return { operatives, activeOperativeId, activeOperative, runningOperatives, runningCount, loading, load, spawn, cancel, remove, select }
}
```

### `useOperativeEvents` (`src/renderer/composables/useOperativeEvents.ts`)

Separate composable for streaming events for a specific operative:

```ts
export function useOperativeEvents(operativeId: Ref<string | null>) {
  const events = ref<OperativeEvent[]>([])

  // Load initial events, then append from operative.event notifications
  // Pagination via afterId for initial load
  // Real-time append from window.bond.onOperativeEvent()

  return { events }
}
```

---

## Renderer: Views & Components

### AppView update

Add `'operatives'` to the `AppView` union type in `useAppView.ts`:

```ts
export type AppView = 'chat' | 'projects' | 'media' | 'collections' | 'journal' | 'sense' | 'operatives'
```

### Sidebar integration

Add an "Operatives" entry in `SessionSidebar.vue` alongside Projects, Collections, Journal, Media. Use `PhRobot` or `PhUsersThree` Phosphor icon. Badge with `runningCount` when > 0.

### `OperativesView.vue`

Main content area view for operatives (shown when `activeView === 'operatives'`). Lists operatives, most recent first.

Each item shows:
- **Name** (or truncated prompt if no name)
- **Status indicator**: pulsing dot for running/queued, green check for completed, red × for failed, grey dash for cancelled
- **Duration**: elapsed time (running) or total duration (completed)
- **Cost**: `$0.42` (from costUsd)
- **Working directory** (abbreviated path)

Actions:
- Click → select operative, show detail in right panel
- Menu → Cancel / Remove

Filter: All | Running | Completed

### `OperativeDetail.vue`

Shown in the right panel (like `ProjectPanelView` or `BrowserView`) when an operative is selected.

**Header**: name, status badge, duration, working directory, cost, model

**Activity feed**: chronological list of events rendered using the same components as chat:
- `assistant_tool` events → tool call rows (icon + file path), like `ActivityBar.vue`
- `assistant_text` events → accumulated into text blocks, rendered with `MarkdownMessage`
- `thinking_text` events → collapsible thinking blocks
- `result` events → completion summary
- `raw_error` events → error display

**Footer actions**: Cancel (if running), Remove, Copy result

The activity feed streams in real-time for running operatives via `useOperativeEvents`.

### Panel layout

Operatives detail uses the existing `BondPanelGroup` system. When an operative is selected, the right panel shows `OperativeDetail.vue` — same slot that `ProjectPanelView`, `TodoView`, and `BrowserView` use.

---

## Chat Integration

### Completion message injection

When an operative completes or fails, inject a message into the Bond chat session that spawned it. This uses the existing system message mechanism.

**Success:**
```
Operative completed: **Build login page** — 12 files changed, 3m 42s, $0.42
```

**Failure:**
```
Operative failed: **Build login page** — exit code 1, 1m 15s
```

The daemon sends this by:
1. Looking up the operative's `sessionId`
2. Broadcasting a `system` chunk to that session's subscribers:
   ```ts
   broadcastChunk(op.sessionId, {
     kind: 'system',
     subtype: 'operative_completed',
     text: `Operative completed: **${op.name}** — ${fileCount} files changed, ${duration}, $${op.costUsd.toFixed(2)}`
   })
   ```

This appears in chat as a system message. Bond (the AI) sees it in context and can respond.

### Bond's system prompt additions

Add to the system prompt in `agent.ts`:

```
OPERATIVES — BACKGROUND AGENTS:
Bond can dispatch operatives — autonomous Claude agents that work on coding tasks in the background.
Each operative gets its own context window and works independently while Bond monitors progress.

Spawn via CLI:
- `bond operative spawn "<prompt>" --name "<name>" --dir <working-dir>` — spawn an operative
- `bond operative spawn "<prompt>" -w` — spawn with git worktree isolation
- `bond operative spawn "<prompt>" --budget 5` — set a $5 spend cap
- `bond operative ls` — list all operatives
- `bond operative ls --running` — list running operatives
- `bond operative show <id|number>` — show details + recent events
- `bond operative logs <id|number>` — stream live events
- `bond operative cancel <id|number>` — cancel a running operative

When to spawn operatives:
- User explicitly asks ("spin up an operative to refactor the auth module")
- Task is substantial (multi-file changes, test writing, full feature build)
- Parallelism is beneficial ("I'll spawn two operatives — one for frontend, one for API")

When spawning, provide rich context in the prompt:
- Project conventions, relevant CLAUDE.md rules
- Specific file paths and structure
- Requirements, constraints, and what NOT to touch
- If other operatives are running, warn about file conflicts

For git repos, use -w (worktree) to isolate changes when multiple operatives work on the same repo.
Operatives run autonomously — they don't ask for permission. Be specific in prompts to avoid unwanted changes.
```

---

## v1 Scope

**In:**
- Spawn operatives via RPC and CLI
- List, view, cancel, remove operatives
- Structured event view (tool calls, text, thinking) — reuses existing chat components
- Sidebar entry with running count badge
- Operative detail in right panel
- Completion/failure notification injected into spawning chat session
- SQLite persistence across daemon/renderer restarts
- Git worktree isolation
- `bond operative` CLI commands
- Concurrency limit (default: 3)
- Per-operative budget cap
- Wall-clock timeout
- Usage tracking (tokens + cost)
- System prompt additions so Bond knows how to spawn operatives
- Full integration stack (daemon → server → client → IPC → preload → composable)

**Out (future):**
- Terminal view with xterm.js (raw PTY output, replay)
- Interactive terminal (send input to running operative)
- Resume failed/cancelled operatives (via SDK session resume)
- Follow-up prompts to running operatives
- Operative-to-operative communication
- Operative templates (pre-configured prompts for common tasks, stored in `~/.bond/operatives/`)
- Auto-worktree decisions (Bond deciding when to use worktrees)
- Scheduling/triggering (cron, file watch, git hooks)
- `<bond-embed type="operatives" />` for showing operative status in chat

---

## Implementation Order

### Phase 1: Shared Types + Database
1. Create `src/shared/operative.ts` — types
2. Add migration in `src/daemon/db.ts` — `migrateCreateOperativesTable()`
3. Add `operatives` and `operative_events` tables

### Phase 2: Daemon Core
4. Create `src/daemon/operatives.ts` — CRUD, spawn, cancel, event storage, concurrency queue
5. Add `operative.*` RPC cases to `src/daemon/server.ts` + broadcast functions
6. Add WebSocket notification handling for `operative.changed` and `operative.event`
7. Add daemon startup recovery (mark orphaned running operatives as failed)
8. Add operative section to system prompt in `src/daemon/agent.ts`

### Phase 3: Client + IPC + Preload
9. Add operative methods + listeners to `src/shared/client.ts`
10. Add `ipcMain.handle` proxies + notification relays in `src/main/index.ts`
11. Add `window.bond` operative API in `src/preload/index.ts`

### Phase 4: CLI
12. Create `src/cli/operative.ts` — full CLI
13. Register `cmd_operative` in `bin/bond`
14. Test: spawn from terminal, list, view logs, cancel

### Phase 5: Renderer — List View
15. Create `src/renderer/composables/useOperatives.ts`
16. Create `src/renderer/composables/useOperativeEvents.ts`
17. Add `'operatives'` to `AppView` union
18. Add operative nav item to `SessionSidebar.vue` with running count badge
19. Create `OperativesView.vue` — list view with status, duration, cost

### Phase 6: Renderer — Detail Panel
20. Create `OperativeDetail.vue` — activity feed panel
21. Wire into right panel slot in `App.vue`
22. Stream live events for running operatives

### Phase 7: Chat Integration
23. Inject completion/failure messages into spawning chat session
24. Test end-to-end: Bond spawns operative, watches progress, reports back

### Phase 8: Polish
25. Error handling edge cases (daemon restart recovery, budget exceeded, timeout)
26. Empty states, loading states
27. Bulk operations (clear completed)
28. Update CLAUDE.md architecture docs and component catalog
