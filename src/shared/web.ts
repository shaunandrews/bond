/**
 * Web render types shared between the daemon and the Electron main process.
 *
 * The daemon's web tools cannot reach the network like a browser on their
 * own — search engines block plain HTTP clients. Instead the daemon asks the
 * app's main process to load a URL in a hidden BrowserWindow (a real Chromium)
 * and send back the rendered HTML, mirroring the Sense capture round-trip:
 * `web.requestRender` notification out, `web.renderReady` RPC back.
 */

export interface WebRenderRequest {
  renderId: string
  url: string
  /** CSS selector to poll for before extracting — e.g. a SERP result row. */
  waitForSelector?: string
  /** Overall render budget in the main process. */
  timeoutMs?: number
}

export interface WebRenderResult {
  renderId: string
  ok: boolean
  /** Rendered `document.documentElement.outerHTML` when ok. */
  html?: string
  /** URL after redirects, which may differ from the requested URL. */
  finalUrl?: string
  title?: string
  error?: string
}
