/**
 * Web render host for the Electron main process.
 *
 * Listens for web.requestRender notifications from the daemon, loads the URL
 * in a persistent hidden BrowserWindow (a real Chromium — the only thing
 * search engines still serve results to), and calls web.renderReady back to
 * the daemon with the rendered HTML.
 *
 * Renders are serialized through one window: a single queue keeps Bond a
 * polite, human-paced visitor rather than a scraper fanning out requests.
 */

import { BrowserWindow } from 'electron'
import type { BondClient } from '../shared/client'
import type { WebRenderRequest, WebRenderResult } from '../shared/web'

// Electron's default UA advertises Electron and gets bot-walled; present as
// the Chrome this window actually is.
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 20_000
const SELECTOR_POLL_MS = 250
// JS-rendered pages keep painting after load; give them a beat before extraction.
const SETTLE_MS = 1_200
const MAX_HTML_BYTES = 4 * 1024 * 1024

let renderWindow: BrowserWindow | null = null
let queue: Promise<void> = Promise.resolve()
let cleanupFns: (() => void)[] = []

export function initWeb(client: BondClient): void {
  const unsub = client.onWebRequestRender((payload) => {
    queue = queue.then(async () => {
      const result = await renderPage(payload)
      try {
        await client.webRenderReady(result)
      } catch (err) {
        console.error('[Web] Failed to deliver render result:', err)
      }
    })
  })
  cleanupFns.push(unsub)
}

export function destroyWeb(): void {
  for (const fn of cleanupFns) fn()
  cleanupFns = []
  if (renderWindow && !renderWindow.isDestroyed()) {
    renderWindow.destroy()
  }
  renderWindow = null
}

function getRenderWindow(): BrowserWindow {
  if (renderWindow && !renderWindow.isDestroyed()) return renderWindow
  renderWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  renderWindow.webContents.setAudioMuted(true)
  // A hidden window must never navigate into new visible windows.
  renderWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return renderWindow
}

async function renderPage(request: WebRenderRequest): Promise<WebRenderResult> {
  const deadline = Date.now() + (request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const win = getRenderWindow()
    const contents = win.webContents

    try {
      await win.loadURL(request.url, { userAgent: CHROME_UA })
    } catch {
      // Redirect chains abort loadURL (ERR_ABORTED) while the page still
      // lands; keep going and extract from wherever the window ended up.
    }

    if (request.waitForSelector) {
      await waitForSelector(contents, request.waitForSelector, deadline)
    } else {
      await delay(Math.min(SETTLE_MS, Math.max(0, deadline - Date.now())))
    }

    const extracted = await contents.executeJavaScript(
      'JSON.stringify({ html: document.documentElement.outerHTML, title: document.title })',
      true,
    ) as string
    const { html, title } = JSON.parse(extracted) as { html: string; title: string }
    return {
      renderId: request.renderId,
      ok: true,
      html: html.slice(0, MAX_HTML_BYTES),
      finalUrl: contents.getURL(),
      title,
    }
  } catch (err) {
    return {
      renderId: request.renderId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function waitForSelector(contents: Electron.WebContents, selector: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const found = await contents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(selector)})`,
        true,
      ) as boolean
      if (found) {
        // Matched rows can still be filling in; let the page settle briefly.
        await delay(Math.min(500, Math.max(0, deadline - Date.now())))
        return
      }
    } catch {
      // Page mid-navigation — retry until the deadline.
    }
    await delay(SELECTOR_POLL_MS)
  }
  // Deadline hit without a match: fall through and let the caller extract
  // whatever rendered, so partial or block pages still produce a diagnosable
  // result instead of a hard failure.
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
