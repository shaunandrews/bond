# In-App Browser

A tabbed browser embedded in Bond's right panel. Fully controllable by both the user and the agent. Includes DevTools-style console, DOM inspection, and network monitoring.

## Architecture Decision: Hybrid webview + main-process CDP

Electron offers three embedding approaches:

**Option A: WebContentsView (main process only)**
Electron's officially recommended path since BrowserView was deprecated in Electron 30. WebContentsViews are Chromium-native views positioned via `setBounds()` from the main process. The problem: they live outside the DOM. Bond's panel system is entirely DOM-based (Vue + flexbox + pointer-captured drag handles). We'd need to IPC the browser panel's bounding rect to main on every resize, window move, scroll, panel collapse/expand, and sidebar toggle — then call `setBounds()` each time. Z-index conflicts with overlapping Vue UI (flyout menus, tooltips, modals) are another coordination tax, since WebContentsViews always paint above the renderer. The Stack Browser (a notable Electron browser) solves this with a Yoga layout engine in the renderer — heavy machinery we don't need.

**Option B: `<webview>` tag (renderer only)**
DOM-native. Drops into a Vue component, participates in flexbox, resizes with the panel automatically. Bond already has `webviewTag: true` enabled, JSX type declarations in `types/webview.d.ts`, and custom element registration in `electron.vite.config.ts`. Electron's docs say "We currently recommend to not use the webview tag" due to Chromium architectural churn — but it is not deprecated, the API is stable, and VS Code still ships with it. For a side-panel browser (not a full browser engine), the stability risk is low.

**Option C: Hybrid — webview tag in renderer, CDP via main process** ✓
Use `<webview>` for DOM integration (it just works in the panel). For advanced features (network monitoring, full console capture, DOM inspection), access the webview's guest `webContents` from the main process via the `did-attach-webview` event. Attach the CDP debugger there for Network, Runtime, and DOM domains. Best of both worlds.

**Future-proofing:** If Electron ever deprecates `<webview>` for real, the migration path is to replace the webview element with a positioned `WebContentsView` and add bounds-syncing IPC. The CDP layer (Phase 3), CLI (Phase 4), and all agent integration stay identical — only the rendering layer changes.

---

## Phase 1: Core browser component + panel integration

### New files

- `renderer/components/BrowserView.vue` — main component
- `renderer/composables/useBrowser.ts` — tab state, shared across components

### Tab state model

```ts
interface BrowserTab {
  id: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  webContentsId: number | null  // for main-process CDP access
}

// useBrowser.ts — singleton composable
tabs: Ref<BrowserTab[]>
activeTabId: Ref<string | null>
createTab(url?: string): string   // returns tab id
closeTab(id: string): void
switchTab(id: string): void
navigate(id: string, url: string): void
```

### BrowserView.vue structure

- **Tab bar** — horizontal scrollable tabs with title + favicon + close button + "+" to add
- **Navigation bar** — ← → ↻ buttons, URL input (auto-focuses on new tab), loading indicator
- **Webview area** — one `<webview>` per tab, visibility toggled via CSS (width:0 + height:0 + overflow:hidden for inactive — not display:none, which causes reload bugs in Electron)
- **Empty state** — when no tabs are open, show a centered URL input with a PhGlobe icon

### Webview configuration per tab

```html
<webview
  :src="tab.url"
  partition="persist:browser"
  allowpopups
  :useragent="defaultUserAgent"
/>
```

Security — the webview gets its own persistent session (`persist:browser`) isolated from Bond's app session. No preload script, no node integration, no Bond APIs exposed to guest pages.

Events to bind per webview:

| Event | Action |
|---|---|
| `did-start-loading` | `tab.loading = true` |
| `did-stop-loading` | `tab.loading = false` |
| `page-title-updated` | `tab.title = e.title` |
| `page-favicon-updated` | `tab.favicon = e.favicons[0]` |
| `did-navigate` | `tab.url = e.url`, update canGoBack/canGoForward via `navigationHistory` |
| `did-navigate-in-page` | same as above (for SPA hash/pushState navigation) |
| `did-fail-load` | show inline error state (errorCode + description) |
| `new-window` | `createTab(e.url)` instead of system browser |
| `console-message` | buffer in devtools console log |

