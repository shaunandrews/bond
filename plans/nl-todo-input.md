# Natural Language Todo Input

Replace the plain text input in the todo and project panels with a chat-style prompt that uses AI to create todos from natural language. Instead of typing a literal todo title, you describe what you need and Bond creates one (or more) structured todos from it.

## Why

The current add-todo experience is split awkwardly. `TodoView.vue` already calls `parseTodo` (which hits Haiku to extract title/notes/group), but `ProjectDetail.vue` just creates a raw todo with the literal text. Neither feels like talking to Bond. The input should feel like a mini chat — type "remind me to review the PR for sidebar sections and also update the changelog", and Bond creates two todos with appropriate titles, notes, and groups. One input, conversational, smart.

---

## Behavior

1. User types natural language into the input (e.g. "I need to refactor the auth module and write tests for it")
2. On submit, the input goes to an AI endpoint that returns one or more structured `ParsedTodo` objects
3. The client creates each todo and they appear in the list immediately
4. The AI is context-aware: it knows existing groups, can set groups, and can split multiple tasks from a single prompt

### What changes for the user
- The placeholder text becomes conversational: "What do you need to do?"
- The input can produce **multiple todos** from one prompt (current `parseTodo` always returns exactly one)
- Todos are auto-assigned to the current project when created from `ProjectDetail.vue`
- A brief "thinking" state shows while AI processes (already exists in `TodoView.vue` as the spinner)
- Shift+Enter submits literally (no AI) for when you just want to type a title fast

### Fallback chain
The input should **always produce a todo**. AI enrichment is best-effort.
1. AI returns parsed todos → use them
2. AI returns empty array → create one todo with the literal text as title
3. AI call fails (network, rate limit) → create one todo with literal text, show subtle inline warning "AI unavailable, created as-is" that fades after 3s
4. AI times out (8s) → same as failure
5. AI returns malformed JSON → same as failure, log error for debugging

The user never loses their input.

---

## Architecture Overview

The data flow is:

```
[Vue component] → useTodoPrompt composable
  → window.bond.parseFromPrompt(prompt, groups)     // preload bridge
    → ipcRenderer.invoke('todo:parseFromPrompt')     // IPC to main
      → client.parseFromPrompt()                     // BondClient RPC
        → daemon server.ts: 'todo.parseFromPrompt'   // daemon handler
          → parseTodosFromPrompt()                    // AI call (Haiku)
  ← ParsedTodo[]

  → window.bond.createTodo(title, notes, group, projectId)  // for each parsed todo
    → (existing IPC/RPC chain, unchanged)
  ← TodoItem
```

Parse and create are **separate calls**. The client controls creation, which enables undo, error recovery, and a future confirmation UI.

---

## Technical Details

### 1. New daemon function: `src/daemon/parse-todos-from-prompt.ts`

