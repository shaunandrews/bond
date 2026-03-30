# Bond — Claude Code Instructions

## Testing

Bond uses **Vitest** with **happy-dom** and **@vue/test-utils** for testing.

```bash
npm run test:run   # single run
npm test           # watch mode
```

Test files live next to their source: `useChat.ts` → `useChat.test.ts`, `ChatInput.vue` → `ChatInput.test.ts`.

### Rules

- **Always run `npm run test:run` after making changes** to verify nothing is broken.
- **Write tests for all new functionality.** New composables get unit tests. New components with logic or user interaction get component tests. Pure presentational components (no props, no events) can skip tests.
- **Composable tests** use a `withSetup` helper to run composables in a Vue app context. Inject mock `ChatDeps` instead of relying on `window.bond`.
- **Component tests** use `mount` or `shallowMount` from `@vue/test-utils`. Assert on emitted events, rendered text, and class presence — not computed styles (happy-dom doesn't process Tailwind).
- Test config is in `vitest.config.ts` (separate from `electron.vite.config.ts`).

## Architecture

Bond uses a daemon architecture. The renderer never talks to the Agent SDK directly.

```
Renderer (Vue) → Electron IPC → Main Process → Unix Socket (JSON-RPC 2.0) → Daemon → Claude API
```

### Daemon (`src/daemon/`)

Standalone Node.js WebSocket server on `~/.bond/bond.sock`. Manages agent queries, sessions, and settings. Persists to SQLite at `~/Library/Application Support/bond/bond.db`.

| File | Purpose |
|------|---------|
| `main.ts` | Entry point — spawns process, writes PID, sets up signal handling |
| `server.ts` | WebSocket server with JSON-RPC 2.0 dispatch (`bond.*`, `session.*`, `settings.*`) |
| `agent.ts` | Runs `query()` from Claude Agent SDK, streams chunks, handles tool approvals |
| `sessions.ts` | SQLite CRUD for sessions and messages |
| `db.ts` | Database init, migrations, WAL mode |
| `settings.ts` | Key-value settings storage (soul, model, accent color) |
| `generate-title.ts` | Auto-generates session titles via Haiku |
| `paths.ts` | Data directory resolution |

### Main Process (`src/main/`)

Electron main process. Spawns daemon if not running, creates window, proxies all IPC to the daemon via `BondClient`.

### Preload (`src/preload/index.ts`)

Exposes `window.bond` via `contextBridge` — typed API for chat, sessions, settings, model, shell utilities.

### Shared (`src/shared/`)

| File | Purpose |
|------|---------|
| `protocol.ts` | JSON-RPC 2.0 types and helpers |
| `stream.ts` | `BondStreamChunk` union type (text, tool, approval, error, system) |
| `client.ts` | `BondClient` WebSocket client class |
| `session.ts` | Session, SessionMessage, EditMode, AttachedImage types |
| `models.ts` | `ModelId` type (`'opus' | 'sonnet' | 'haiku'`) |

### CLI (`bin/bond`)

Bash CLI for daemon management: `bond status`, `bond start`, `bond stop`, `bond restart`, `bond dev`, `bond build`, `bond rebuild`, `bond log`, `bond test`.

## Project Structure

```
bin/bond                             # CLI for daemon management
src/
  daemon/
    main.ts                          # Daemon entry point
    server.ts                        # WebSocket JSON-RPC server
    agent.ts                         # Claude Agent SDK integration
    sessions.ts                      # Session CRUD (SQLite)
    db.ts                            # Database management + migrations
    settings.ts                      # Settings storage
    generate-title.ts                # Auto title generation
    paths.ts                         # Data directory paths
  main/index.ts                      # Electron main process
  preload/index.ts                   # contextBridge API
  shared/
    protocol.ts                      # JSON-RPC 2.0 types
    stream.ts                        # BondStreamChunk types
    client.ts                        # BondClient WebSocket client
    session.ts                       # Session & message types
    models.ts                        # ModelId type
  renderer/
    App.vue                          # Root shell — panel layout + view routing
    app.css                          # Tailwind v4 theme tokens
    types/message.ts                 # Message union type
    composables/
      useChat.ts                     # Chat state, streaming, message persistence
      useSessions.ts                 # Session CRUD, archive, title generation
      useAutoScroll.ts               # Smart scroll-to-bottom
      useAccentColor.ts              # Dynamic accent color theming
      useAppView.ts                  # View routing state
    components/
      BondText.vue                   # Polymorphic text primitive
      BondButton.vue                 # Button primitive (primary/secondary/ghost/danger)
      BondInput.vue                  # Text input with v-model
      BondTextarea.vue               # Multi-line textarea with v-model
      BondSelect.vue                 # Dropdown select
      BondTab.vue                    # Segmented tab bar
      BondPanelGroup.vue             # Resizable panel container
      BondPanel.vue                  # Individual resizable panel
      BondPanelHandle.vue            # Drag handle between panels
      panelTypes.ts                  # Panel system types + injection key
      ViewShell.vue                  # View wrapper (sticky header/footer, scroll area)
      ViewHeader.vue                 # Simple title bar
      ChatHeader.vue                 # Chat title display
      ChatInput.vue                  # Textarea + model/edit-mode selectors + attach + send/stop
      MessageBubble.vue              # Renders all message variants
      MarkdownMessage.vue            # Markdown with syntax highlighting + copy
      ThinkingIndicator.vue          # Animated working indicator
      SessionItem.vue                # Single session row
      SessionSidebar.vue             # Sidebar with session lists + nav
      SettingsView.vue               # Accent color, model, personality settings
      AboutView.vue                  # Architecture, tools, data paths, CLI reference
      DesignSystemView.vue           # Live design token browser
      DevComponents.vue              # Dev-only component catalog
    lib/highlight.ts                 # highlight.js language registration
```

## Components

**Always use existing components** before creating new ones. When you add a new component or change props/events on an existing one, update this section AND the `DevComponents.vue` catalog.

### BondText
Polymorphic text component for all UI text. Renders any HTML element via `as` prop.
- **Props:** `as?: string` (default: `'span'`), `size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl'`, `weight?: 'normal' | 'medium' | 'semibold' | 'bold'`, `color?: 'primary' | 'muted' | 'accent' | 'err' | 'ok' | 'inherit'`, `align?: 'left' | 'center' | 'right'`, `truncate?: boolean`, `mono?: boolean`
- **Slot:** default — text content

### BondButton
Button with variant and size options.
- **Props:** `variant?: 'primary' | 'secondary' | 'ghost' | 'danger'`, `size?: 'sm' | 'md'`, `disabled?: boolean`
- **Slot:** default — button label

### BondInput
Text input with v-model support.
- **Props:** `modelValue?: string`, `placeholder?: string`, `type?: string`, `disabled?: boolean`
- **Events:** `update:modelValue(value: string)`

### BondTextarea
Multi-line textarea with v-model support.
- **Props:** `modelValue?: string`, `placeholder?: string`, `rows?: number`, `disabled?: boolean`
- **Events:** `update:modelValue(value: string)`

### BondSelect
Dropdown select with custom chevron.
- **Props:** `modelValue?: string`, `options: { value, label }[]`, `disabled?: boolean`
- **Events:** `update:modelValue(value: string)`

### BondTab
Segmented tab bar.
- **Props:** `tabs: { id, label }[]`, `modelValue?: string`
- **Events:** `update:modelValue(value: string)`

### BondPanelGroup
Flex container that manages resizable panel layout. Nest `BondPanel` and `BondPanelHandle` as direct children.
- **Props:** `direction?: 'horizontal' | 'vertical'`, `autoSaveId?: string` (localStorage key), `keyboardStep?: number` (default: 5)
- **Events:** `layoutChange(layout)` (during drag), `layoutChanged(layout)` (after drag ends)
- **Expose:** `getLayout()`, `setLayout(layout)`

### BondPanel
Individual resizable panel. Must be a direct child of `BondPanelGroup`. Slot props: `{ size, collapsed }`.
- **Props:** `id: string`, `defaultSize?: number` (%), `minSize?: number` (% default: 10), `maxSize?: number` (% default: 100), `minSizePx?: number` (optional, pixel-based minimum — takes precedence), `collapsible?: boolean`, `collapsedSize?: number` (% default: 0), `header?: string` (renders a section header with collapse/expand chevron when collapsible)
- **Slots:** `default` (panel content), `header-extra` (extra controls in the header row, e.g. a + button)
- **Expose:** `collapse()`, `expand()`, `getSize()`, `isCollapsed()`, `resize(size)`

### BondPanelHandle
Drag handle placed between panels. Supports pointer drag, keyboard arrows, Home/End. Styled via `data-state` attribute (`inactive` | `hover` | `drag`).
- **Props:** `id: string` (format: `handle-N`), `disabled?: boolean`, `hitArea?: number` (px, default: 8)
- **Accessibility:** `role="separator"`, arrow keys, `aria-orientation`

### ViewShell
View wrapper with sticky header, scrollable content area, and optional sticky footer. Backdrop blur on both header and footer edges.
- **Props:** `title: string`
- **Slots:** `header-left` (optional left content in header row), `default` (main content), `footer` (optional sticky footer)
- **Expose:** `scrollAreaEl` (the scrollable container element)

### ViewHeader
Simple title bar with optional subtitle. Legacy — prefer ViewShell for new views.
- **Props:** `title: string`, `subtitle?: string`

### ChatHeader
Displays the current chat title. Rendered inside the app-header layout shell in App.vue.
- **Props:** `title: string`

### ChatInput
Unified chat box combining textarea, model selector, edit mode selector, attach button, and a single contextual action button. Auto-focuses after response completes.
- **Props:** `busy: boolean` — swaps action button between send/stop, `model: ModelId`, `editMode: EditMode`
- **Events:** `submit(text: string, images: AttachedImage[])`, `cancel()`, `update:model(value: ModelId)`, `update:editMode(value: EditMode)`
- Single bordered container with textarea on top and a toolbar row below (model select, edit mode select, attach, action button). Action button shows send (arrow-up, accent) when idle, stop (stop icon) when busy. Attach button opens native file picker for jpeg/png/gif/webp. Image thumbnails appear above textarea inside the box. Edit mode selector switches between readonly, scoped (with paths input), and full.

### MessageBubble
Renders all message variants based on the `Message` union type. Delegates markdown to MarkdownMessage. User messages render attached images above text.
- **Props:** `msg: Message` — role/kind determines which variant renders
- **Events:** `approve(requestId: string, approved: boolean)` — emitted for tool approval actions

### MarkdownMessage
Renders markdown with syntax highlighting and copy-to-clipboard code blocks. Uses marked.js, DOMPurify, and highlight.js.
- **Props:** `text: string`, `streaming: boolean`
- Throttled rendering during streaming. External links open via `window.bond.openExternal()`.

### ThinkingIndicator
Animated "Bond is working..." with blinking dots. No props or events.

### SessionItem
Single session row used in both active and archived lists inside SessionSidebar. Action button floats over content on hover (no reserved space).
- **Props:** `session: Session`, `active?: boolean`, `archived?: boolean`, `generating?: boolean`, `actionTitle: string`
- **Slot:** default — action button content (icon)
- **Events:** `select()`, `action()`

### SessionSidebar
Left sidebar with session lists and nav links. Uses SessionItem for consistent rendering across active and archived lists. Archives section has built-in collapse/expand.
- **Props:** `sessions: Session[]`, `archivedSessions: Session[]`, `activeSessionId: string | null`, `activeView: AppView`, `generatingTitleId: string | null`
- **Events:** `select(id)`, `create()`, `archive(id)`, `unarchive(id)`, `remove(id)`, `switchView(view)`, `toggleSidebar()`

### SettingsView
Settings panel with accent color picker (8 presets + custom), default model selector, and personality/soul text editor. No props — reads/writes via `window.bond` directly.

### DesignSystemView
Interactive design token showcase. Displays color swatches, typography, radius, shadows, transitions, and spacing values. Reads computed styles from `:root`. No props.

### AboutView
In-app reference screen showing Bond's architecture (layered stack diagram), agent tools, edit modes, data paths, and CLI commands. Accessible from the sidebar gear menu.

### DevComponents
Dev-only component catalog with live previews and prop/event documentation. Toggle with **Cmd+Shift+D**. Not rendered in production flows.

## Composables

### useChat(deps)
All chat state and logic. Handles message streaming, persistence, tool approvals, and HMR-safe state preservation.
- **State:** `messages`, `busy`, `thinking`, `currentSessionId`
- **Methods:** `submit()`, `cancel()`, `respondToApproval()`, `subscribe()`, `unsubscribe()`, `loadSession()`, `clearMessages()`, `persistMessages()`

### useSessions(deps)
Session CRUD, archive/unarchive, title generation. Persists active session ID to localStorage.
- **State:** `sessions`, `activeSessionId`, `activeSession`, `activeSessions`, `archivedSessions`, `generatingTitleId`
- **Methods:** `load()`, `create()`, `select()`, `archive()`, `unarchive()`, `remove()`, `refreshTitle()`, `updateLocal()`

### useAutoScroll(containerRef)
Smart scroll-to-bottom for streaming content. Uses MutationObserver and ResizeObserver.
- **State:** `isAtBottom`
- **Methods:** `scrollToBottom()`

### useAccentColor()
Dynamic accent color theming. Derives a full palette from a single hex color (HSL-based tinting for backgrounds, borders, and text).
- **State:** `accent`, `defaultAccent`
- **Methods:** `load()`, `setAccent()`, `reset()`

### useAppView()
View routing state. Persists to localStorage.
- **State:** `activeView` (`'chat' | 'settings' | 'design-system' | 'components'`)

## Icons

Bond uses [Phosphor Icons](https://phosphoricons.com) via `@phosphor-icons/vue`. Import individual icons by name — they are tree-shaken automatically.

```vue
<script lang="ts" setup>
import { PhHouse, PhGear, PhTrash } from '@phosphor-icons/vue'
</script>

<template>
  <PhHouse :size="20" weight="regular" />
  <PhGear :size="20" weight="bold" />
  <PhTrash :size="20" color="var(--color-err)" />
</template>
```

### Props (all optional)
- **size**: `number | string` — width & height (default: `24`)
- **color**: `string` — stroke/fill color, any CSS value (default: `currentColor`)
- **weight**: `"thin" | "light" | "regular" | "bold" | "fill" | "duotone"` (default: `"regular"`)
- **mirrored**: `boolean` — flip horizontally for RTL

### Rules
- **Always use `currentColor`** (the default) so icons inherit text color from their parent.
- **Import individually** — never register globally, to keep bundles small.
- Browse available icons at [phosphoricons.com](https://phosphoricons.com).

## Design Tokens

Colors are defined in `app.css` via Tailwind v4's `@theme` directive. Dark mode uses `prefers-color-scheme` media query. Use the existing token names (`bg`, `surface`, `border`, `text-primary`, `muted`, `accent`, `err`, `ok`, `tint`) in Tailwind classes.

### Color tokens
| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `bg` | `#f6f5f2` | `#0f1114` | Page background |
| `surface` | `#fff` | `#181b21` | Cards, inputs |
| `border` | `#ddd9d0` | `#343b45` | Borders, dividers |
| `text-primary` | `#1a1c1f` | `#e8eaed` | Main text |
| `muted` | `#5c6570` | `#8b939e` | Secondary text |
| `accent` | `#7a5c3b` | `#c4a07c` | Interactive elements (customizable) |
| `err` | `#e57373` | `#ef9a9a` | Error states |
| `ok` | `#81c784` | `#a5d6a7` | Success states |
| `tint` | `rgba(255,255,255,0.65)` | `rgba(255,255,255,0.08)` | Overlay tints |

### Other tokens
- **Radius:** `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (8px), `--radius-xl` (12px)
- **Shadows:** `--shadow-sm`, `--shadow-md`, `--shadow-lg` (stronger in dark mode)
- **Transitions:** `--transition-fast` (0.12s), `--transition-base` (0.15s)
- **Fonts:** `--font-sans` (Inter stack), `--font-mono` (SF Mono stack)
- **Sidebar:** Separate token set (`--sidebar-border`, `--sidebar-text`, `--sidebar-hover-bg`, etc.) using rgba for transparency-based theming

## Message Types

```typescript
type Message =
  | { id, role: 'user', text, images?: AttachedImage[] }
  | { id, role: 'bond', text, streaming: boolean }
  | { id, role: 'meta', kind: 'tool', name, summary? }
  | { id, role: 'meta', kind: 'error', text }
  | { id, role: 'meta', kind: 'approval', requestId, toolName, input, title?, description?, status: 'pending' | 'approved' | 'denied' }
  | { id, role: 'meta', kind: 'system', text }
```

## Edit Modes

Sessions support three edit modes that control which Agent SDK tools are available:

```typescript
type EditMode =
  | { type: 'full' }                              // All tools (Read, Write, Edit, Bash, etc.)
  | { type: 'readonly' }                           // Read, Glob, Grep only
  | { type: 'scoped', allowedPaths: string[] }     // Read/write restricted to specific paths
```

The edit mode selector appears in ChatInput's toolbar. The daemon's `agent.ts` maps these to tool configurations and system prompt suffixes.