Navigation uses `webContents.navigationHistory` (not the deprecated `goBack()`/`goForward()`). Bond is on Electron 41; these methods were deprecated in Electron 32.

### Panel integration (App.vue changes)

The right panel currently supports `'todos' | 'projects'` via `RightPanelContent`. Add `'browser'`:

```ts
type RightPanelContent = 'todos' | 'projects' | 'browser'
```

- Add PhGlobe icon button in chat header toolbar (alongside the existing PhCube for projects and PhChecks for todos), using the same `toggleRightPanel('browser')` pattern
- Keyboard shortcut: `⇧⌘K` (⌘B is sidebar toggle, ⇧⌘B is right panel toggle — both taken)
- Right panel max increased from 640 to 900px when browser content is active
- BrowserView component is always mounted (v-show, not v-if) so tabs stay alive when panel switches to todos/projects
- Right panel `minSizePx` bumped to 360 when browser is the active content

### Link integration

Update `MarkdownMessage.vue` link handling. Currently all external links call `window.bond.openExternal()`. With the browser panel, Cmd+Click opens in system browser (existing behavior), regular click opens in the browser panel. This turns the existing openExternal flow into a browser panel flow for casual link following.

---

## Phase 2: Agent control — IPC bridge + daemon tools

### Communication flow

```
Agent (daemon)
  ↓ JSON-RPC over WebSocket
Main process (Electron)
  ↓ ipcMain ↔ ipcRenderer
Renderer (Vue/BrowserView.vue)
  ↓ webview DOM API / executeJavaScript
Guest page
```

### IPC channels

Commands flow: daemon → BondClient (WebSocket) → main process IPC → renderer → webview → result flows back.

### Preload API additions (preload/index.ts)

Following the existing pattern (`ipcRenderer.invoke` for requests, `ipcRenderer.on` for push events):

```ts
// window.bond additions
browser: {
  // Commands FROM agent (main → renderer)
  onCommand: (fn: (cmd: BrowserCommand) => void) => {
    const handler = (_e: IpcRendererEvent, cmd: BrowserCommand) => fn(cmd)
    ipcRenderer.on('bond:browserCommand', handler)
    return () => ipcRenderer.removeListener('bond:browserCommand', handler)
  },

  // Results FROM renderer back to main
  commandResult: (requestId: string, result: unknown) =>
    ipcRenderer.invoke('browser:commandResult', requestId, result),

  // Renderer tells main about webview webContentsIds (via did-attach-webview)
  registerWebContents: (tabId: string, webContentsId: number) =>
    ipcRenderer.invoke('browser:registerWebContents', tabId, webContentsId),
  unregisterWebContents: (tabId: string) =>
    ipcRenderer.invoke('browser:unregisterWebContents', tabId),
}
```

```ts
type BrowserCommand =
  | { type: 'open'; requestId: string; url: string }
  | { type: 'navigate'; requestId: string; tabId: string; url: string }
  | { type: 'close'; requestId: string; tabId: string }
  | { type: 'tabs'; requestId: string }
  | { type: 'read'; requestId: string; tabId?: string }
  | { type: 'screenshot'; requestId: string; tabId?: string }
  | { type: 'exec'; requestId: string; tabId?: string; js: string }
  | { type: 'console'; requestId: string; tabId?: string }
  | { type: 'dom'; requestId: string; tabId?: string; selector?: string }
  | { type: 'network'; requestId: string; tabId?: string }
```

### Daemon server additions

New JSON-RPC methods in `server.ts` under the `browser.*` namespace: `browser.open`, `browser.navigate`, `browser.close`, `browser.tabs`, `browser.read`, `browser.screenshot`, `browser.exec`, `browser.console`, `browser.dom`, `browser.network`.

These proxy through the existing BondClient → main process → renderer pipeline.

### Agent integration (agent.ts)

The agent uses **Bash** to call `bond browser` CLI subcommands that talk to the daemon over the Unix socket:

```
bond browser open <url>              # opens tab, returns tab id + title
bond browser tabs                     # list open tabs
bond browser navigate <tab> <url>    # navigate existing tab
bond browser close <tab>              # close tab
bond browser read [tab]               # get page text (active tab if omitted)
bond browser screenshot [tab]         # capture page as PNG, returns file path
bond browser exec [tab] "<js>"        # run JS in page, return result
bond browser console [tab]            # dump console log
bond browser dom [tab] [selector]     # read page HTML or query elements
bond browser network [tab]            # recent network requests
```

