# @Mentions for Projects

Typing `@Bond` in the chat input should reference the Bond project and inject its context into the conversation. Same trigger pattern as `/skills`, but for projects.

**Prerequisite:** The `project-context.md` plan must be implemented first. @mentions and session-linked project context both need the same daemon infrastructure (looking up a project by ID and appending its data to the system prompt). Build that once, then @mentions reuses it.

---

## Behavior

1. User types `@` anywhere in the input
2. A popup menu appears with matching projects, filtered as they type
3. Selecting a project inserts a styled mention token into the input
4. On submit, the daemon parses mention tokens from the raw text and injects project context into the system prompt for that message

Unlike session-linked projects (which persist for the whole session), @mentions are per-message. They're a way to say "for this question, think about this project" without permanently linking the session.

---

## Input: Detection and Autocomplete

### Trigger
- Detect `@` followed by `[a-zA-Z0-9-_ ]*` at the **current cursor position** — not just the start of input
- Use cursor-position-aware substring matching with a regex lookbehind for word boundary (e.g., after a space or at position 0)
- Don't trigger inside backticks or code blocks
- Show the menu immediately on `@` (unfiltered = all non-archived projects)

> **Note:** The existing skill autocomplete in `ChatInput.vue` only works when `/` is the first character (line 259-260). The `@` mention detection logic is fundamentally different — it must work mid-sentence, after spaces, etc. Don't copy the skill trigger logic; write new cursor-position-aware detection.