New file alongside `src/daemon/parse-todo.ts` (which stays unchanged — the CLI's `bond todo add` uses it via the `todo.parse` RPC).

Follow the exact pattern from `parse-todo.ts` for the AI call — use `query` from `@anthropic-ai/claude-agent-sdk`, model `'haiku'`, `maxTurns: 1`, `allowedTools: []`, and include the `CLAUDE_AGENT_SDK_CLIENT_APP` env override. Reference `parse-todo.ts` lines 19-43 for the shape.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

export interface ParsedTodo {
  title: string
  notes: string
  group: string
}

export async function parseTodosFromPrompt(
  prompt: string,
  existingGroups: string[] = []
): Promise<ParsedTodo[]> {
  const trimmed = prompt.trim()
  if (!trimmed) return []

  const groupsHint = existingGroups.length
    ? `Prefer existing groups if applicable: ${existingGroups.join(', ')}.`
    : ''

  try {
    const q = query({
      prompt: trimmed,
      options: {
        model: 'haiku',
        allowedTools: [],
        systemPrompt: `You create todos from natural language. The user describes what they need and you extract structured todos.

Rules:
- Return a JSON array: [{"title": "...", "notes": "...", "group": "..."}]
- Title: concise action item (max 80 chars). Start with a verb.
- Notes: additional context, details, or links. Keep verbatim from user input.
- Group: 1-2 word category (lowercase). ${groupsHint} Only set if clearly implied.
- Create multiple todos if the user describes multiple distinct tasks.
- Return at most 5 todos. If the input implies more, consolidate.
- If the input is not a task or action item, return an empty array [].
- Preserve the user's language.

Examples:
- "review the PR and leave comments" → 1 todo (same workflow)
- "review the PR for auth and also fix the typo on the landing page" → 2 todos (unrelated tasks)
- "I need to update the docs, write tests, and deploy to staging" → 3 todos (distinct actions)
- "set up CI/CD pipeline" → 1 todo (even though it involves multiple steps)
- "thanks" → [] (not a task)

Reply with ONLY the JSON array. No markdown fences, no explanation.`,
        maxTurns: 1,
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'bond-electron/0.1.0'
        } as Record<string, string | undefined>
      } as any
    })

    let resultText = ''
    for await (const message of q) {
      if (message.type === 'result' && message.subtype === 'success') {
        resultText = typeof message.result === 'string' ? message.result : ''
      }
    }

    return parseJsonArray(resultText, trimmed)
  } catch {
    // AI call failed — return empty so composable falls back to literal
    return []
  }
}

/** Parse the AI response into a ParsedTodo[]. Handles markdown fences, malformed JSON. */
function parseJsonArray(text: string, originalPrompt: string): ParsedTodo[] {
  if (!text) return []

  // Strip markdown code fences if present
  let cleaned = text.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '')

  try {
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []
    return parsed
      .slice(0, 5)
      .map(item => ({
        title: (String(item.title || '')).slice(0, 120),
        notes: (String(item.notes || '')).slice(0, 2000),
        group: (String(item.group || '')).slice(0, 30),
      }))
      .filter(t => t.title.length > 0)
  } catch {
    // Last resort: try to find a JSON array in the response
    const match = text.match(/\[[\s\S]*\]/)
    if (match) {
      try {
        const arr = JSON.parse(match[0])
        if (Array.isArray(arr)) {
          return arr
            .slice(0, 5)
            .map(item => ({
              title: (String(item.title || '')).slice(0, 120),
              notes: (String(item.notes || '')).slice(0, 2000),
              group: (String(item.group || '')).slice(0, 30),
            }))
            .filter(t => t.title.length > 0)
        }
      } catch { /* give up */ }
    }
    return []
  }
}
```

**Timeout:** The `query` call doesn't have a built-in timeout. Wrap it with `Promise.race` against a `setTimeout(reject, 8000)` so the composable's catch handler fires if Haiku is slow. Or use `AbortController` if the SDK supports it — check at implementation time.

### 2. Wire the RPC in `src/daemon/server.ts`

Add the import at the top (near line 93 where `parseTodoInput` is imported):
```ts
import { parseTodosFromPrompt } from './parse-todos-from-prompt'
```

Add the handler in the `// --- Todos ---` section (after the `todo.parse` case, around line 730):
```ts
case 'todo.parseFromPrompt': {
  const prompt = getStringParam(p, 'prompt')
  if (!prompt) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'prompt is required'))
  // existingGroups is an optional string array — use getParam, not getStringParam
  const existingGroups = (getParam(p, 'existingGroups') as string[] | undefined) ?? []
  const todos = await parseTodosFromPrompt(prompt, existingGroups)
  return JSON.stringify(makeResponse(id, { todos }))
}
```

**Important:** There is no `getArrayParam` helper in `server.ts`. Use `getParam(p, 'existingGroups') as string[]` — see how `todo.reorder` handles its `ids` array parameter at line 733 for the pattern.

Also add a comment above the existing `todo.parse` handler:
```ts
// Used by CLI (bond todo add). Renderer uses todo.parseFromPrompt instead.
case 'todo.parse': {
```

### 3. Client method in `src/shared/client.ts`

