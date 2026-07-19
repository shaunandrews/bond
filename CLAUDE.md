# Bond — Development Instructions

## Commands

```bash
npm run dev            # Build daemon, then launch the Electron app with renderer hot-reload
npm run build          # Full build: electron-vite (main/preload/renderer) + daemon (esbuild) + native helpers
npm run build:daemon   # Bundle the daemon only → out/daemon/main.mjs (esbuild)
npm run build:web      # Build the browser bundle for remote (LAN) access → out/web (vite.web.config.ts)
npm run build:cli      # Bundle bin/bond CLI subcommands → out/cli/*.js (esbuild)
npm run build:native   # Compile the Obj-C Sense helpers → out/daemon/bin/sense/ (macOS only)
npm run test:run       # Run the whole test suite once
npx vitest run src/renderer/composables/useChat.test.ts   # Run a single test file
npx vitest run -t "streams thinking deltas"               # Run tests matching a name
npx vue-tsc --noEmit   # Typecheck the project incl. .vue call sites (no lint tooling is configured)
```

The daemon is a **separate long-lived process**, not part of the Vite dev server. `npm run dev` hot-reloads the renderer but **not** the daemon — after changing anything under `src/daemon/` or `src/shared/`, rebuild and restart it. Skills are cached at daemon startup, so new or edited skills also require a daemon restart. **Web client changes (`src/renderer/web/`) need NO daemon restart** — run `npm run build:web` and refresh the browser; the daemon serves `out/web` from disk per request. Use the `bin/bond` CLI to manage it during development:

```bash
bin/bond status          # Who is serving (via GET /health on the socket), strays, bundle freshness
bin/bond dev             # Stop daemon, rebuild it, then run electron-vite dev
bin/bond rebuild daemon  # Rebuild daemon, then supervised restart — after daemon/shared changes
bin/bond restart         # Supervised restart (launchctl kickstart) without rebuilding
bin/bond log             # Tail ~/.bond/daemon.log
```

`bin/bond start` runs the daemon under **launchd supervision** (`~/Library/LaunchAgents/com.bond.daemon.plist`, `KeepAlive`/`SuccessfulExit=false`): a crash or stray kill (nonzero exit) resurrects within ~5s and remote clients auto-reconnect, while voluntary exits stay down. `bin/bond stop` boots the agent out AND kills every daemon process, so an intentional stop stays stopped. `bin/bond restart` is safe to run from inside a Bond conversation: launchd completes the restart even though the calling bash process dies with the daemon.

**Single-instance enforcement** lives in `src/daemon/lifecycle.ts`, never in pid files (a pid file can only name one process — it once hid fifteen zombie daemons). Three layers: (1) startup **claim** — socket takeover is serialized through an O_EXCL start lock and gated on a live-connection probe, so a second starter bows out (exit 0) and only a provably dead socket file is ever unlinked; (2) **watchdog** — the daemon remembers the bound socket file's dev+ino and exits if the path vanishes or changes, so an orphaned daemon can never linger; (3) **health** — `GET /health` on the unix socket reports the serving pid and the loaded bundle's mtime, which `bin/bond status` compares against `out/daemon/main.mjs` on disk to flag a stale daemon. Tooling that needs "is a daemon running" must probe the socket (the Electron main process does) or enumerate exact command lines, never read `daemon.pid`.

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

Bond uses a daemon architecture. The renderer never talks to Pi (the agent runtime) directly.

```
Renderer (Vue) → Electron IPC → Main Process → WebSocket over Unix socket (JSON-RPC 2.0) → Daemon → Pi → model provider
```

The daemon runs an HTTP + WebSocket server (`ws`) bound to the Unix socket `~/.bond/bond.sock`. `BondClient` (`src/shared/client.ts`) is the shared WebSocket client used by both the main process and the CLI.

