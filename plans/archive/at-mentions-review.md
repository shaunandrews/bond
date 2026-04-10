# @Mentions Plan — Review

## What the Plan Gets Right

- The general UX concept is sound: `@` trigger, popup menu, token insertion, context injection.
- Following the skill autocomplete pattern is the correct approach — the plan identifies the right model to copy.
- The `@[Name](project:uuid)` token format is reasonable for carrying the project ID through the textarea.
- Per-message context injection (vs session-level) is a good distinction.
- The coexistence model with session-linked projects makes sense.
- The edge cases section is thorough (multiple mentions, unknown project, deleted project).
- Implementation ordering is sensible — input UX first, then functional core, then polish.

## Incorrect Assumptions and Mistakes

### 1. The emit('submit') signature is wrong

The plan says:

> Pass them alongside the message: `emit('submit', text, images, mentionedProjectIds)`

**Actual emit signature** (`ChatInput.vue:71-73`):
```ts
const emit = defineEmits<{
  submit: [text: string, images: AttachedImage[]]
}>()
```

Adding a third argument changes the typed emit interface, which also requires updating:
- `App.vue:248` — `handleSubmit(text: string, images: AttachedImage[])`
- `QuickChat.vue:74` — `handleSend(text: string)` (only takes text — ignores images entirely)
- `DevComponents.vue:554,558` — test harness `@submit="() => {}"` callbacks

The plan doesn't mention `QuickChat.vue` at all, which is a second consumer of `ChatInput`.

### 2. There is no `chat.send` handler — the RPC method is `bond.send`

The plan references `chat.send` handler in the daemon. The actual method name is `bond.send` (`server.ts:359`). This is cosmetic but indicates the author didn't read the actual server code.

### 3. Project context injection doesn't exist yet — the plan assumes it does

The plan says:

> Append a context block to the system prompt, similar to how session-linked project context works (see `project-context.md`)

But `project-context.md` is itself an unimplemented plan. The `runBondQuery` function in `agent.ts` has **zero project awareness**. It never calls `getSession()` or `getProject()`. The session's `projectId` is stored in the DB but completely ignored at query time. The system prompt has instructions about projects but never receives actual project data.

This means the plan is building on top of a feature that doesn't exist. Either:
- Project context injection needs to be implemented first (per `project-context.md`)
- Or this plan needs to include that work as a prerequisite

### 4. The daemon data flow is wrong

The plan says mentioned project IDs flow like:

> `ChatInput` → `emit('submit')` → `useChat.submit()` → `deps.send()` → `bond.send` handler → `runBondQuery`

But the actual `send` function signature in the client (`shared/client.ts:184`):
```ts
async send(text: string, sessionId?: string, images?: AttachedImage[]): Promise<...>
```

And the preload bridge (`preload/index.ts:7`):
```ts
send: (text: string, sessionId?: string, images?: AttachedImage[]) => ipcRenderer.invoke('bond:send', text, sessionId, images)
```

And `useChat.submit()` calls it as (`useChat.ts:615`):
```ts
const res = await deps.send(trimmed, sid, images)
```

There's no slot for `mentionedProjectIds` anywhere in this chain. To pass mention IDs through, you'd need to modify:
1. `ChatDeps.send` interface (`useChat.ts:33`)
2. `useChat.submit()` method (`useChat.ts:582`)
3. `BondClient.send()` (`shared/client.ts:184`)
4. The preload bridge (`preload/index.ts:7`)
5. The IPC handler in `main/index.ts`
6. The `bond.send` RPC handler in `server.ts:359-420`
7. The `runBondQuery` options interface (`agent.ts:200-210`)

The plan only mentions changes to 3 of these 7 layers.

### 5. The skill menu pattern doesn't actually work the way the plan implies

The plan says to "follow the existing skill autocomplete pattern." But the skill autocomplete is very specifically designed for **the beginning of the input only** (`ChatInput.vue:259-260`):

```ts
if (text.startsWith('/') && (!text.includes(' ') || cursor <= text.indexOf(' ', 1)))
```

This only works when `/` is the first character. The `@` mention needs to work **anywhere in the text** — mid-sentence, after a space, etc. The detection logic will be fundamentally different from the skill menu. You can't just copy-paste the skill approach; you need cursor-position-aware substring matching with a regex lookbehind for word boundary.

### 6. `highlightMarkdownSyntax` doesn't support embedded HTML concepts

The plan says to add mention detection to `highlightMarkdownSyntax` in `ChatInput.vue`. The function processes text line-by-line with regex replacements (`ChatInput.vue:10-54`). It works on already-HTML-escaped text (note `&amp;`, `&lt;`, `&gt;` replacements on line 14-16).

The `@[Bond](project:uuid)` pattern contains `[`, `]`, `(`, `)` which are **not** HTML-escaped in this function, so the regex would work. However, the function runs replacements in sequence and there's a risk of the mention pattern's brackets interfering with existing regex patterns (especially the inline code backtick replacement). The mention regex needs to run **before** the markdown syntax patterns, or use a placeholder approach.