This reuses the existing pattern (`bin/bond` bash CLI → daemon socket → main process → renderer). The system prompt tells the agent these commands exist.

---

## Phase 3: DevTools panel — Console, DOM, Network

### CDP setup (main process → main/browser.ts)

When the main process receives a `did-attach-webview` event on the host window's webContents, it gets the guest webContents directly (no ID lookup needed — avoids contextIsolation issues):

```ts
mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
  webContents.debugger.attach('1.3')
  webContents.debugger.sendCommand('Network.enable')
  webContents.debugger.sendCommand('Runtime.enable')
  webContents.debugger.sendCommand('DOM.enable')

  webContents.debugger.on('message', (event, method, params) => {
    // Buffer events per tab, forward to renderer for UI
    // Store for agent access
  })
})
```

### Console capture

Two sources, merged:

1. Webview's `console-message` event — fast, but only gets first argument per call
2. CDP `Runtime.consoleAPICalled` — full args, stack traces, proper serialization

Use CDP as primary, webview event as fallback. Store per-tab ring buffer (last 500 entries).

```ts
interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug'
  text: string
  args: string[]        // serialized from CDP RemoteObject
  timestamp: number
  source?: string       // file:line
  stackTrace?: string
}
```

### Network capture

CDP events: `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`.

Response bodies via `Network.getResponseBody` (on demand, not eagerly — bodies can be huge).

```ts
interface NetworkEntry {
  requestId: string
  url: string
  method: string
  status: number | null     // null while pending
  mimeType: string | null
  size: number | null
  timing: number            // ms
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string> | null
}
```

Ring buffer: last 200 requests per tab.

### DOM inspection

- For agent: `browser dom` uses `executeJavaScript` to run querySelector/outerHTML — simpler and more reliable than CDP DOM domain
- For user UI: basic elements view showing the DOM tree (collapsible nodes), computed styles on selection. Not a full Elements panel — just enough to see structure.

### DevTools UI component

New `BrowserDevTools.vue` — sits below the webview in a vertical split (using BondPanelGroup vertical inside the browser panel):

- **Tab bar:** Console | Elements | Network (using BondTab)
- **Console tab:** scrollable log with level icons, filter by level, input at bottom to evaluate JS
- **Elements tab:** DOM tree view, click to expand nodes, show outerHTML
- **Network tab:** request list (method, URL, status, size, time), click for headers/preview
- **Toggle:** small button at bottom of browser panel to show/hide DevTools
- **Resize:** BondPanelHandle between webview and devtools pane

Also: right-click context menu on the webview with "Inspect Element" → opens Chromium's full DevTools in a detached window via `openDevTools({ mode: 'detach' })`.

---

## Phase 4: CLI + system prompt

### bond browser CLI

Add `src/cli/browser.ts` — follows existing pattern (todo.ts, project.ts, media.ts, sense.ts). The `bin/bond` bash script routes `bond browser <subcommand>` to this file via `npx tsx`. Each subcommand sends a JSON-RPC request to the daemon socket and prints the result.

Screenshot command saves PNG to `/tmp/bond-browser-<tabId>.png` and returns the path for the agent to read with the Read tool.

### System prompt addition (agent.ts)

```
IN-APP BROWSER:
Bond has a built-in browser in the right panel. You can control it:
- `bond browser open <url>` — open URL in new tab, returns tab id
- `bond browser tabs` — list open tabs
- `bond browser read [tab]` — get page text (active tab if omitted)
- `bond browser screenshot [tab]` — capture page as PNG, returns file path
- `bond browser exec [tab] "<js>"` — run JavaScript in page, return result
- `bond browser console [tab]` — get console output
- `bond browser dom [tab] [selector]` — read page HTML or query elements
- `bond browser network [tab]` — recent network requests
- `bond browser navigate <tab> <url>` — navigate existing tab
- `bond browser close <tab>` — close tab
The browser panel opens automatically when you open a tab.
When the user says "look at this page" or "check what I have open",
use `bond browser read` and/or `bond browser screenshot` on the active tab.
```