**Remote access**: the daemon also listens on TCP `0.0.0.0:3113` (`remote.port` setting; port reserved via Port Keeper), serving the `out/web` browser bundle over HTTP and the same JSON-RPC WebSocket protocol. Browsers on the LAN pair via a URL/QR from Settings → Remote access whose `#t=…` fragment carries a persistent token (`remote.token` setting); the WebSocket auth gate plus a same-origin upgrade check are the security boundary. The web client (`src/renderer/web/`) reuses the renderer components with a browser `window.bond` shim over a native WebSocket. Live multi-device sync rides on three chunks: `turn_start` (mirrors the sender's user message + activity ids on other clients), `approval_resolved` (flips pending approval prompts everywhere), and `edit_mode_changed` (mirrors the global permissions mode). The renderer drops turn-scoped chunks whose `turnId` it doesn't own — a straggler racing a cancel can't mint orphan activity rows. **The web client runs in an insecure context** (plain http on a LAN IP) — secure-context-only APIs (`crypto.randomUUID`, `navigator.clipboard`, service workers) are undefined there; any renderer code the web client can reach needs fallbacks (`uid()` in `useChat.ts` and `lib/clipboard.ts` are the pattern). All agent work runs through **Pi** (`@earendil-works/pi-coding-agent`), which resolves Bond's capability tiers against the user's connected subscription — Bond never calls a provider API directly. Pi session transcripts persist as JSONL under `~/Library/Application Support/bond/pi/sessions/`.

### Daemon (`src/daemon/`)

Standalone Node.js WebSocket server on `~/.bond/bond.sock`. Manages agent queries, sessions, and settings. Persists to SQLite at `~/Library/Application Support/bond/bond.db`.

| File | Purpose |
|------|---------|
| `main.ts` | Entry point — claims the socket, starts servers, watchdog + signal handling |
| `lifecycle.ts` | Single-instance enforcement — socket claim under a start lock, orphan watchdog, `/health` payload |
| `wire-debug.ts` | Wire-level tool visibility — logs every model request's tool manifest (fetch + WebSocket, zstd-aware) |
| `server.ts` | WebSocket server with thin JSON-RPC 2.0 dispatch (`bond.*`, `session.*`, `image.*`, `settings.*`, `skills.*`, `sense.*`, `collection.*`, `web.*`) — turn lifecycle lives in `turns.ts` |
| `turns.ts` | Turn runner — serialized send lifecycle (a new send atomically aborts the running turn), active-turn ownership, broadcast/Sense transport seam |
| `approvals.ts` | The single pending-approval registry — `requestId` resolves, `turnId` scopes bulk clears; clients reconstruct pending prompts from persisted activity rows (no replay) |
| `agent.ts` / `pi/runtime.ts` | Builds Bond context, runs Pi sessions, streams chunks, parks tool approvals via `approvals.ts` |
| `pi/runtime.ts` | Pi session lifecycle, event streaming, edit-mode → tool/permission mapping, Bond memory tool registration, tier resolution, Pi OAuth |
| `memory/service.ts` | Serialized automatic observer persistence + epoch observer/reflector hooks; `enqueueMemoryTask` runs deferred work (incl. epoch-rollover hooks) on the same queue so it never blocks a send |
| `memory/tools.ts` | Bond-owned Pi tools for memory status/search/recall/history and explicit remember/update/forget |
| `memory/store.ts` | Searchable memory CRUD, FTS, and relational source-message provenance |
| `memory/core-memory.ts` | Bounded persistent Core memory in `memory/core.json` |
| `web/tools.ts` | Bond-owned Pi tools `web_search` + `fetch_content` — keyless, zero-config web access with a 15-min cache and polite batch spacing |
| `web/broker.ts` | Render broker — parks tool promises, sends `web.requestRender` to the app, resolves on `web.renderReady`; errors clearly when no app is connected |
| `web/extract.ts` | DuckDuckGo SERP parsing (linkedom) and page → markdown extraction (Readability + Turndown) over app-rendered HTML |
| `remote.ts` | Remote (LAN) access server — TCP listener on `0.0.0.0:3113` serving the `out/web` bundle + WebSocket RPC gated by the persistent pairing token (`remote.token`), same-origin upgrade check, `remote.status` RPC |
| `imagegen.ts` | Bond glue for the bundled `pi-codex-image-gen` Pi extension (`codex_generate_image` — gpt-image-2 via the ChatGPT/Codex subscription already connected in Pi, no API key). Gates the tool on an `openai-codex` OAuth credential, captures generated images into the Bond image store, emits `generated_image` stream chunks, and strips base64 from activity previews. The package's disk writes and install telemetry are disabled via env defaults in `main.ts` |
| `onboarding.ts` | First-run detection, transcript intro seeding, and the staged interview → panel-tour flow (`pending` → `education` → `completed`). Serves stage-specific system-prompt sections and Pi tools: `complete_onboarding` (closes the interview, seeds the soul, returns the tour script), `complete_tour`, `show_panel` (opens a side panel via a `show_panel` stream chunk), and `enable_sense`. The interview and tour are the real agent — no scripted flow |
| `sandbox.ts` | New-user sandbox: swaps the daemon's data dir to a fresh empty directory (and back) so the real app runs a genuine first-run without touching real data |
| `sessions.ts` | SQLite CRUD for sessions and messages |
| `collections.ts` | Collections + items CRUD (SQLite) |
| `debriefs.ts` | Session debrief storage (SQLite) |
| `generate-debrief.ts` | Auto-generates session debriefs (summary + topics) |
| `images.ts` | Image storage — save/get/delete files + `images` table CRUD |
| `db.ts` | Database init, migrations, WAL mode; an UNREADABLE db is quarantined (renamed `.corrupt-<ts>`, Pi sessions/images untouched) — only a readable stale-version db takes the clean-cutover wipe |
| `settings.ts` | Key-value settings storage (soul, model, accent color) |
| `paths.ts` | Data directory resolution |
| `index.ts` | Daemon library exports |
| `skills.ts` | Skill scanning from ~/.bond/skills/ |
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

Electron main process. Spawns daemon if not running, creates window, proxies all IPC to the daemon via `BondClient`. On daemon restart it reconnects the **same** `BondClient` instance in place (the auth token is read through a provider on every attempt), so registered push listeners — chunk streaming, Sense, web renders, tray — survive `bin/bond rebuild daemon` without an app relaunch. Builds the native application menu, including **Bond → Run/Exit New-User Simulation** (⌘⌥N) which toggles the daemon's sandbox data set and reloads the window — the real app then boots into a genuine first-run. In packaged mode (`app.isPackaged`), resolves the daemon from `process.resourcesPath/daemon/`, finds Node.js via login shell + well-known paths, and resolves the full user PATH (login shell + fallback) so the daemon can find user-installed binaries like `studio`. Also handles Sense screenshot capture (`src/main/sense.ts` — `desktopCapturer` + `NativeImage.toJPEG`), the web render host (`src/main/web.ts` — a persistent hidden `BrowserWindow` that serves the daemon's `web.requestRender` requests so `web_search`/`fetch_content` get real-Chromium rendered HTML with no API keys), tray indicator (`src/main/tray.ts`).

