# Bond-on-the-Go — Global Quick Chat

Summon Bond from anywhere with a global keyboard shortcut. A floating panel appears in the bottom-right corner of the screen — widget-style — with a seamless radial blur that fades into the desktop. Full Sense context from the last few minutes is injected automatically. Every invocation starts a fresh chat. On dismiss, the session auto-titles and auto-archives.

**Prototype**: `plans/bond-on-the-go-prototype.html` (copy from `/tmp/bond-quick-chat-prototype.html`)

---

## Core UX

1. **Summon**: User presses global shortcut (default: `⌘+Shift+Space`) from any app
2. **Appear**: A frameless panel fades in at the bottom-right of the screen, widget-style. A seamless radial blur emanates from the panel area and dissolves into the desktop — no hard edges, no visible window boundary. The blur picks up the colors of whatever wallpaper is behind it
3. **Sense context**: The daemon already injects 5-minute sense context into the system prompt automatically. For the UI, the main process fetches `sense now` to show a brief context indicator ("Watching: Figma, VS Code") — but the actual chat context comes from the daemon's existing mechanism
4. **Chat**: User types a question. Bond responds. Multi-turn — keep talking as long as the panel is open
5. **Dismiss**: Escape key or toggle shortcut again. Panel fades out, blur dissolves
6. **Cleanup**: On dismiss, cancel any active response, auto-generate title, save session with `quick: true` tag, auto-archive. These never linger in the active session list

---

## Visual Design

- **Frameless**: No title bar, no traffic lights. Pure content
- **Widget-style positioning**: Bottom-right corner of the screen, ~380px wide, ~68% of workArea height. Positioned at `bottom: 20px, right: 12px` within the display's workArea. Feels like a native macOS widget panel
- **Seamless radial blur**: The blur effect radiates outward from the panel center with no hard edges. Implemented with `vibrancy: 'under-window'` + `visualEffectState: 'active'` on the BrowserWindow. The window itself is `transparent: false` — vibrancy provides the frosted glass. No shadow (`hasShadow: false`), no visible window border. The blur should feel like it's part of the desktop, not a rectangle sitting on top of it
- **Appearance animation**: Fade in + subtle scale up (`scale(0.97)` → `scale(1)`) — not a slide. The panel materializes in place. On dismiss, reverse the animation
- **No hard edges**: The window has no visible boundary. macOS provides native rounded corners. The content floats on the blurred desktop with no border, no outline, no shadow. The blur itself is the only visual indicator of the panel's presence
- **Minimal chrome**: Just a chat thread and input bar. No sidebar, no session title, no header. A small sense context indicator at the top ("Watching: Figma, VS Code — last 5 min")
- **Same design tokens**: Uses Bond's existing color tokens and fonts. User message bubbles use `rgba(255,255,255,0.08)` background (not solid `--color-surface`) to let the vibrancy show through

---

## Architecture

### Main Process

#### Chunk routing refactor (prerequisite)

Currently `client.onChunk` at `src/main/index.ts:216` forwards all chunks exclusively to `mainWindow`. Quick chat needs chunks too. Before building quick chat, refactor to a window router:

```ts
// src/main/window-router.ts
const sessionWindows = new Map<string, BrowserWindow>()

export function registerSessionWindow(sessionId: string, win: BrowserWindow): void
export function unregisterSession(sessionId: string): void
export function routeChunk(chunk: TaggedChunk): void  // sends to correct window by sessionId
export function broadcast(channel: string, ...args: any[]): void  // all windows (for todoChanged, etc.)
```

The `onChunk` handler inspects `chunk.sessionId` and routes to the registered window. Entity change events (`onTodoChanged`, `onProjectsChanged`, etc.) broadcast to all windows. This is a structural improvement that benefits any future multi-window work.

#### New module: `src/main/quick-chat.ts`

Exports:
- `initQuickChat(client: BondClient): void` — registers global shortcut, creates the BrowserWindow
- `destroyQuickChat(): void` — unregisters shortcut, destroys window

BrowserWindow config:
```ts
const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
const { x: wx, y: wy, width: ww, height: wh } = display.workArea
const panelWidth = 380
const panelHeight = Math.round(wh * 0.68)

new BrowserWindow({
  width: panelWidth,
  height: panelHeight,
  x: wx + ww - panelWidth - 12,       // 12px from right edge of workArea
  y: wy + wh - panelHeight - 20,      // 20px from bottom of workArea
  frame: false,
  vibrancy: 'under-window',
  visualEffectState: 'active',
  alwaysOnTop: true,
  skipTaskbar: true,
  show: false,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  hasShadow: false,
  webPreferences: {
    preload: join(__dirname, '../preload/index.mjs'),
    contextIsolation: true,
    sandbox: false
  }
})
```

**Global shortcut**: `globalShortcut.register('CommandOrControl+Shift+Space', toggle)`. Re-register on `powerMonitor.on('resume')` and `screen.on('display-added')` / `screen.on('display-removed')` to survive sleep/wake and display changes.

Toggle function:
1. If panel is visible → dismiss
2. If panel is hidden:
   a. Reposition to current display's bottom-right corner (multi-monitor)
   b. Create a new session via `client.createSession()`
   c. Register session→window mapping in the chunk router
   d. Fetch `client.senseNow()` for the UI context indicator
   e. Send session ID + sense summary to renderer via IPC
   f. Show the window, focus the input

**Dismiss trigger**: Escape key (handled in renderer) and toggle shortcut. No blur-based dismiss — too fragile (Spotlight, notifications, system dialogs all trigger blur). Escape + toggle is reliable and predictable.