Add near the existing `parseTodo` method (around line 304):
```ts
async parseFromPrompt(prompt: string, existingGroups?: string[]): Promise<{ todos: Array<{ title: string; notes: string; group: string }> }> {
  return await this.call('todo.parseFromPrompt', { prompt, existingGroups }) as { todos: Array<{ title: string; notes: string; group: string }> }
}
```

### 4. Preload bridge in `src/preload/index.ts`

Add after the existing `parseTodo` line (line 54):
```ts
parseFromPrompt: (prompt: string, existingGroups?: string[]) =>
  ipcRenderer.invoke('todo:parseFromPrompt', prompt, existingGroups) as Promise<{ todos: Array<{ title: string; notes: string; group: string }> }>,
```

### 5. IPC handler in `src/main/index.ts`

Add after the existing `todo:parse` handler (line 581):
```ts
ipcMain.handle('todo:parseFromPrompt', (_e, prompt: string, existingGroups?: string[]) =>
  client.parseFromPrompt(prompt, existingGroups))
```

### 6. Type declaration in `src/renderer/env.d.ts`

Add after the existing `parseTodo` type (line 22):
```ts
parseFromPrompt: (prompt: string, existingGroups?: string[]) => Promise<{ todos: Array<{ title: string; notes: string; group: string }> }>
```

---

## Shared Composable: `src/renderer/composables/useTodoPrompt.ts`

The composables directory already exists at `src/renderer/composables/` alongside `useChat.ts`, `useProjects.ts`, etc.

```ts
import { ref, type Ref } from 'vue'
import type { TodoItem } from '../../shared/session'

interface UseTodoPromptOptions {
  projectId?: Ref<string | undefined>
  existingGroups?: Ref<string[]>
}

interface SubmitOptions {
  literal?: boolean   // skip AI, create one todo with literal text
}

interface SubmitResult {
  todos: TodoItem[]
  fallback: boolean   // true if AI was unavailable and we fell back to literal
}

export function useTodoPrompt(options?: UseTodoPromptOptions) {
  const text = ref('')
  const parsing = ref(false)

  async function submit(opts?: SubmitOptions): Promise<SubmitResult> {
    const raw = text.value.trim()
    if (!raw || parsing.value) return { todos: [], fallback: false }

    const pid = options?.projectId?.value

    // Literal mode (Shift+Enter) — skip AI, create one todo as-is
    if (opts?.literal) {
      const todo = await window.bond.createTodo(raw, '', '', pid)
      text.value = ''
      return { todos: [todo], fallback: false }
    }

    parsing.value = true
    try {
      const { todos: parsed } = await window.bond.parseFromPrompt(
        raw,
        options?.existingGroups?.value
      )

      // Fallback: AI returned nothing → use literal text
      if (!parsed.length) {
        const todo = await window.bond.createTodo(raw, '', '', pid)
        text.value = ''
        return { todos: [todo], fallback: true }
      }

      const created: TodoItem[] = []
      for (const p of parsed) {
        created.push(await window.bond.createTodo(p.title, p.notes, p.group, pid))
      }
      text.value = ''
      return { todos: created, fallback: false }
    } catch {
      // AI failed — fall back to literal creation
      const todo = await window.bond.createTodo(raw, '', '', pid)
      text.value = ''
      return { todos: [todo], fallback: true }
    } finally {
      parsing.value = false
    }
  }

  return { text, parsing, submit }
}
```

Note the `SubmitResult` type — it includes `fallback: boolean` so components can optionally show the "AI unavailable, created as-is" warning. And `todos: TodoItem[]` gives the caller every created ID for future batch undo.

---

## UI Changes

### `TodoView.vue` (`src/renderer/components/TodoView.vue`)

**What to remove:**
- The `newRaw` ref (line 16) — replaced by composable's `text`
- The `parsing` ref (line 17) — replaced by composable's `parsing`
- The entire `addTodo` function (lines 96-113) — replaced by composable's `submit`

**What to add:**

Import the composable:
```ts
import { useTodoPrompt } from '../composables/useTodoPrompt'
```

