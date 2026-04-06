import { BrowserWindow } from 'electron'
import type { TaggedChunk } from '../shared/stream'

/** Maps sessionId to the BrowserWindow that should receive chunks for it */
const sessionWindows = new Map<string, BrowserWindow>()

/** All managed windows (for broadcasting entity changes) */
const allWindows = new Set<BrowserWindow>()

export function registerWindow(win: BrowserWindow): void {
  allWindows.add(win)
  win.on('closed', () => allWindows.delete(win))
}

export function registerSessionWindow(sessionId: string, win: BrowserWindow): void {
  sessionWindows.set(sessionId, win)
}

export function unregisterSession(sessionId: string): void {
  sessionWindows.delete(sessionId)
}

export function routeChunk(chunk: TaggedChunk): void {
  const win = sessionWindows.get(chunk.sessionId)
  if (win && !win.isDestroyed()) {
    win.webContents.send('bond:chunk', chunk)
    return
  }
  // Fallback: send to all windows (covers sessions registered before routing was set up)
  for (const w of allWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send('bond:chunk', chunk)
    }
  }
}

export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}
