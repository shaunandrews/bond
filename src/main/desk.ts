/**
 * Desk window host registry (main process).
 *
 * A thin indirection rather than the window itself, for two reasons: the
 * `open_desk` tool, the preload proxy, and the web shim all talk to this
 * regardless of whether a native panel exists, and every entry point degrades
 * to an honest `unavailable` instead of resolving `opened: true` for a window
 * that was never created (headless runs, a failed native build, tests).
 *
 * `createDeskWindowHost` in `desk-window.ts` is the real NSPanel.
 */

import type { DeskHotRect } from '../shared/desk-window'

export interface OpenDeskResult {
  opened: boolean
  reason?: string
}

export interface DeskWindowHost {
  /** Idempotent: a second call reveals the existing panel, never a second one. */
  open(opts?: { queued?: boolean }): Promise<OpenDeskResult>
  close(): void
  isOpen(): boolean
  /** Renderer-reported hit regions, validated and clamped by the host. */
  setHotRects?(rects: DeskHotRect[]): void
  /** The renderer mounted; safe to show. */
  markReady?(): void
  isReady?(): boolean
}

let host: DeskWindowHost | null = null

/**
 * Phase 3 registers the real NSPanel host here. Until it does, `openDesk`
 * resolves `{ opened: false, reason: 'unavailable' }`.
 */
export function registerDeskWindowHost(next: DeskWindowHost | null): void {
  host = next
}

export async function openDesk(opts?: { queued?: boolean }): Promise<OpenDeskResult> {
  if (!host) return { opened: false, reason: 'unavailable' }
  try {
    return await host.open(opts)
  } catch (error) {
    console.error('[Desk] open failed:', error)
    return { opened: false, reason: error instanceof Error ? error.message : 'open_failed' }
  }
}

export function closeDesk(): void {
  host?.close()
}

export function isDeskOpen(): boolean {
  return host?.isOpen() ?? false
}

/** Renderer → main: where mouse events should land. The host clamps them. */
export function setDeskHotRects(rects: DeskHotRect[]): void {
  host?.setHotRects?.(rects)
}

/** Renderer → main: mounted and safe to show. */
export function markDeskReady(): void {
  host?.markReady?.()
}