### Preload (`src/preload/index.ts`)

Exposes `window.bond` via `contextBridge`. The ~74 pure daemon proxies come from `buildDaemonSurface` in `src/shared/bond-surface.ts` riding ONE generic `bond:rpc` IPC channel (allowlisted against `RPC_METHOD_NAMES` in main); the 27 Electron-local members (native menus, fs reads, window management, event registrars, and the three settings proxies with main-side broadcasts) are hand-written and typed by `ElectronBondSurface`, which also forces the web shim to acknowledge every one. Protocol skew between app and daemon hard-fails with a "daemon out of date" dialog (desktop) or a `mismatch` banner (web) — the version rides `/health`, `bond.auth`, and `bond.ping`.

### Shared (`src/shared/`)

| File | Purpose |
|------|---------|
| `protocol.ts` | JSON-RPC 2.0 types and helpers + `PROTOCOL_VERSION` (bump on any breaking rpc-schema change; equality = compatibility) |
| `rpc-schema.ts` | **Single source of truth for the RPC contract** — `RpcMethods` (per-method params/result), `RpcNotifications`, `RPC_METHOD_NAMES`; server handlers, both clients, preload, and the shim all derive from it, so contract drift is a compile error |
| `bond-surface.ts` | The `window.bond` surface builder — `buildDaemonSurface(invoke)` generates the ~74 daemon proxies from the registry; `ElectronBondSurface` declares the 27 main-process-local members the shim must explicitly stub |
| `stream.ts` | `BondStreamChunk` union type (text, thinking, tool, approval, error, system) |
| `client.ts` | `BondClient` WebSocket client class — registry-typed `call`, token provider, reconnect-in-place, `daemonProtocolVersion` |
| `session.ts` | Session, SessionMessage, EditMode, AttachedImage, Collection, and media/collection types |
| `sense.ts` | SenseSession, SenseCapture, SenseSettings, SenseState, DetectedWindow, OcrResult, AccessibilityResult types |
| `models.ts` | `ModelId` — provider-neutral capability tiers (`'high' | 'balanced' | 'fast'`); Pi maps them to concrete models |
| `web.ts` | `WebRenderRequest`/`WebRenderResult` — the daemon ↔ app hidden-browser render round-trip |

### CLI (`bin/bond`)

