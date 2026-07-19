/**
 * Render broker — the daemon side of the hidden-browser round-trip.
 *
 * The daemon can't render web pages itself; the Bond app's main process owns
 * the hidden BrowserWindow. renderPage() sends a web.requestRender
 * notification through the transport the server installs, parks the promise
 * here, and resolves it when the app calls web.renderReady back.
 */

import { randomUUID } from 'node:crypto'
import type { WebRenderRequest, WebRenderResult } from '../../shared/web'

export interface RenderedPage {
  html: string
  finalUrl: string
  title: string
}

/** Delivers a render request to connected clients; false when nobody is listening. */
export type RenderTransport = (request: WebRenderRequest) => boolean

export const APP_NOT_RUNNING_ERROR = 'Web access needs the Bond app running — it borrows the app\'s hidden browser window and no app is connected right now.'

const DEFAULT_TIMEOUT_MS = 25_000
// Margin past the main-process render budget so the app's own timeout error
// (which names the URL and what failed) wins over the broker's generic one.
const REPLY_MARGIN_MS = 5_000

interface PendingRender {
  resolve: (page: RenderedPage) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let transport: RenderTransport | null = null
const pending = new Map<string, PendingRender>()

export function setRenderTransport(fn: RenderTransport | null): void {
  transport = fn
}

export function pendingRenderCount(): number {
  return pending.size
}

/** Ask the app to render a URL in its hidden browser and return the result. */
export function renderPage(
  url: string,
  options: { waitForSelector?: string; timeoutMs?: number } = {},
): Promise<RenderedPage> {
  const send = transport
  if (!send) return Promise.reject(new Error(APP_NOT_RUNNING_ERROR))

  const renderId = randomUUID()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const request: WebRenderRequest = {
    renderId,
    url,
    waitForSelector: options.waitForSelector,
    timeoutMs,
  }

  return new Promise<RenderedPage>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(renderId)
      reject(new Error(`Timed out after ${Math.round((timeoutMs + REPLY_MARGIN_MS) / 1000)}s waiting for the Bond app to render ${url}`))
    }, timeoutMs + REPLY_MARGIN_MS)
    pending.set(renderId, { resolve, reject, timer })

    let delivered = false
    try {
      delivered = send(request)
    } catch {
      delivered = false
    }
    if (!delivered) {
      clearTimeout(timer)
      pending.delete(renderId)
      reject(new Error(APP_NOT_RUNNING_ERROR))
    }
  })
}

/** Called by the server when the app reports a finished render. */
export function onRenderReady(result: WebRenderResult): boolean {
  const entry = pending.get(result.renderId)
  if (!entry) return false
  pending.delete(result.renderId)
  clearTimeout(entry.timer)
  if (result.ok && typeof result.html === 'string') {
    entry.resolve({
      html: result.html,
      finalUrl: result.finalUrl ?? '',
      title: result.title ?? '',
    })
  } else {
    entry.reject(new Error(result.error || 'The Bond app failed to render the page.'))
  }
  return true
}