Set it up after the existing refs:
```ts
const { text: newRaw, parsing, submit: submitTodo } = useTodoPrompt({
  existingGroups: computed(() => [...groups.value])
})
```

New `addTodo` function:
```ts
async function addTodo(literal = false) {
  const result = await submitTodo({ literal })
  if (result.todos.length) {
    await refreshTodos()
    nextTick(() => {
      inputRef.value?.focus()
      autoResizeInput()
    })
  }
}
```

Update `onInputKeydown` (lines 202-208):
```ts
function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault()
    addTodo(true)  // literal mode — Shift+Enter
  } else if (e.key === 'Enter') {
    e.preventDefault()
    addTodo(false)  // AI mode — Enter
  }
}
```

**Important:** Check the Shift+Enter ordering — it must be checked **before** the plain Enter case, otherwise `e.shiftKey` is never reached. The current code (line 204) checks `!e.shiftKey` first, which means Shift+Enter currently inserts a newline. The new behavior repurposes Shift+Enter for literal mode, so **multi-line input is no longer supported** via keyboard. This is intentional — the input is a prompt, not a text editor. If this feels like a regression, add a note in the PR.

Update the placeholder in the template (line 298):
```html
placeholder="What do you need to do?"
```

Change the submit button icon from `PhPlus` to `PhArrowUp` (line 305). Add the import:
```ts
import { PhArrowUp, PhTrash, PhChatCircle, PhNotePencil, PhTag, PhSpinner, PhFolder } from '@phosphor-icons/vue'
```

### `ProjectDetail.vue` (`src/renderer/components/ProjectDetail.vue`)

**What to remove:**
- `newTodoText` ref (line 28)
- `todoInputRef` typed as `HTMLInputElement` (line 29) — retype as `HTMLTextAreaElement`
- The `addTodo` function (lines 82-89)

**What to add:**

Import the composable and `PhSpinner` and `PhArrowUp`:
```ts
import { useTodoPrompt } from '../composables/useTodoPrompt'
import { PhSpinner, PhArrowUp } from '@phosphor-icons/vue'
```

Note: `PhArrowUp` is not currently imported in this component. `PhSpinner` is also not imported — add both to the existing import statement from `@phosphor-icons/vue`.

Set up the composable:
```ts
const { text: newTodoText, parsing: todoParsing, submit: submitTodo } = useTodoPrompt({
  projectId: computed(() => props.project.id)
})
const todoInputRef = ref<HTMLTextAreaElement | null>(null)
```

New `addTodo`:
```ts
async function addTodo(literal = false) {
  const result = await submitTodo({ literal })
  if (result.todos.length) {
    await refreshTodos()
    nextTick(() => todoInputRef.value?.focus())
  }
}
```