`bin/bond` is a bash wrapper for daemon lifecycle (`status`/`start`/`stop`/`restart`/`dev`/`rebuild`/`log`/`build`) plus thin Node entrypoints that connect to the daemon over the socket. The Node subcommands are bundled by `npm run build:cli` into `out/cli/` and rebuilt on demand: `media`, `sense`, `soul`, `collection`, `screenshot`. Their sources live in `src/cli/` (`connect.ts` handles the Pi auth connect flow). See the "Commands" section above for the common daemon workflows.

## Project Structure

```
bin/bond                             # CLI for daemon management
scripts/
  build-native-helpers.sh            # Compiles Obj-C native helpers → out/daemon/bin/sense/
src/
  cli/
    media.ts                         # bond media — CLI for media management
    screenshot.ts                    # bond screenshot — capture Bond window
    sense.ts                         # bond sense — CLI for Sense ambient awareness
  native/
    window-helper.m                  # CGWindowList native helper (Obj-C)
    ocr-helper.m                     # Apple Vision OCR native helper (Obj-C)
    accessibility-helper.m           # AXUIElement tree walker native helper (Obj-C)
  daemon/
    main.ts                          # Daemon entry point
    server.ts                        # WebSocket JSON-RPC server (thin dispatch)
    turns.ts                         # Turn runner — serialized send lifecycle
    approvals.ts                     # Single pending-approval registry
    agent.ts                         # Bond prompt and Pi runtime entrypoint
     pi/runtime.ts                    # Pi session, event, and permission bridge
    sessions.ts                      # Session CRUD (SQLite)
    images.ts                        # Image file storage + images table
    imagegen.ts                      # Glue for the bundled codex_generate_image Pi tool
    db.ts                            # Database management + migrations
    settings.ts                      # Settings storage
    paths.ts                         # Data directory paths
    skills.ts                        # Skill scanning from ~/.bond/skills/
    remote.ts                        # Remote (LAN) access — static bundle + WebSocket RPC on TCP 3113
    web/
      tools.ts                       # web_search + fetch_content Pi tools (keyless, cached)
      broker.ts                      # Render broker for the app's hidden browser window
      extract.ts                     # DDG SERP parsing + Readability/Turndown markdown
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
    web.ts                           # Hidden-browser render host for daemon web tools
  preload/index.ts                   # contextBridge API
  shared/
    protocol.ts                      # JSON-RPC 2.0 types + PROTOCOL_VERSION
    rpc-schema.ts                    # Typed RPC method/notification registry (the wire contract)
    bond-surface.ts                  # window.bond surface builder (preload + shim derive from it)
    stream.ts                        # BondStreamChunk types (incl. thinking_text)
    client.ts                        # BondClient WebSocket client
    session.ts                       # Session, SessionMessage, Collection, CollectionItem, EditMode, AttachedImage types
    sense.ts                         # SenseSession, SenseCapture, SenseSettings, DetectedWindow, OcrResult types
    models.ts                        # ModelId type
    web.ts                           # WebRenderRequest/WebRenderResult render round-trip types
  renderer/
    App.vue                          # Root shell — panel layout + view routing
    web/
      index.html                     # Browser entry served by the daemon's remote server
      main.ts                        # Installs the window.bond shim, mounts WebApp
      WebApp.vue                     # Single-column phone-friendly chat (reuses MessageBubble/ChatInput/ApprovalPrompt)
      client.ts                      # WebBondClient — JSON-RPC over native WebSocket, pairing token, reconnect
      shim.ts                        # window.bond built on WebBondClient; Electron-only methods become no-ops
    ViewerWindow.vue                 # Markdown file viewer window
    app.css                          # Tailwind v4 theme tokens
    types/message.ts                 # Message union type
    types/webview.d.ts               # Electron webview element types
    composables/
      useChat.ts                     # Continuous transcript state, streaming, message persistence
      useAutoScroll.ts               # Smart scroll-to-bottom
      useAccentColor.ts              # Dynamic accent color theming
      useSense.ts                    # Sense timeline state, day loading, capture selection, search
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
      ApprovalPrompt.vue             # Tool approval prompt stacked above the composer
      MessageBubble.vue              # Renders message variants incl. turn activity
      TurnActivity.vue               # Unified in-chat turn activity timeline
      MarkdownMessage.vue            # Markdown with syntax highlighting + copy
      ThinkingIndicator.vue          # Standalone "Bond is working..." dots (unused, kept for reference)
      MediaView.vue                  # Image gallery view
      CopyButton.vue                 # Inline copy-to-clipboard button
      MissionBriefing.vue            # Empty transcript welcome screen
      SettingsView.vue               # Accent color, model, personality settings
      AboutView.vue                  # Architecture, tools, data paths, CLI reference
      DesignSystemView.vue           # Live design token browser
      SenseView.vue                  # Sense timeline main view (day nav + detail + timeline dock)
      SenseDayNav.vue                # Date navigation (prev/next/picker)
      SenseTimeline.vue              # Density bar scrubber with playhead and hover preview
      SenseDetail.vue                # Screenshot viewer with metadata and extracted text
      SenseAppLegend.vue             # App color legend with filter chips
      SenseSearch.vue                # Inline search with results flyout
      MemoryView.vue                 # Core/working/search/source memory panel
      DevComponents.vue              # Dev-only component catalog
    lib/highlight.ts                 # highlight.js language registration
    lib/clipboard.ts                 # copyToClipboard with insecure-context fallback
electron.vite.config.ts                  # Build config (main, preload, renderer)
vite.web.config.ts                       # Browser bundle build for remote access → out/web
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
Teleported flyout menu primitive. Renders via `<Teleport to="body">` with fixed positioning relative to an anchor element. Auto-flips when the menu would overflow the viewport, clamps horizontally, and repositions on scroll/resize. Used by BondSelect and similar anchored menus.
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
Unified composer combining textarea, attachments, context usage, reasoning and permissions settings, and send/stop actions. Auto-focuses after response completes.
- **Props:** `busy: boolean`, `model: ModelId`, `editMode: EditMode`, `contextUsage?: { inputTokens, contextWindow, costUsd }`
- **Events:** `submit(text: string, images: AttachedImage[])`, `cancel()`, `update:model(value: ModelId)`, `update:editMode(value: EditMode)`
- Single bordered container with textarea on top and a toolbar row below. A sliders icon immediately left of the send/stop actions opens one top-aligned menu with Reasoning (high/balanced/fast) and Permissions (readonly/scoped/full) sections. Attach opens the native jpeg/png/gif/webp picker. Image thumbnails appear above the textarea. Scoped permission mode shows a paths input.

### ApprovalPrompt
Focused tool approval request stacked above ChatInput while leaving the normal composer usable. Shows the tool, description, and a formatted command/path/input preview.
- **Props:** `requestId: string`, `toolName: string`, `input: Record<string, unknown>`, `description?: string`, `context?: string` (background context)
- **Events:** `respond(requestId: string, approved: boolean)`

### MessageBubble
Renders all message variants based on the `Message` union type. Delegates markdown to MarkdownMessage and turn activity rows to TurnActivity. User messages render attached images above text. Generated images (`meta`/`image`) render start-aligned with a loading placeholder until their base64 resolves.
- **Props:** `msg: Message` — role/kind determines which variant renders
- **Events:** `approve(requestId: string, approved: boolean)` — emitted from approval controls inside turn activity

### TurnActivity
Unified turn activity row persisted as one `meta/activity` message per user turn. Compact row streams current status; expansion shows chronological thinking text, tool input/output previews, timings, approvals, and errors. Completed rows collapse to a small summary. Failures and approval requests set `expanded: true` automatically. Full details live in `SessionMessage.data` and the `messages.data` JSON column.
- **Props:** `data: TurnActivityData`
- **Events:** `approve(requestId: string, approved: boolean)`

### MarkdownMessage
Renders markdown with syntax highlighting and copy-to-clipboard code blocks. Uses marked.js, DOMPurify, and highlight.js.
- **Props:** `text: string`, `streaming: boolean`
- Throttled rendering during streaming. External links open via `window.bond.openExternal()`.

### ThinkingIndicator
Standalone animated "Bond is working..." with blinking dots. No longer used in the main app — live turn status is handled by TurnActivity. Kept as a standalone component file.


### CopyButton
Inline copy-to-clipboard button with checkmark confirmation feedback.
- **Props:** `value: string`

### SettingsView
Settings panel with accent color picker (8 presets + custom), default model selector, and personality/soul text editor. No props — reads/writes via `window.bond` directly.

### DesignSystemView
Interactive design token showcase. Displays color swatches, typography, radius, shadows, transitions, and spacing values. Reads computed styles from `:root`. No props.

### AboutView
In-app reference screen showing Bond's architecture (layered stack diagram), agent tools, edit modes, data paths, and CLI commands. Accessible from the sidebar gear menu.

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

### MemoryView
Right-panel memory view for inspecting and editing Bond memory.
- **Tabs:** Core, Working, Search, Source
- **Core:** stable facts, preferences, and decisions persisted to `memory/core.json`
- **Working:** current scratchpad goal, facts, preferences, decisions, and open threads
- **Search:** memory item search with inline edit/delete controls
- **Source:** source messages attached to a selected memory item

### DevComponents
Dev-only component catalog with live previews and prop/event documentation. Accessible from the Settings window Components tab. Not rendered in production flows.

## Composables

### useChat(deps)
All continuous transcript state and logic. Handles message streaming, persistence, tool approvals, turn activity, and HMR-safe state preservation. On submit, creates one `meta/activity` message for the turn. Thinking/tool/result/approval chunks update that activity message's `data.events`; assistant text still streams into normal Bond messages. Pending approvals are exposed separately so App can stack approval prompts above the composer while normal input remains usable.
- **State:** `messages`, `busy`, `currentSessionId`, `pendingApprovals`
- **Methods:** `submit()`, `cancel()`, `respondToApproval()`, `subscribe()`, `unsubscribe()`, `loadSession()`, `clearMessages()`, `persistMessages()`


### useAutoScroll(containerRef)
Smart scroll-to-bottom for streaming content. Uses MutationObserver and ResizeObserver.
- **State:** `isAtBottom`
- **Methods:** `scrollToBottom()`

### useAccentColor()
Dynamic accent color theming. Derives a full palette from a single hex color (HSL-based tinting for backgrounds, borders, and text).
- **State:** `accent`, `defaultAccent`
- **Methods:** `load()`, `setAccent()`, `reset()`


### useSense()
Singleton Sense timeline state. Loads a day's captures and sessions, selects individual captures with image fetching, text search, and app filtering. Normalizes snake_case DB rows to camelCase.
- **State:** `date`, `captures`, `sessions`, `activeCapture`, `activeCaptureImage`, `searchQuery`, `searchResults`, `appFilter`, `apps`, `loading`, `loadingImage`, `filteredCaptures`, `isToday`
- **Methods:** `loadDay(dateStr)`, `selectCapture(id)`, `search(query)`, `setAppFilter(bundleId?)`, `nextDay()`, `prevDay()`, `jumpToCapture(capture)`
- **Exports:** `appHue(identifier)`, `appColor(identifier, isDark?)` — deterministic HSL color from bundle ID

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
  | { id, role: 'meta', kind: 'thinking', text, durationSec?, streaming: boolean } // legacy persisted rows only
  | { id, role: 'meta', kind: 'activity', data: TurnActivityData }
  | { id, role: 'meta', kind: 'image', imageIds: string[], images?: AttachedImage[], alt? } // generated images (codex_generate_image)
  | { id, role: 'meta', kind: 'error', text }
  | { id, role: 'meta', kind: 'approval', requestId, toolName, input, title?, description?, status: 'pending' | 'approved' | 'denied' }
  | { id, role: 'meta', kind: 'system', text }
```

