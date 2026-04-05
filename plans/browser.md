# In-App Browser

A tabbed browser embedded in Bond's right panel. Fully controllable by both the user and the agent. Includes DevTools-style console, DOM inspection, and network monitoring.

## Architecture Decision: Hybrid webview + main-process CDP

Electron offers three embedding approaches. Here's why we're going hybrid:

**Option A: WebContentsView (main process only)**
Electron's recommended path. But WebContentsViews live outside the DOM — they're positioned with absolute pixel coordinates from the main process. Bond's resizable panel system is DOM-based (Vue + flexbox). We'd need to constantly IPC the panel's bounding rect to main, reposition on every resize/scroll/toggle, and fight z-index issues with overlapping UI. Massive coordination tax for a side panel.

**Option B: `<webview>` tag (renderer only)**
DOM-native. Drops right into a Vue component, resizes with the panel automatically. Has executeJavaScript, capturePage, console-message events. Electron warns it's "not recommended" due to Chromium architectural churn — but VS Code still ships with it, and for our use case (panel browser, not mission-critical rendering) the risk is acceptable.

**Option C: Hybrid — webview tag in renderer, CDP via main process** ✓
Use `<webview>` for DOM integration (it just works in the panel). For advanced features (network monitoring, full console capture, DOM inspection), get the webview's `webContentsId` and access it from the main process via `webContents.fromId()`. Attach the CDP debugger there for Network, Runtime, and DOM domains. Best of both worlds.

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
- **Webview area** — one `<webview>` per tab, visibility toggled via CSS (width/height 0 for inactive — not display:none, which causes reload bugs in Electron)
- **Empty state** — when no tabs are open, show a centered URL input

### Webview configuration per tab

```html
<webview
  :src="tab.url"
  partition="persist:browser"      <!-- cookies survive restart -->
  allowpopups                      <!-- handle new-window → open in new tab -->
  :useragent="defaultUserAgent"    <!-- standard Chrome UA, not Electron -->
/>
```

Events to bind per webview:

| Event | Action |
|---|---|
| `did-start-loading` | `tab.loading = true` |
| `did-stop-loading` | `tab.loading = false` |
| `page-title-updated` | `tab.title = e.title` |
| `page-favicon-updated` | `tab.favicon = e.favicons[0]` |
| `did-navigate` | `tab.url = e.url`, update canGoBack/canGoForward |
| `did-fail-load` | show inline error state |
| `new-window` | `createTab(e.url)` instead of system browser |
| `dom-ready` | capture webContentsId, send to main process |
| `console-message` | buffer in devtools console log |

### Panel integration (App.vue changes)

- Add `'browser'` to `RightPanelContent` type
- Add globe icon button in chat header toolbar (PhGlobe from Phosphor)
- Keyboard shortcut: `⇧⌘K`
- When browser content active and panel is narrow, bump minSize to 360px
- BrowserView component is always mounted (v-show, not v-if) so tabs stay alive when panel switches to todos/projects

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

### New IPC channels

The agent can't talk to the renderer directly. Commands flow: daemon → main process (via existing BondClient JSON-RPC) → main sends IPC to renderer → renderer operates on webview → result flows back.

### Preload API additions

```ts
// Commands FROM agent (main → renderer)
onBrowserCommand: (fn: (cmd: BrowserCommand) => void) => RemoveFn

// Results FROM renderer back to main
browserCommandResult: (requestId: string, result: unknown) => Promise<void>

// Renderer tells main about webview webContentsIds
registerWebContentsId: (tabId: string, webContentsId: number) => Promise<void>
unregisterWebContentsId: (tabId: string) => Promise<void>

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

New JSON-RPC methods in `server.ts`: `browser:open`, `browser:navigate`, `browser:close`, `browser:tabs`, `browser:read`, `browser:screenshot`, `browser:exec`, `browser:console`, `browser:dom`, `browser:network`.

These proxy through the existing BondClient → main process → renderer pipeline.

### Agent integration (agent.ts)

The agent uses **Bash** to call a `bond browser` CLI subcommand that talks to the daemon over the Unix socket:

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

This reuses the existing pattern (bond CLI → daemon socket → main process → renderer). The system prompt tells the agent these commands exist.

---

## Phase 3: DevTools panel — Console, DOM, Network

### CDP setup (main process)

When renderer registers a `webContentsId` for a tab, main process:

```ts
const wc = webContents.fromId(webContentsId)
wc.debugger.attach('1.3')
wc.debugger.sendCommand('Network.enable')
wc.debugger.sendCommand('Runtime.enable')
wc.debugger.sendCommand('DOM.enable')