---

## File change map

### New files (8)

| File | Purpose |
|---|---|
| `renderer/components/BrowserView.vue` | Browser component with tabs + nav + webviews |
| `renderer/components/BrowserDevTools.vue` | Console/elements/network panel |
| `renderer/composables/useBrowser.ts` | Shared tab state + command handling |
| `cli/browser.ts` | `bond browser` CLI subcommand |
| `daemon/browser.ts` | Browser command handler (proxies to main) |
| `main/browser.ts` | CDP debugger manager, IPC handlers |
| `shared/browser.ts` | Shared types (BrowserTab, BrowserCommand, ConsoleEntry, NetworkEntry) |
| `renderer/types/webview.d.ts` | Already exists — may need additional event type declarations |

### Modified files (8)

| File | Change |
|---|---|
| `renderer/App.vue` | Add `'browser'` to `RightPanelContent`, PhGlobe toggle button, ⇧⌘K shortcut, bump right panel maxSize for browser |
| `preload/index.ts` | Add `browser.*` IPC methods to `window.bond` |
| `renderer/env.d.ts` | Add browser methods to `Window['bond']` type |
| `main/index.ts` | Register browser IPC handlers, `did-attach-webview` listener, import browser module |
| `daemon/server.ts` | Add `browser.*` RPC methods |
| `daemon/agent.ts` | Add browser section to system prompt |
| `shared/client.ts` | Add browser methods to BondClient |
| `bin/bond` | Add `browser` subcommand routing |

---

## Gotchas from research

- **Don't use display:none to hide webviews.** Causes reload on un-hide. Use width:0 + height:0 + overflow:hidden + flex-shrink:0 for inactive tabs.
- **capturePage() doesn't resolve for off-screen webviews.** The webview must have non-zero dimensions. Before screenshotting an inactive tab, briefly swap it to visible.
- **console-message only gets first argument.** `console.log("a", "b")` → event only sees "a". CDP `Runtime.consoleAPICalled` gets all args — use that as primary source.
- **Network.getResponseBody can fail.** Known Electron bug — sometimes returns empty for streamed/chunked responses. Degrade gracefully.
- **webContentsId + contextIsolation.** Can't call `webview.getWebContentsId()` directly with contextIsolation on. Use the `did-attach-webview` event on the host window's webContents — it fires with the guest webContents directly, no ID lookup needed.
- **goBack()/goForward() deprecated since Electron 32.** Use `navigationHistory.goBack()` / `navigationHistory.canGoBack()` instead. Bond is on Electron 41.
- **Memory.** Each webview tab is a separate Chromium process. Cap at 8 tabs. Offer "close all tabs" in context menu.
- **Pointer capture during panel resize.** BondPanelHandle already uses `setPointerCapture()` to prevent child elements from stealing drag events. Webviews would otherwise intercept pointer events during panel resize — the existing panel system already handles this correctly.
- **SSL/cert errors.** Webview will show a blank page for self-signed certs by default. Handle `certificate-error` event on the guest webContents to show a user-facing warning with an override option.
- **WebContentsView as future fallback.** If Electron eventually drops `<webview>`, the migration is: replace the webview DOM element with a `WebContentsView` positioned via `setBounds()`, add IPC for the renderer to report panel dimensions on resize/collapse/sidebar-toggle. CDP, CLI, and agent layers are unaffected.

## References

- [Electron Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)
- [Migrating to WebContentsView](https://www.electronjs.org/blog/migrate-to-webcontentsview)
- [Webview Tag API](https://www.electronjs.org/docs/latest/api/webview-tag)
- [WebContentsView API](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Debugger Class API](https://www.electronjs.org/docs/latest/api/debugger)
- [webContents API](https://www.electronjs.org/docs/latest/api/web-contents)
- [Navigation History](https://www.electronjs.org/docs/latest/tutorial/navigation-history)
- [Electron Security Best Practices](https://www.electronjs.org/docs/latest/tutorial/security)
- [Building a Browser in Electron (Stack Browser)](https://www.ika.im/posts/building-a-browser-in-electron)
- [electron-browser-shell](https://github.com/samuelmaddock/electron-browser-shell) — Minimal tabbed Electron browser with extension support
