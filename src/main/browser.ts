/**
 * Main process browser management.
 *
 * Handles:
 * - WebContents registration (tabId → webContentsId mapping)
 * - Screenshot capture via webContents.capturePage()
 * - JS execution in guest pages
 * - Browser command proxying: daemon → renderer → result → daemon
 */

import { ipcMain, BrowserWindow, webContents } from 'electron'
import { writeFileSync } from 'node:fs'
import type { BondClient } from '../shared/client'
import type { BrowserCommand } from '../shared/browser'

// tabId → webContentsId mapping
const tabRegistry = new Map<string, number>()

let mainWindowRef: BrowserWindow | null = null
let clientRef: BondClient | null = null

export function initBrowser(mainWindow: BrowserWindow, client: BondClient): void {
  mainWindowRef = mainWindow
  clientRef = client

  // --- Renderer → Main: register/unregister webContentsIds ---

  ipcMain.handle('browser:registerWebContents', (_e, tabId: string, webContentsId: number) => {
    tabRegistry.set(tabId, webContentsId)
  })

  ipcMain.handle('browser:unregisterWebContents', (_e, tabId: string) => {
    tabRegistry.delete(tabId)
  })

  // --- Renderer → Main: capture tab screenshot ---

  ipcMain.handle('browser:captureTab', async (_e, tabId: string) => {
    const wcId = tabRegistry.get(tabId)
    if (wcId == null) throw new Error('Tab not registered')
    const wc = webContents.fromId(wcId)
    if (!wc) throw new Error('WebContents not found')
    const image = await wc.capturePage()
    const path = `/tmp/bond-browser-${tabId}.png`
    writeFileSync(path, image.toPNG())
    return path
  })

  // --- Renderer → Main: execute JS in tab ---

  ipcMain.handle('browser:execInTab', async (_e, tabId: string, js: string) => {
    const wcId = tabRegistry.get(tabId)
    if (wcId == null) throw new Error('Tab not registered')
    const wc = webContents.fromId(wcId)
    if (!wc) throw new Error('WebContents not found')
    return wc.executeJavaScript(js)
  })

  // --- Renderer → Main: command results flowing back to daemon ---

  ipcMain.handle('browser:commandResult', (_e, requestId: string, result: unknown) => {
    // Forward result back to daemon so the pending RPC resolves
    if (clientRef) {
      clientRef.browserCommandResult(requestId, result)
    }
  })

  // --- Daemon → Main → Renderer: forward browser commands ---

  client.onBrowserCommand((cmd: BrowserCommand) => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return
    mainWindowRef.webContents.send('bond:browserCommand', cmd)
  })
}

export function destroyBrowser(): void {
  tabRegistry.clear()
  mainWindowRef = null
  clientRef = null
}