**Dismiss flow**:
1. If a response is streaming, call `client.cancel(sessionId)` first and wait for it to complete
2. Send dismiss signal to renderer (triggers fade-out animation)
3. After animation completes (~200ms), renderer signals back
4. Main process hides the window
5. Unregister session from chunk router
6. Check message count — if empty, delete the session. Otherwise: `client.generateTitle(sessionId)` then `client.updateSession(sessionId, { archived: true, quick: true })`

**Debounce**: Ignore shortcut presses within 300ms of each other to prevent animation glitches during rapid toggle.

### Session schema change

Add `quick` boolean to the Session type and DB:

- `src/shared/session.ts` — add `quick?: boolean` to `Session` interface
- `src/daemon/db.ts` — migration to add `quick` column (INTEGER DEFAULT 0)
- `src/daemon/sessions.ts` — include `quick` in update handler's allowed fields
- `src/shared/client.ts` — add `quick` to `updateSession` type signature

Sessions tagged `quick: true` and `archived: true` never clutter the sidebar. Could filter them in the archive flyout later, or show them in a separate "Quick Chats" group.

### Renderer — v1: query parameter approach

For v1, skip the separate Vite entry point. Load the same `index.html` with `?mode=quick-chat`. In `App.vue`, detect the mode and render `QuickChat.vue` instead of the full app shell. This shares all composables, component registrations, design tokens, and the existing `useChat` infrastructure.

If startup feels slow due to the full bundle, optimize into a separate entry point in v2.

**`QuickChat.vue`** structure:
```
<div class="quick-chat">
  <!-- Context indicator -->
  <div class="context-bar" v-if="senseApps.length">
    Watching: {{ senseApps.join(', ') }}
  </div>

  <!-- Messages — reuse existing message rendering -->
  <div class="messages" ref="messagesRef">
    <MessageBubble v-for="msg in messages" :message="msg" />
  </div>

  <!-- Input — reuse ChatInput -->
  <ChatInput
    :busy="busy"
    :model="currentModel"
    :edit-mode="{ type: 'full' }"
    @send="handleSend"
    @cancel="handleCancel"
    autofocus
  />
</div>
```

`ChatInput` props: `model` comes from `client.getModel()` on mount. `editMode` is always `{ type: 'full' }`. Skill autocomplete via `/` works for free through the existing preload bridge.

Escape key handling: `ChatInput` already handles Escape for cancel — need to also wire it to dismiss when not busy.

### Daemon — No new RPC methods

Everything uses existing APIs:
- `session.create` — new session
- `bond.send` — chat (daemon auto-injects sense context via existing `runBondQuery` mechanism)
- `bond.cancel` — abort streaming on dismiss
- `session.generateTitle` — auto-title
- `session.update` — archive + mark quick

The daemon auto-subscribes the client to a session on `bond.send`. No explicit subscribe needed.

### IPC — Minimal additions

Only 2 new channels needed:
- `bond:quickChatInit` (main → renderer) — session ID + sense context summary
- `bond:quickChatDismissed` (renderer → main) — animation complete, safe to hide

Everything else uses existing `window.bond.*` methods from the preload.

---

## Edge Cases

- **Multi-monitor**: Use `screen.getCursorScreenPoint()` + `screen.getDisplayNearestPoint()` to find the right display. Position at bottom-right of that display's workArea using `workArea.x + workArea.width - panelWidth - 12` and `workArea.y + workArea.height - panelHeight - 20` (handles negative coordinates for left-of-primary monitors)
- **Already visible**: Toggle behavior — shortcut while showing = dismiss
- **Main window**: Unaffected. Quick chat is a separate window with its own session
- **Rapid toggle**: 300ms debounce on shortcut
- **Sleep/wake**: Re-register globalShortcut on `powerMonitor.on('resume')` and display change events
- **Sense disabled**: Quick chat still works, just no context indicator and no sense in system prompt
- **Tool approval**: Uses same preload and IPC — approval UI works but needs to fit 380px width. Audit existing approval component for narrow layout
- **Cancel on dismiss**: Always cancel active response before archiving to prevent orphaned streaming sessions
- **Empty sessions**: If user summons and dismisses without sending, delete the session instead of archiving
- **Subscription cleanup**: The daemon auto-subscribes on send. No cleanup mechanism exists. Acceptable for v1 — quick chat sessions are short-lived. Monitor over time

---

## Implementation Order

1. **Chunk routing refactor** — `window-router.ts` module, refactor `onChunk` and entity change handlers in `index.ts` to use it. This unblocks quick chat and benefits all future multi-window work
2. **Session schema** — Add `quick` field to Session type, DB migration, update handlers
3. **`quick-chat.ts` module** — BrowserWindow creation (bottom-right, frameless, vibrancy, no shadow), global shortcut registration, show/hide/toggle, multi-monitor positioning, sleep/wake re-registration
4. **QuickChat.vue** — `?mode=quick-chat` detection in App.vue, stripped-down layout with transparent background (let vibrancy show through), wire up `useChat`, fade+scale entry animation, input handling, Escape dismiss
5. **Sense indicator** — Fetch sense summary on summon, display context bar
6. **Dismiss flow** — Cancel active response, fade-out animation, auto-title, auto-archive, empty session cleanup
7. **Polish** — Debounce, narrow-layout audit for messages/approvals/artifacts, test across monitors, verify vibrancy blur looks seamless with various wallpapers