Also: the `@[Name](project:uuid)` format looks like a markdown link to `marked.js`. When the message is rendered via `MarkdownMessage.vue` (which uses `marked` + DOMPurify), it would render as a clickable `<a>` tag pointing to `project:uuid`. The plan doesn't address this conflict — you'd need a custom `marked` extension or pre-process the tokens before markdown rendering.

## Missing Pieces

### 1. No mention of the `ChatDeps` interface

`useChat.ts` is injected with a `ChatDeps` interface (`useChat.ts:32-40`). If mention IDs need to flow through `submit()` → `send()`, the `ChatDeps.send` signature must change. This interface is the contract between the composable and the outside world.

### 2. No mention of `env.d.ts`

The renderer's type definitions for `window.bond` live in `src/renderer/env.d.ts:53`. If `listProjects` already exists there (it does — line 53), that's fine. But if the `send` signature changes, this file also needs updating.

### 3. `window.bond.listProjects()` already exists

The plan says:

> Add `window.bond.listProjects()` IPC call (or reuse if it exists)

It exists. It's in `preload/index.ts:58`, typed in `env.d.ts:53`, backed by `project.list` RPC in `server.ts:719-720`. No work needed here. The plan should just say "use the existing `window.bond.listProjects()`".

### 4. No mention of message persistence impact

`useChat.ts` persists messages via `toSessionMessages()` (`useChat.ts:46-61`). User messages are stored as `SessionMessage` objects with `{ role: 'user', text: string }`. If the raw text contains `@[Name](project:uuid)` tokens, they'll persist to the database in that format. Is that desired? If a project is renamed later, old messages will show stale names. The plan doesn't address this.

### 5. No handling of the `marked.js` renderer conflict

`MarkdownMessage.vue` uses `marked` with `gfm: true` (`line 50-55`). The `@[Name](project:uuid)` token is syntactically identical to a markdown link `[Name](project:uuid)` with a preceding `@`. `marked` will parse this as: text `@` followed by link `[Name](project:uuid)`, rendering:

```html
@<a href="project:uuid">Name</a>
```

DOMPurify may strip the `href` since `project:` isn't a known URL scheme. You need either:
- A custom `marked` tokenizer/renderer to intercept this pattern
- A pre-processing step before markdown parsing that converts mention tokens to a safe HTML placeholder
- A different token format that doesn't collide with markdown link syntax

### 6. QuickChat.vue is a separate consumer

`QuickChat.vue` renders `ChatInput` and handles `@submit` with a simpler handler (`QuickChat.vue:74-77`). It only passes `text` to `chat.submit()`, ignoring images. The plan's changes to the submit signature would break this unless updated.

### 7. The plan doesn't mention filtering archived projects

`listProjects()` returns all projects including archived ones (`daemon/projects.ts:63-69` — queries `WHERE archived = 0`). Actually, looking at it, the daemon does filter. But the plan should explicitly state whether archived projects are excluded from the autocomplete menu, which they should be.

## Suggestions

### Alternative: Don't change the emit/send/IPC chain

Instead of threading `mentionedProjectIds` through 7 layers of function signatures, parse the mention tokens from the message text **on the daemon side**. The `bond.send` handler already receives the raw text. Add a helper:

```ts
function extractMentionedProjectIds(text: string): string[] {
  const re = /@\[.*?\]\(project:([a-f0-9-]+)\)/g
  const ids: string[] = []
  let m
  while ((m = re.exec(text)) !== null) ids.push(m[1])
  return ids
}
```

Call this in `server.ts` right after receiving the text, before `runBondQuery`. This eliminates all signature changes across the renderer, preload, client, and IPC layers. The renderer only needs to handle the UX (autocomplete + token insertion). The daemon handles the semantics.

### Alternative token format

Instead of `@[Name](project:uuid)` which collides with markdown, consider:
- `@«Name»{project:uuid}` — visually distinct, no markdown collision
- `@project:uuid` — simple, but loses display name
- Just keep `@ProjectName` in the text and resolve by name on the daemon side (fragile with renames, but simple)

Or: use a zero-width marker approach. Insert the display text `@Bond` with the UUID embedded in a non-visible way (e.g., as a data attribute in the highlight overlay only, stripped before send). This keeps the raw text clean.

The most pragmatic approach: keep `@[Name](project:uuid)` in the textarea but strip it to `@Name` before sending. Pass the extracted IDs alongside — or better yet, parse them server-side from the raw text as suggested above, then strip the tokens from the prompt text before passing to the LLM.

### The `highlightMarkdownSyntax` approach is fragile for @ mentions

The highlight overlay works by having a `<div>` positioned exactly over the `<textarea>`, with the textarea text made transparent. This works for simple inline styling but gets tricky with mention "pills" that have backgrounds and padding — the padding changes the text flow and breaks alignment between the overlay and textarea.

Consider instead rendering mentions as styled text (color + font-weight only, no padding/background) in the input overlay, and only rendering the full pill style in sent messages. Or use a contenteditable approach for the input, though that's a much bigger change.

### Implement project-context.md first

The @mentions feature and the session-linked project context feature both need the same daemon infrastructure: looking up a project by ID and appending its data to the system prompt. Implement `project-context.md` first, then @mentions can reuse that same injection mechanism with minimal additional work.