### Menu
- Reuse the same popup positioning and styling as `.skill-menu`
- Each item shows project name and a one-line goal truncation
- Arrow keys to navigate, Tab/Enter to select, Escape to dismiss
- Archived projects are excluded (the daemon's `project.list` already filters `WHERE archived = 0`, but be explicit about this in the UI layer too)

### Selection
- Replace the `@partial` text with a mention token: `@[Bond](project:uuid)` in the raw textarea value
- In the highlight overlay, render mention tokens with a distinct color and weight (no pill/padding — see Styling section)

### Data Source
- Use the existing `window.bond.listProjects()` — it already exists in `preload/index.ts:58`, typed in `env.d.ts:53`, backed by `project.list` RPC in `server.ts`
- Load projects on mount, same as skills
- Filter client-side by name prefix match

---

## Submission: Server-Side Parsing

**Don't change the emit/send/IPC signature chain.** Instead, parse mention tokens from the message text on the daemon side. The `bond.send` handler already receives the raw text — extract mentions there.

### Daemon (`server.ts` / `agent.ts`)

Add a helper to extract mentioned project IDs from the raw message text:

```ts
function extractMentionedProjectIds(text: string): string[] {
  const re = /@\[.*?\]\(project:([a-f0-9-]+)\)/g
  const ids: string[] = []
  let m
  while ((m = re.exec(text)) !== null) ids.push(m[1])
  return ids
}
```

Call this in the `bond.send` handler (`server.ts`, around line 359) right after receiving the text, before calling `runBondQuery`. Then:

1. Strip the mention tokens from the text before passing to the LLM (replace `@[Name](project:uuid)` with `@Name`)
2. For each mentioned project ID, look up its data (name, goal, deadline, resources) using the same infrastructure built for `project-context.md`
3. Append a context block to the system prompt:

```
The user referenced the following projects in this message:

Project: "Bond"
Goal: Desktop AI assistant app
Resources:
  - [path] ~/Developer/Projects/bond
  - [link] https://github.com/user/bond
```

4. If the session also has a linked project, both appear — the linked project as primary context, mentions as supplementary
5. If the user @mentions the already-linked session project, don't double-inject

This approach means **zero changes** to:
- `ChatInput.vue` emit signature
- `useChat.ts` submit/send methods
- `ChatDeps` interface
- `BondClient.send()` in `shared/client.ts`
- The preload bridge in `preload/index.ts`
- `env.d.ts` type definitions
- `QuickChat.vue` (which also consumes `ChatInput` and only passes `text`)

The renderer only handles UX (autocomplete + token insertion). The daemon handles semantics.

---

## Display: Mention Rendering

### In the input (while typing)

In `highlightMarkdownSyntax`, detect the `@[...](project:...)` pattern and render as styled text. The mention regex **must run before** existing markdown syntax patterns to avoid bracket interference with the inline code backtick replacement.

Style mentions with color and font-weight only — no pill background or padding in the textarea overlay. Padding would change text flow and break alignment between the highlight overlay `<div>` and the underlying `<textarea>`.

```css
/* In the highlight overlay only */
.md-mention {
  color: var(--color-accent);
  font-weight: 600;
}
```

### In sent messages (message list)

`MarkdownMessage.vue` uses `marked` + DOMPurify. The `@[Name](project:uuid)` format is syntactically a markdown link — `marked` will parse it as `@<a href="project:uuid">Name</a>`, and DOMPurify may strip the `href` since `project:` isn't a known URL scheme.

**Solution:** Add a custom `marked` tokenizer extension that intercepts the `@[Name](project:uuid)` pattern before the standard link parser runs, and renders it as a styled span:

```ts
const mentionExtension = {
  name: 'mention',
  level: 'inline',
  start(src: string) { return src.indexOf('@[') },
  tokenizer(src: string) {
    const match = /^@\[([^\]]+)\]\(project:[a-f0-9-]+\)/.exec(src)
    if (match) return { type: 'mention', raw: match[0], name: match[1] }
  },
  renderer(token: { name: string }) {
    return `<span class="md-mention">@${token.name}</span>`
  }
}
```

### Styling in sent messages

Full pill styling is fine in rendered messages (no textarea alignment issue):

```css
.md-mention {
  color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 500;
}
```

Clicking a mention in a sent message could navigate to the project in the sidebar (nice-to-have).

---

## Message Persistence

User messages are persisted as `SessionMessage` with `{ role: 'user', text: string }` via `toSessionMessages()` in `useChat.ts`. The raw text will contain `@[Name](project:uuid)` tokens in the database.

**Trade-off:** If a project is renamed, old messages show stale names. This is acceptable — the mention reflects what the user typed at the time, similar to how chat apps work. The UUID still resolves correctly for context injection on re-send or history review.

---

## Interaction with Session-Linked Projects

- Session link = persistent project context for the whole session
- @mention = ad-hoc project context for one message
- They coexist. If you're in a Bond session and @mention WP Connectors, you get both in context
- @mentioning the already-linked project is a no-op (don't double-inject)

---

## Edge Cases

- **Multiple mentions**: Support mentioning multiple projects in one message. Each gets its own context block.
- **Unknown project**: If the user types `@FooBar` without selecting from the menu, don't inject anything — treat it as plain text. Only resolved mentions (with the `project:uuid` token) trigger context injection.
- **Deleted project**: If a mentioned project ID no longer exists at send time, silently skip it.
- **Long project names**: Truncate in the menu at ~40 chars. The token in the input can be any length.
- **QuickChat.vue**: No changes needed since mention parsing happens server-side. QuickChat's simpler submit handler continues to work as-is.

---

## Implementation Order

1. **Implement `project-context.md`** — prerequisite for context injection infrastructure
2. **Autocomplete menu**: Cursor-position-aware `@` detection, filtered project list using existing `listProjects()`, insert token on select
3. **Input highlight**: Render mention tokens as colored text in the overlay (before other markdown patterns)
4. **Server-side parsing**: `extractMentionedProjectIds()` in `bond.send` handler, strip tokens, inject context
5. **Message rendering**: Custom `marked` tokenizer extension for mention pills in sent messages
6. **Polish**: Click-to-navigate on mentions, edge case handling

Steps 1 is a prerequisite. Steps 2-3 are the input UX. Step 4 is the functional core. Steps 5-6 are polish.

---

## Future

- @mention other entities: `@todo:uuid`, `@collection:name`
- Mention people if Bond ever gets multi-user (probably not)
- Show a "context budget" indicator when mentions + session project + conversation history approach the context window limit