wc.debugger.on('message', (event, method, params) => {
  // Buffer events per tab, forward to renderer for UI
  // Store for agent access
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

New `BrowserDevTools.vue` — sits below the webview in a vertical split:

- **Tab bar:** Console | Elements | Network
- **Console tab:** scrollable log with level icons, filter by level, input at bottom to evaluate JS
- **Elements tab:** DOM tree view, click to expand nodes, show outerHTML
- **Network tab:** request list (method, URL, status, size, time), click for headers/preview
- **Toggle:** small button at bottom of browser panel to show/hide DevTools
- **Resize:** draggable split between webview and devtools pane

Also: right-click context menu on the webview with "Inspect Element" → opens Chromium's full DevTools in a detached window via `openDevTools({ mode: 'detach' })`.

---

## Phase 4: CLI + system prompt

### bond browser CLI

Add to `src/cli/` — follows existing pattern (todo, project, media, collection, journal). Each subcommand sends a JSON-RPC request to the daemon socket and prints the result. Screenshot command saves PNG to `/tmp/bond-browser-<tabId>.png` and returns the path for the agent to read with the Read tool.

### System prompt addition

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

### New files (7)

| File | Purpose |
|---|---|
| `renderer/components/BrowserView.vue` | Browser component with tabs + nav + webviews |
| `renderer/components/BrowserDevTools.vue` | Console/elements/network panel |
| `renderer/composables/useBrowser.ts` | Shared tab state + command handling |
| `cli/browser.ts` | `bond browser` CLI subcommand |
| `daemon/browser.ts` | Browser command handler (proxies to main) |
| `main/browser.ts` | CDP debugger manager, IPC handlers |
| `shared/browser.ts` | Shared types (BrowserTab, BrowserCommand, ConsoleEntry, NetworkEntry) |

### Modified files (7)

| File | Change |
|---|---|
| `renderer/App.vue` | Add browser to right panel, toggle button, keyboard shortcut |
| `preload/index.ts` | Add browser IPC methods |
| `main/index.ts` | Register browser IPC handlers, import browser module |
| `daemon/server.ts` | Add `browser:*` RPC methods |
| `daemon/agent.ts` | Add browser section to system prompt |
| `shared/client.ts` | Add browser methods to BondClient |
| `cli/index.ts` | Register browser subcommand |

---

## Gotchas from research

- **Don't use display:none to hide webviews.** Causes reload on un-hide. Use width:0 + height:0 + overflow:hidden + flex-shrink:0 for inactive tabs.
- **capturePage() doesn't resolve for off-screen webviews.** The webview must have non-zero dimensions. Before screenshotting an inactive tab, briefly swap it to visible.
- **console-message only gets first argument.** `console.log("a", "b")` → event only sees "a". CDP `Runtime.consoleAPICalled` gets all args — use that as primary source.
- **Network.getResponseBody can fail.** Known Electron bug — sometimes returns empty for streamed/chunked responses. Degrade gracefully.
- **webContentsId + contextIsolation.** Can't call `webview.getWebContentsId()` directly with contextIsolation on. Use the `did-attach-webview` event on the host window's webContents — it fires with the guest webContents directly, no ID lookup needed.
- **goBack()/goForward() deprecated since Electron 32.** Use `navigationHistory.goBack()` / `navigationHistory.canGoBack()` instead. Bond is on Electron 41.
- **Memory.** Each webview tab is a separate Chromium process. Cap at 8 tabs. Offer "close all tabs" in context menu.

## References

- [Electron Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)
- [Migrating to WebContentsView](https://www.electronjs.org/blog/migrate-to-webcontentsview)
- [Webview Tag API](https://www.electronjs.org/docs/latest/api/webview-tag)
- [Debugger Class API](https://www.electronjs.org/docs/latest/api/debugger)
- [webContents API](https://www.electronjs.org/docs/latest/api/web-contents)
- [Navigation History](https://www.electronjs.org/docs/latest/tutorial/navigation-history)
- [Building a Browser in Electron](https://www.ika.im/posts/building-a-browser-in-electron)
- [WebContentsView API](https://www.electronjs.org/docs/latest/api/web-contents-view)