Add the auto-resize function (doesn't exist in this component yet — copy from `TodoView.vue`):
```ts
function autoResizeInput() {
  const el = todoInputRef.value
  if (el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }
}
```

**Template change** — replace the `<input>` at lines 237-246 with:
```html
<div class="pd-todo-add">
  <textarea
    ref="todoInputRef"
    v-model="newTodoText"
    class="pd-form-input pd-todo-textarea"
    placeholder="What do you need to do?"
    rows="1"
    @keydown.enter.shift.prevent="addTodo(true)"
    @keydown.enter.exact.prevent="addTodo(false)"
    @input="autoResizeInput"
  />
  <BondButton variant="ghost" size="sm" icon :disabled="!newTodoText.trim() || todoParsing" @click="addTodo()">
    <PhSpinner v-if="todoParsing" :size="14" weight="bold" class="pd-todo-spinner" />
    <PhArrowUp v-else :size="14" weight="bold" />
  </BondButton>
</div>
```

**New styles** to add to the `<style scoped>` section:
```css
.pd-todo-textarea {
  resize: none;
  min-height: 2.25rem;
  max-height: 10rem;
  line-height: 1.5;
  overflow-y: auto;
  box-sizing: border-box;
  font-size: 0.8125rem;
  font-family: inherit;
}

@keyframes pd-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.pd-todo-spinner {
  animation: pd-spin 0.8s linear infinite;
}
```

### `TodoEmbed.vue` (`src/renderer/components/embeds/TodoEmbed.vue`)

**Phase 3 — evaluate after panels ship.** The embed's add input is a minimal inline field inside chat messages. For v1, it's fine to leave it as literal-only (`createTodo` directly). If you do wire it up:
- Use the composable but always pass the embed's resolved `projectId` and group as overrides
- Keep it as a single-line `<input>`, not a `<textarea>`
- The embed's `project` prop resolves to an ID via the `projectId` computed (line 20-26) — pass that

---

## What stays unchanged

- **`src/daemon/parse-todo.ts`** — existing file, untouched. Used by CLI via `todo.parse` RPC.
- **`src/daemon/todos.ts`** — existing CRUD functions. The composable calls `createTodo` per-item through the existing IPC chain.
- **`src/daemon/server.ts` `todo.parse` handler** — stays, add a comment only.
- **`src/shared/client.ts` `parseTodo` method** — stays alongside the new `parseFromPrompt`.
- **Database schema** — no changes. Todos table is unchanged.

---

## Implementation Order

### Phase 1: MVP (TodoView only)
1. **`src/daemon/parse-todos-from-prompt.ts`** — new file. AI prompt, JSON parsing with fallback, 8s timeout.
2. **Wire the RPC chain** — `server.ts` handler, `client.ts` method, `preload/index.ts` bridge, `main/index.ts` IPC handler, `env.d.ts` type.
3. **`src/renderer/composables/useTodoPrompt.ts`** — new composable.
4. **Update `TodoView.vue`** — consume composable, remove old `addTodo`/refs, update placeholder and icon.
5. **Manual test** — verify: single todo, multi-todo, non-todo input ("thanks" → literal fallback), kill network to test AI failure fallback, test Shift+Enter literal mode.

### Phase 2: ProjectDetail
6. **Update `ProjectDetail.vue`** — input→textarea, add auto-resize/spinner, consume composable with project ID, add new CSS.

### Phase 3: Embed (evaluate)
7. **Update `TodoEmbed.vue`** — only if the panels feel good. May skip.

### Phase 4: Polish (later)
8. Preview/confirmation UI for multi-todo creation
9. Batch undo (track created IDs from `SubmitResult`, offer "undo" action that deletes all)
10. Pass project context (name, goal) into the AI prompt for smarter group/notes suggestions
11. "AI unavailable" inline warning using `SubmitResult.fallback`

---

## Testing Checklist

- [ ] Type "buy milk" → creates 1 todo titled "buy milk" (or AI-enriched equivalent)
- [ ] Type "update docs, write tests, and deploy" → creates 3 separate todos
- [ ] Type "thanks" or "hello" → AI returns [] → falls back to literal todo
- [ ] Type something while network is down → falls back to literal, no error dialog
- [ ] Shift+Enter → creates literal todo immediately, no AI call
- [ ] In ProjectDetail: created todos have the correct `projectId`
- [ ] Existing group names appear in newly created todos when relevant
- [ ] AI response with markdown fences (```json) is parsed correctly
- [ ] Rapid double-submit (click button twice) doesn't create duplicates (the `parsing` guard prevents this)
- [ ] CLI `bond todo add "some text"` still works (uses old `todo.parse`, unchanged)

---

## Resolved Decisions

- **Feedback for multi-todo creation:** Seeing them appear in the list is sufficient for now. No toast needed — the list update is immediate and visible.
- **Undo:** Manual delete for now. The composable returns created IDs via `SubmitResult.todos`, so batch undo is straightforward to add later.
- **Send icon:** Use `PhArrowUp` (send arrow) in both panels. Reinforces "this is a prompt, not a form field." Keep `PhPlus` only in the embed inline input.
- **Multi-line input:** Shift+Enter repurposed for literal mode, so multi-line is no longer available via keyboard. This is intentional — the input is a prompt. If someone needs multi-line, they can resize the textarea by dragging (TodoView) or just let the auto-resize handle longer text.