## Edit Modes

Bond supports three edit modes that control which Pi tools are available for the current turn:

```typescript
type EditMode =
  | { type: 'full' }                              // All tools (Read, Write, Edit, Bash, etc.)
  | { type: 'readonly' }                           // Read, Glob, Grep only
  | { type: 'scoped', allowedPaths: string[] }     // Read/write restricted to specific paths
```

Edit mode is **one global, daemon-persisted setting** (`edit_mode`, validated through `parseEditMode` in `shared/session.ts`): loaded into the composer at boot on every surface (desktop, web, quick chat), applied per-turn via `BondSendInput.editMode`, and mirrored live to all clients through the `edit_mode_changed` chunk when any device changes it. `agent.ts` builds Bond's system prompt; `pi/runtime.ts` maps each edit mode to Pi's tool and permission configuration.

## Image Storage

Attached images are stored as permanent files in `~/Library/Application Support/bond/images/{uuid}.{ext}`. Metadata lives in the `images` SQLite table.

```sql
images (id TEXT PK, session_id TEXT FK, filename TEXT, media_type TEXT, size_bytes INT, created_at TEXT)
```

**Flow**: Renderer sends `AttachedImage[]` (base64) → daemon's `bond.send` handler saves files via `images.ts`, returns `imageIds` → renderer swaps inline images for IDs → `messages.images` column stores `["uuid-1", "uuid-2"]` (ID array, not base64).

**Retrieval**: `image.get` and `image.getMultiple` JSON-RPC methods read files from disk and return base64. The renderer resolves IDs on session load via `window.bond.getImages()`.

**Cleanup**: `deleteSession()` calls `deleteSessionImages()` to remove files before CASCADE deletes DB rows.
