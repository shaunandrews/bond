# Bond — Claude Code Instructions

## Testing

Bond uses **Vitest** with **happy-dom** and **@vue/test-utils** for testing.

```bash
npm run test:run      # single run
npm test              # watch mode
npm run test:coverage # with coverage report
```

Test files live next to their source: `useChat.ts` → `useChat.test.ts`, `ChatInput.vue` → `ChatInput.test.ts`.

### Rules

- **Every new `.ts` file with logic gets a `.test.ts` sibling.**
- **Every new composable gets unit tests.**
- **Every new component with props, events, or user interaction gets component tests.** Pure presentational components (no logic, no events) can skip tests.
- **Every bug fix includes a regression test** that would have caught it.
- **`npm run test:run` is the final step of any code change** — always run it, never skip it.
- **When modifying existing code**, check for an adjacent test file and update it to cover the change.
- **If a test file exists but doesn't cover the modified code path**, add a test case.
- **Composable tests** use a `withSetup` helper to run composables in a Vue app context. Inject mock `ChatDeps` instead of relying on `window.bond`.
- **Component tests** use `mount` or `shallowMount` from `@vue/test-utils`. Assert on emitted events, rendered text, and class presence — not computed styles (happy-dom doesn't process Tailwind).
- **Daemon data layer tests** create an in-memory SQLite database, run migrations, and exercise all exported functions.
- Test config is in `vitest.config.ts` (separate from `electron.vite.config.ts`). Coverage uses `@vitest/coverage-v8`.
- A **pre-commit hook** runs `vitest run` — commits are rejected if tests fail.

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
| `server.ts` | WebSocket server with JSON-RPC 2.0 dispatch (`bond.*`, `session.*`, `project.*`, `image.*`, `todo.*`, `settings.*`, `skills.*`, `sense.*`, `browser.*`, `operative.*`) |
| `agent.ts` | Runs `query()` from Claude Agent SDK, streams chunks, handles tool approvals |
| `sessions.ts` | SQLite CRUD for sessions and messages |
| `projects.ts` | Project CRUD + resource management (SQLite) |
| `todos.ts` | Todo CRUD (SQLite) |
| `images.ts` | Image storage — save/get/delete files + `images` table CRUD |
| `db.ts` | Database init, migrations, WAL mode |
| `settings.ts` | Key-value settings storage (soul, model, accent color) |
| `generate-title.ts` | Auto-generates session titles via Haiku |
| `paths.ts` | Data directory resolution |
| `skills.ts` | Skill scanning from ~/.bond/skills/ |
| `operatives.ts` | Operative CRUD, spawn, cancel, event storage, concurrency queue |
| `sense/controller.ts` | Sense state machine (disabled/armed/recording/idle/paused/suspended) |
| `sense/presence.ts` | Idle detection via `ioreg -c IOHIDSystem` polling |
| `sense/window-detector.ts` | App/window polling via `bond-window-helper` native binary |
| `sense/clipboard.ts` | Clipboard mirroring via async `pbpaste` polling |
| `sense/privacy.ts` | Blacklist checking + ambiguity detection |
| `sense/accessibility.ts` | Accessibility tree extraction via `bond-accessibility-helper` |
| `sense/ocr.ts` | OCR extraction via `bond-ocr-helper` (max 2 parallel) |
| `sense/text-router.ts` | Accessibility vs. OCR routing with per-app quality cache |
| `sense/redaction.ts` | Security redaction (API keys, tokens, cards, SSNs) |
| `sense/worker.ts` | Queue-based text extraction worker |
| `sense/storage.ts` | Retention enforcement, auto-cleanup, storage stats |
| `sense/helpers.ts` | Native binary path resolution |

### Main Process (`src/main/`)

Electron main process. Spawns daemon if not running, creates window, proxies all IPC to the daemon via `BondClient`. In packaged mode (`app.isPackaged`), resolves the daemon from `process.resourcesPath/daemon/`, finds Node.js via login shell + well-known paths, and resolves the full user PATH (login shell + fallback) so the daemon can find user-installed binaries like `studio`. Also handles Sense screenshot capture (`src/main/sense.ts` — `desktopCapturer` + `NativeImage.toJPEG`), tray indicator (`src/main/tray.ts`), and browser webContents management (`src/main/browser.ts` — tab registry, screenshot capture, JS execution, command proxying between daemon and renderer).

### Preload (`src/preload/index.ts`)

Exposes `window.bond` via `contextBridge` — typed API for chat, sessions, projects, todos, settings, images, skills, model, sense, browser, and shell utilities.

### Shared (`src/shared/`)

| File | Purpose |
|------|---------|
| `protocol.ts` | JSON-RPC 2.0 types and helpers |
| `stream.ts` | `BondStreamChunk` union type (text, thinking, tool, approval, error, system) |
| `client.ts` | `BondClient` WebSocket client class |
| `session.ts` | Session, SessionMessage, EditMode, AttachedImage, Project, ProjectResource, TodoItem types |
| `sense.ts` | SenseSession, SenseCapture, SenseSettings, SenseState, DetectedWindow, OcrResult, AccessibilityResult types |
| `browser.ts` | BrowserTab, BrowserCommand, ConsoleEntry, NetworkEntry types |
| `operative.ts` | Operative, OperativeEvent, SpawnOperativeOptions types |
| `models.ts` | `ModelId` type (`'opus' | 'sonnet' | 'haiku'`) |

### CLI (`bin/bond`)

Bash CLI for daemon management and data: `bond status`, `bond start`, `bond stop`, `bond restart`, `bond dev`, `bond build`, `bond rebuild`, `bond log`, `bond todo`, `bond project`, `bond media`, `bond screenshot`, `bond sense`, `bond browser`, `bond operative`, `bond test`.

## Project Structure

```
bin/bond                             # CLI for daemon management
scripts/
  build-native-helpers.sh            # Compiles Obj-C native helpers → out/daemon/bin/sense/
src/
  cli/
    todo.ts                          # bond todo — CLI for todo management
    project.ts                       # bond project — CLI for project management
    media.ts                         # bond media — CLI for media management
    screenshot.ts                    # bond screenshot — capture Bond window
    sense.ts                         # bond sense — CLI for Sense ambient awareness
    browser.ts                       # bond browser — CLI for in-app browser control
    operative.ts                     # bond operative — CLI for operative management
  native/
    window-helper.m                  # CGWindowList native helper (Obj-C)
    ocr-helper.m                     # Apple Vision OCR native helper (Obj-C)
    accessibility-helper.m           # AXUIElement tree walker native helper (Obj-C)
  daemon/
    main.ts                          # Daemon entry point
    server.ts                        # WebSocket JSON-RPC server
    agent.ts                         # Claude Agent SDK integration
    sessions.ts                      # Session CRUD (SQLite)
    projects.ts                      # Project + resource CRUD (SQLite)
    todos.ts                         # Todo CRUD (SQLite)
    images.ts                        # Image file storage + images table
    db.ts                            # Database management + migrations
    settings.ts                      # Settings storage
    generate-title.ts                # Auto title generation
    parse-todo.ts                    # AI-powered todo input parsing
    paths.ts                         # Data directory paths
    skills.ts                        # Skill scanning from ~/.bond/skills/
    operatives.ts                    # Operative CRUD, spawn, cancel, events
    sense/
      controller.ts                  # State machine (disabled/armed/recording/idle/paused/suspended)
      presence.ts                    # Idle detection via ioreg
      window-detector.ts             # App/window polling via bond-window-helper
      clipboard.ts                   # Clipboard mirroring via pbpaste
      privacy.ts                     # Blacklist checking + ambiguity detection
      accessibility.ts               # Accessibility tree extraction wrapper
      ocr.ts                         # OCR extraction wrapper
      text-router.ts                 # Accessibility vs. OCR routing
      redaction.ts                   # Security redaction engine
      worker.ts                      # Queue-based text extraction worker
      storage.ts                     # Retention enforcement + auto-cleanup
      helpers.ts                     # Native binary path resolution
  main/
    index.ts                         # Electron main process
    sense.ts                         # Sense capture coordinator (desktopCapturer)
    tray.ts                          # Menu bar tray icon for Sense state
    browser.ts                       # Browser IPC handlers, webContents registry, command proxy
  preload/index.ts                   # contextBridge API
  shared/
    protocol.ts                      # JSON-RPC 2.0 types
    stream.ts                        # BondStreamChunk types (incl. thinking_text)
    client.ts                        # BondClient WebSocket client
    session.ts                       # Session, SessionMessage, Project, ProjectResource, TodoItem, EditMode, AttachedImage types
    sense.ts                         # SenseSession, SenseCapture, SenseSettings, DetectedWindow, OcrResult types
    browser.ts                       # BrowserTab, BrowserCommand, ConsoleEntry, NetworkEntry types
    operative.ts                     # Operative, OperativeEvent, SpawnOperativeOptions types
    models.ts                        # ModelId type
  renderer/
    App.vue                          # Root shell — panel layout + view routing
    ViewerWindow.vue                 # Markdown file viewer window
    app.css                          # Tailwind v4 theme tokens
    types/message.ts                 # Message union type
    types/webview.d.ts               # Electron webview element types
    composables/
      useChat.ts                     # Chat state, streaming, message persistence
      useSessions.ts                 # Session CRUD, archive, title generation
      useProjects.ts                 # Project CRUD, archive, resources
      useAutoScroll.ts               # Smart scroll-to-bottom
      useAccentColor.ts              # Dynamic accent color theming
      useAppView.ts                  # View routing state (chat | projects | media | sense)
      useBrowser.ts                  # Browser tab state, favorites, console/network logs
      useSense.ts                    # Sense timeline state, day loading, capture selection, search
      useOperatives.ts               # Operative list state, spawn, cancel, live updates
      useOperativeEvents.ts          # Operative event streaming for detail view
    directives/
      tooltip.ts                     # v-tooltip directive (singleton, positioned tooltips)
    components/
      BondText.vue                   # Polymorphic text primitive
      BondButton.vue                 # Button primitive (primary/secondary/ghost/danger)
      BondInput.vue                  # Text input with v-model
      BondTextarea.vue               # Multi-line textarea with v-model
      BondSelect.vue                 # Dropdown select
      BondFlyoutMenu.vue             # Teleported flyout menu primitive
      BondTab.vue                    # Segmented tab bar
      BondPanelGroup.vue             # Resizable panel container
      BondPanel.vue                  # Individual resizable panel
      BondToolbar.vue                # Standardized toolbar (grid layout, start/middle/end slots)
      BondPanelHandle.vue            # Drag handle between panels
      panelTypes.ts                  # Panel system types + injection key
      ViewShell.vue                  # View wrapper (sticky header/footer, scroll area)
      ChatInput.vue                  # Textarea + model/edit-mode selectors + attach + send/stop
      MessageBubble.vue              # Renders all message variants
      MarkdownMessage.vue            # Markdown with syntax highlighting + copy
      ThinkingIndicator.vue          # Standalone "Bond is working..." dots (unused, kept for reference)
      SessionItem.vue                # Single session row
      SessionSidebar.vue             # Sidebar with session lists + nav
      ProjectDetail.vue              # Shared project detail (todos, resources, deadline, goal)
      ProjectsView.vue               # Project list + detail view (main content area)
      ProjectPanelView.vue           # Project list/detail panel (right side of chat)
      ProjectWizard.vue              # Multi-step project creation wizard
      MediaView.vue                  # Image gallery view
      TodoView.vue                   # Todo panel with groups and notes
      CopyButton.vue                 # Inline copy-to-clipboard button
      ActivityBar.vue                # Expandable activity/event log bar
      MissionBriefing.vue            # Empty chat welcome screen
      SettingsView.vue               # Accent color, model, personality settings
      AboutView.vue                  # Architecture, tools, data paths, CLI reference
      DesignSystemView.vue           # Live design token browser
      BrowserView.vue                # Tabbed in-app browser with nav, favorites, webviews
      BrowserDevTools.vue            # Console + Network panel for browser
      SenseView.vue                  # Sense timeline main view (day nav + detail + timeline dock)
      SenseDayNav.vue                # Date navigation (prev/next/picker)
      SenseTimeline.vue              # Density bar scrubber with playhead and hover preview
      SenseDetail.vue                # Screenshot viewer with metadata and extracted text
      SenseAppLegend.vue             # App color legend with filter chips
      SenseSearch.vue                # Inline search with results flyout
      OperativesView.vue             # Operative list with status, filters, actions
      OperativeDetail.vue            # Operative detail with streaming event feed
      DevComponents.vue              # Dev-only component catalog
    lib/highlight.ts                 # highlight.js language registration
electron.vite.config.ts                  # Build config (main, preload, renderer)
electron-builder.yml                     # Packaging config (macOS DMG, extraResources for daemon)
build/icon.icns                          # macOS app icon
```

## Components

**Always use existing components** before creating new ones. When you add a new component or change props/events on an existing one, update this section AND the `DevComponents.vue` catalog.

### v-tooltip (directive)
Global directive for tooltips. Replaces native `title` attributes with styled, animated, positioned tooltips. Singleton DOM element — only one tooltip visible at a time.
- **Usage:** `v-tooltip="'text'"` (string), `v-tooltip="{ content: 'text', placement: 'right' }"` (object), `v-tooltip.bottom="'text'"` (modifier)
- **Placements:** `top` (default), `bottom`, `left`, `right` — auto-flips at viewport edges
- **Timing:** 400ms show delay, 80ms skip delay (when hovering between adjacent triggers quickly), 100ms hide delay
- **Accessibility:** `role="tooltip"`, `aria-describedby`, Escape to dismiss, keyboard focus support
- **Styling:** Inverted colors (dark bg on light mode, light bg on dark mode), arrow pointer, fade+scale animation

### BondText
Polymorphic text component for all UI text. Renders any HTML element via `as` prop.
- **Props:** `as?: string` (default: `'span'`), `size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl'`, `weight?: 'normal' | 'medium' | 'semibold' | 'bold'`, `color?: 'primary' | 'muted' | 'accent' | 'err' | 'ok' | 'inherit'`, `align?: 'left' | 'center' | 'right'`, `truncate?: boolean`, `mono?: boolean`
- **Slot:** default — text content

### BondButton
Button with variant and size options. Supports icon-only mode for toolbar buttons.
- **Props:** `variant?: 'primary' | 'secondary' | 'ghost' | 'danger'`, `size?: 'sm' | 'md'`, `icon?: boolean` (square with equal padding), `disabled?: boolean`
- **Slot:** default — button label (or icon when `icon` is true)

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
- **Props:** `modelValue?: string`, `options: { value, label }[]`, `disabled?: boolean`, `placement?: 'top' | 'bottom'`, `variant?: 'default' | 'minimal'` (minimal removes background and border), `size?: 'sm' | 'md'` (default: `'md'`)
- **Events:** `update:modelValue(value: string)`

### BondFlyoutMenu
Teleported flyout menu primitive. Renders via `<Teleport to="body">` with fixed positioning relative to an anchor element. Auto-flips when the menu would overflow the viewport, clamps horizontally, and repositions on scroll/resize. Used by BondSelect and SessionSidebar's archive flyout.
- **Props:** `open: boolean`, `anchor: HTMLElement | null`, `placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'`, `width?: number`, `padding?: boolean`
- **Events:** `close()`
- **Slot:** default — menu content

### BondTab
Segmented tab bar.
- **Props:** `tabs: { id, label }[]`, `modelValue?: string`
- **Events:** `update:modelValue(value: string)`

### BondPanelGroup
Flex container that manages resizable panel layout. Nest `BondPanel` and `BondPanelHandle` as direct children. Pixel-unit panels use `flex-shrink: 1` so they participate in CSS flexbox shrinking when the container is too small, with CSS `min-width`/`min-height` enforcing minimums natively. JS state is synced to DOM at drag/animation start via `syncPxStateToDom()`.
- **Props:** `direction?: 'horizontal' | 'vertical'`, `autoSaveId?: string` (localStorage key), `keyboardStep?: number` (default: 5)
- **Events:** `layoutChange(layout)` (during drag), `layoutChanged(layout)` (after drag ends)
- **Expose:** `getLayout()`, `setLayout(layout)`

### BondPanel
Individual resizable panel. Must be a direct child of `BondPanelGroup`. Slot props: `{ size, collapsed }`. Applies CSS `min-width` (horizontal) or `min-height` (vertical) from the group's `getMinDimStyle()` — suppressed during collapse/expand animation.
- **Props:** `id: string`, `defaultSize?: number` (%), `minSize?: number` (% default: 10), `maxSize?: number` (% default: 100), `minSizePx?: number` (optional, pixel-based minimum — enforced via CSS min-width), `unit?: 'px' | '%'` (default: `'%'`), `collapsible?: boolean`, `collapsedSize?: number` (% default: 0), `header?: string` (renders a section header with collapse/expand chevron when collapsible)
- **Slots:** `default` (panel content), `header-extra` (extra controls in the header row, e.g. a + button)
- **Expose:** `collapse()`, `expand()`, `getSize()`, `isCollapsed()`, `resize(size)`

### BondToolbar
Standardized toolbar with true-center middle slot. Uses CSS Grid (`1fr auto 1fr`) so the middle content is always visually centered regardless of start/end width. Fixed height via `--toolbar-height` token. Used by ViewShell (header) and SitePreview (browser toolbar).
- **Props:** `label: string` (required, `aria-label`), `border?: 'none' | 'bottom'`, `drag?: boolean` (Electron drag region), `blur?: boolean` (backdrop blur for sticky headers)
- **Slots:** `start` (left-aligned), `middle` (true-centered), `end` (right-aligned)
- **Accessibility:** `role="toolbar"`, `aria-label`

### BondPanelHandle
Drag handle placed between panels. Supports pointer drag, keyboard arrows, Home/End. Styled via `data-state` attribute (`inactive` | `hover` | `drag`).
- **Props:** `id: string` (format: `handle-N`), `disabled?: boolean`, `hitArea?: number` (px, default: 8)
- **Accessibility:** `role="separator"`, arrow keys, `aria-orientation`

### ViewShell
View wrapper with sticky header (using BondToolbar), scrollable content area, and optional sticky footer. Backdrop blur on both header and footer edges.
- **Props:** `title: string`, `subtitle?: string`
- **Slots:** `header-start` (optional start content in toolbar), `header-end` (optional end content in toolbar), `default` (main content), `footer` (optional sticky footer)
- **Expose:** `scrollAreaEl` (the scrollable container element)

### ChatInput
Unified chat box combining textarea, model selector, edit mode selector, attach button, and a single contextual action button. Auto-focuses after response completes.
- **Props:** `busy: boolean` — swaps action button between send/stop, `model: ModelId`, `editMode: EditMode`
- **Events:** `submit(text: string, images: AttachedImage[])`, `cancel()`, `update:model(value: ModelId)`, `update:editMode(value: EditMode)`
- Single bordered container with textarea on top and a toolbar row below (model select, edit mode select, attach, action button). Action button shows send (arrow-up, accent) when idle, stop (stop icon) when busy. Attach button opens native file picker for jpeg/png/gif/webp. Image thumbnails appear above textarea inside the box. Edit mode selector switches between readonly, scoped (with paths input), and full.

### MessageBubble
Renders all message variants based on the `Message` union type. Delegates markdown to MarkdownMessage. User messages render attached images above text. Thinking messages transition through three states: "Bond is working..." (no text yet) → "Thinking..." (streaming) → "Thought for Xs" accordion (finalized, click to expand).
- **Props:** `msg: Message` — role/kind determines which variant renders
- **Events:** `approve(requestId: string, approved: boolean)` — emitted for tool approval actions

### MarkdownMessage
Renders markdown with syntax highlighting and copy-to-clipboard code blocks. Uses marked.js, DOMPurify, and highlight.js.
- **Props:** `text: string`, `streaming: boolean`
- Throttled rendering during streaming. External links open via `window.bond.openExternal()`.

### ThinkingIndicator
Standalone animated "Bond is working..." with blinking dots. No longer used in the main app — thinking UI is now handled inline by MessageBubble's `thinking` message variant. Kept as a standalone component file.

### SessionItem
Single session row used in both active and archived lists inside SessionSidebar. Action button floats over content on hover (no reserved space).
- **Props:** `session: Session`, `active?: boolean`, `archived?: boolean`, `generating?: boolean`, `actionTitle: string`
- **Slot:** default — action button content (icon)
- **Events:** `select()`, `action()`

### SessionSidebar
Left sidebar with session list, archive flyout, and bottom nav (Projects, Media). Chats section is always open (non-collapsible) with archive and new-chat buttons in the header.
- **Props:** `sessions: Session[]`, `archivedSessions: Session[]`, `activeSessionId: string | null`, `activeView: AppView`, `generatingTitleId: string | null`, `busySessionIds: Set<string>`, `mediaCount: number`, `projectCount: number`
- **Events:** `select(id)`, `create()`, `archive(id)`, `unarchive(id)`, `remove(id)`, `removeArchived()`, `projects()`, `media()`, `rename(id, title)`

### ProjectDetail
Shared project detail component used by both ProjectsView and ProjectPanelView. Displays type badge, deadline badge, goal, interactive resource management (add form, click-to-open, remove), and interactive todo management (inline add, checkboxes, delete). Owns its own todo state via `window.bond`.
- **Props:** `project: Project`, `compact?: boolean` (tighter spacing for panel use)
- **Events:** `addResource(projectId, kind, value, label?)`, `removeResource(projectId, resourceId)`, `updateDeadline(projectId, deadline)`

### ProjectsView
Main content area view for projects. Shows a project list (cards) or a `ProjectDetail` for the selected project. Includes archive flyout, creation wizard, and project menu (archive/delete).
- **Props:** `projects: Project[]`, `archivedProjects: Project[]`, `activeProjectId: string | null`, `insetStart?: boolean`
- **Events:** `select(id)`, `create(name, goal, type, deadline)`, `archive(id)`, `unarchive(id)`, `remove(id)`, `addResource(projectId, kind, value, label?)`, `removeResource(projectId, resourceId)`, `updateDeadline(projectId, deadline)`, `startChat(projectId)`, `back()`
- **Slots:** `header-start`, `header-end`

### ProjectPanelView
Project list/detail panel for the right side of chat. Shows project list or `ProjectDetail` (compact) for the selected project. Full feature parity with the main view.
- **Props:** `projects: Project[]`, `activeProjectId: string | null`
- **Events:** `select(id | null)`, `startChat(projectId)`, `addResource(projectId, kind, value, label?)`, `removeResource(projectId, resourceId)`

### ProjectWizard
Multi-step project creation wizard (name → goal → type + deadline). Full-screen overlay.
- **Events:** `submit(name, goal, type, deadline)`, `cancel()`

### CopyButton
Inline copy-to-clipboard button with checkmark confirmation feedback.
- **Props:** `value: string`

### SettingsView
Settings panel with accent color picker (8 presets + custom), default model selector, and personality/soul text editor. No props — reads/writes via `window.bond` directly.

### DesignSystemView
Interactive design token showcase. Displays color swatches, typography, radius, shadows, transitions, and spacing values. Reads computed styles from `:root`. No props.

### AboutView
In-app reference screen showing Bond's architecture (layered stack diagram), agent tools, edit modes, data paths, and CLI commands. Accessible from the sidebar gear menu.

### BrowserView
Tabbed in-app browser embedded in the right panel. Includes tab bar, navigation bar (back/forward/reload/URL/star/external), webview-per-tab rendering, new-tab page with favorites grid, and integrated DevTools panel. Links in chat open here by default (Cmd+Click for system browser). Agent controls it via `bond browser` CLI.
- **Emits:** `openExternal(url: string)`
- **Expose:** `openUrl(url: string)` — opens a URL in the browser panel
- **Keyboard:** `⌘T` opens new tab (when browser panel is active), `⇧⌘K` toggles panel

### BrowserDevTools
Console and Network inspection panel, shown in a vertical split below the webview. Console tab shows log entries with level filtering and a JS evaluation input. Network tab shows requests in a table (method, URL, status, type, size, time).

### SenseView
Main Sense timeline view. Two-zone vertical layout: header with day nav + search, detail viewer in the body, and a bottom dock with app legend + density bar timeline. Loads the current day's captures on mount.
- **Props:** `insetStart?: boolean`
- **Slots:** `header-start`

### SenseDayNav
Date navigation in the SenseView header. Shows formatted date with prev/next arrows and a hidden native date picker.
- **Props:** `date: string`, `isToday: boolean`, `captureCount: number`, `sessionCount: number`
- **Events:** `prev()`, `next()`, `pick(date: string)`

### SenseTimeline
Core density bar scrubber. Divides the day into 1440 minute-buckets, renders visible range as vertical bars (height = capture density, color = dominant app). Supports scroll-to-scrub (mouse wheel), keyboard nav (Left/Right, Shift+arrows for session boundaries), click-to-select, and hover preview tooltip.
- **Props:** `captures: SenseCapture[]`, `sessions: SenseSession[]`, `activeCaptureId: string | null`, `appFilter: string | null`
- **Events:** `select(id: string)`

### SenseDetail
Screenshot viewer above the timeline. Shows the selected capture's image (object-fit contain), metadata bar (app name, window title, time, trigger badge, ambiguity warning), and collapsible extracted text panel. Has states for loading, purged, and empty.
- **Props:** `capture: SenseCapture | null`, `image: string | null`, `loadingImage: boolean`

### SenseAppLegend
Horizontal strip of colored chips for the top 8 apps active that day. Click a chip to filter the timeline to that app; click again to clear.
- **Props:** `apps: AppSummary[]`, `activeFilter: string | null`
- **Events:** `filter(bundleId: string)`

### SenseSearch
Inline search input in the header bar. Debounced 300ms text search with results in a BondFlyoutMenu dropdown. Each result shows app name, time, and highlighted text excerpt.
- **Props:** `results: SenseCapture[]`, `query: string`
- **Events:** `search(query: string)`, `select(capture: SenseCapture)`, `clear()`
- **Expose:** `focus()`

### OperativesView
Main view for listing operatives with status indicators, filter tabs, and action buttons.
- **Props:** `operatives: Operative[]`, `activeOperativeId: string | null`, `insetStart?: boolean`
- **Events:** `select(id)`, `cancel(id)`, `remove(id)`, `clear()`, `back()`
- **Slots:** `header-start`

### OperativeDetail
Detail panel for a selected operative. Shows status header, prompt, and streaming activity feed (tool calls, text, errors, results).
- **Props:** `operative: Operative`, `events: OperativeEvent[]`
- **Events:** `cancel(id)`, `remove(id)`, `back()`

### DevComponents
Dev-only component catalog with live previews and prop/event documentation. Accessible from the Settings window Components tab. Not rendered in production flows.

## Composables

### useChat(deps)
All chat state and logic. Handles message streaming, persistence, tool approvals, thinking message lifecycle, and HMR-safe state preservation. On submit, creates a thinking message immediately (Working state). Thinking deltas from the API accumulate into it (Thinking state). When the first non-thinking chunk arrives, it finalizes with duration (Thought state) or is removed if no thinking text was received.
- **State:** `messages`, `busy`, `currentSessionId`
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

### useProjects(deps?)
Project CRUD, archive/unarchive, resources. Persists active project ID to localStorage.
- **State:** `projects`, `activeProjectId`, `activeProject`, `activeProjects`, `archivedProjects`, `loading`
- **Methods:** `load()`, `create(name, goal?, type?, deadline?)`, `select(id)`, `archive(id)`, `unarchive(id)`, `update(id, updates)`, `remove(id)`, `addResource(projectId, kind, value, label?)`, `removeResource(projectId, resourceId)`, `updateLocal(id, updates)`

### useAppView()
View routing state. Persists to localStorage.
- **State:** `activeView` (`'chat' | 'projects' | 'media'`)

### useBrowser()
Singleton browser tab state. Manages tabs, favorites, console/network logs. Persists tabs and favorites to localStorage. Handles agent commands from the IPC bridge.
- **State:** `tabs`, `activeTabId`, `activeTab`, `favorites`, `consoleLogs`, `networkLogs`
- **Methods:** `createTab(url?)`, `closeTab(id)`, `closeAllTabs()`, `switchTab(id)`, `navigate(id, url)`, `updateTab(id, updates)`, `addFavorite(url, title, favicon)`, `removeFavorite(url)`, `isFavorite(url)`, `addConsoleEntry()`, `addNetworkEntry()`, `getConsoleLog()`, `getNetworkLog()`

### useSense()
Singleton Sense timeline state. Loads a day's captures and sessions, selects individual captures with image fetching, text search, and app filtering. Normalizes snake_case DB rows to camelCase.
- **State:** `date`, `captures`, `sessions`, `activeCapture`, `activeCaptureImage`, `searchQuery`, `searchResults`, `appFilter`, `apps`, `loading`, `loadingImage`, `filteredCaptures`, `isToday`
- **Methods:** `loadDay(dateStr)`, `selectCapture(id)`, `search(query)`, `setAppFilter(bundleId?)`, `nextDay()`, `prevDay()`, `jumpToCapture(capture)`
- **Exports:** `appHue(identifier)`, `appColor(identifier, isDark?)` — deterministic HSL color from bundle ID

### useOperatives()
Singleton operative list state. Loads on mount, subscribes to operative.changed for live updates.
- **State:** `operatives`, `activeOperativeId`, `activeOperative`, `runningOperatives`, `queuedOperatives`, `runningCount`, `loading`
- **Methods:** `load()`, `spawn(opts)`, `cancel(id)`, `remove(id)`, `clear()`, `select(id)`

### useOperativeEvents(operativeId: Ref<string | null>)
Streams events for a specific operative. Loads initial events and appends from operative.event notifications.
- **State:** `events`, `loading`

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
- **Layout:** `--toolbar-height` (2.25rem / 36px)
- **Fonts:** `--font-sans` (Inter stack), `--font-mono` (SF Mono stack)
- **Sidebar:** Separate token set (`--sidebar-border`, `--sidebar-text`, `--sidebar-hover-bg`, etc.) using rgba for transparency-based theming

## Message Types

```typescript
type Message =
  | { id, role: 'user', text, images?: AttachedImage[], imageIds?: string[] }
  | { id, role: 'bond', text, streaming: boolean }
  | { id, role: 'meta', kind: 'tool', name, summary? }
  | { id, role: 'meta', kind: 'skill', name, args? }
  | { id, role: 'meta', kind: 'thinking', text, durationSec?, streaming: boolean }
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

## Image Storage

Attached images are stored as permanent files in `~/Library/Application Support/bond/images/{uuid}.{ext}`. Metadata lives in the `images` SQLite table.

```sql
images (id TEXT PK, session_id TEXT FK, filename TEXT, media_type TEXT, size_bytes INT, created_at TEXT)
```

**Flow**: Renderer sends `AttachedImage[]` (base64) → daemon's `bond.send` handler saves files via `images.ts`, returns `imageIds` → renderer swaps inline images for IDs → `messages.images` column stores `["uuid-1", "uuid-2"]` (ID array, not base64).

**Retrieval**: `image.get` and `image.getMultiple` JSON-RPC methods read files from disk and return base64. The renderer resolves IDs on session load via `window.bond.getImages()`.

**Cleanup**: `deleteSession()` calls `deleteSessionImages()` to remove files before CASCADE deletes DB rows.
