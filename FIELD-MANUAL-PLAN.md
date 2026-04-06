# Field Manual — Implementation Plan

## Concept

The Field Manual is a full-screen modal overlay (triggered by `Cmd+/`) that serves as Bond's comprehensive user guide. Not just keyboard shortcuts — a proper dossier covering every capability, with usage tips and examples. Styled with spy/dossier theming to match Bond's personality.

## Sections

### 1. Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `⌘B` | Toggle sidebar |
| `⌘⇧B` | Toggle right panel |
| `⌘N` | New chat |
| `⌘,` | Settings |
| `⌘⇧K` | Browser panel |
| `⌘T` | New browser tab (when browser panel open) |
| `⌘L` | Focus browser URL bar |
| `Escape` | Cancel response |
| `⌘/` | Open this Field Manual |

### 2. Capabilities

Each capability gets a brief description and 2-3 usage tips/examples.

- **Chat** — Talk naturally. Attach images (⌘V paste or drag). Ask Bond to read, write, and edit files, run shell commands, or search the web. Use edit modes (full/readonly/scoped) to control file access.
- **Projects** — Organize work with goals, deadlines, and resources (files, folders, links). Link chats and todos to projects so Bond has the right context. Create from the sidebar or ask Bond.
- **Todos** — Task tracking with groups, notes, and project links. Bond can create and complete todos during conversations. Manage in the sidebar panel or conversationally.
- **Journal** — Persistent entries for reflections, decisions, and notes. Both you and Bond can write. Link entries to projects. Search across all entries.
- **Collections** — Track anything with custom schemas — movies, books, coffee, workouts. Define your own fields. Add items conversationally ("just watched Dune, it was great").
- **Media Library** — Store and organize images. Bond can download images from the web. All images are searchable by filename.
- **Sense** — Ambient screen awareness. Bond can see what you're working on, summarize your day, recall something you saw earlier, or break down app usage.
- **Browser** — Built-in browser in the right panel. Bond can open URLs, read page content, take screenshots, and execute JavaScript.
- **Operatives** — Autonomous coding agents that work in the background. Each gets its own context window. Use worktrees for git isolation when running multiple operatives.
- **Skills** — Custom commands invoked with `/skill-name`. Extend Bond's behavior for your specific workflows. Create via settings or ask Bond to build one.

### 3. Pro Tips
- Drag files into chat for context (not just images — code, PDFs, text)
- Bond remembers context within a session — refer back freely
- Link chats to projects for focused, goal-oriented work
- Use `/skill-name` to invoke custom skills
- Use the journal to preserve decisions and summaries across sessions
- Operatives can work in parallel — spin up multiple for different tasks

## Implementation

### Files

| Action | File | Notes |
|--------|------|-------|
| Create | `src/renderer/components/FieldManual.vue` | The overlay component |
| Create | `src/renderer/components/FieldManual.test.ts` | Tests |
| Modify | `src/renderer/App.vue` | Add `⌘/` handler, import + render FieldManual |

### Component: FieldManual.vue

**Props:** `open: boolean`
**Emits:** `close`

**Structure:**
- Backdrop: semi-transparent overlay, click-to-close
- Card: scrollable content area, max-width ~720px, centered
- Header: "FIELD MANUAL" with CLASSIFIED stamp styling (reference MissionBriefing.vue)
- Body: sections with clear headers, icons from Phosphor
- Keyboard shortcuts in monospace, descriptions in sans-serif
- Capabilities as cards or grouped sections with icons
- Smooth Transition (fade + slight scale) on open/close
- Close on Escape keydown

**Styling:**
- Use Bond design tokens exclusively (--color-*, --radius-*, --shadow-*, --font-*)
- Scoped CSS
- Dark/light mode via tokens (no hardcoded colors)
- Subtle grid or dot background on the card for dossier feel
- Scrollable with hidden scrollbar or subtle custom one

### App.vue Changes

In `onKeyDown()`, add:
```typescript
if (e.metaKey && e.key === '/') {
  e.preventDefault()
  fieldManualOpen.value = !fieldManualOpen.value
}
```

Add ref and component:
```typescript
const fieldManualOpen = ref(false)
```

```vue
<FieldManual :open="fieldManualOpen" @close="fieldManualOpen = false" />
```

### Tests (FieldManual.test.ts)

- Renders when `open=true`
- Does not render when `open=false`
- Emits `close` on Escape keydown
- Emits `close` on backdrop click
- Contains expected section headings

## Bug Fix (required first)

**Operatives were failing because `permissionMode: 'dangerously_skip_permissions'` is not valid in SDK v0.2.86.** Changed to `bypassPermissions` in `src/daemon/operatives.ts`. This fix is already applied — restart the daemon for it to take effect.
