import { BrowserWindow, globalShortcut, ipcMain, screen, powerMonitor } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BondClient } from '../shared/client'
import { registerWindow, registerSessionWindow, unregisterSession } from './window-router'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

let quickChatWindow: BrowserWindow | null = null
let client: BondClient | null = null
let currentSessionId: string | null = null
let lastToggleTime = 0
let dismissing = false

const SHORTCUT = 'CommandOrControl+Shift+Space'
const PANEL_WIDTH = 380
const DEBOUNCE_MS = 300

function registerShortcut(): void {
  try {
    if (globalShortcut.isRegistered(SHORTCUT)) {
      globalShortcut.unregister(SHORTCUT)
    }
    globalShortcut.register(SHORTCUT, toggle)
  } catch (e) {
    console.warn('[quick-chat] Failed to register global shortcut:', e)
  }
}

function unregisterShortcut(): void {
  try {
    if (globalShortcut.isRegistered(SHORTCUT)) {
      globalShortcut.unregister(SHORTCUT)
    }
  } catch { /* ignore */ }
}

function createWindow(): BrowserWindow {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x: wx, y: wy, width: ww, height: wh } = display.workArea
  const panelHeight = Math.round(wh * 0.68)

  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: panelHeight,
    x: wx + ww - PANEL_WIDTH - 12,
    y: wy + wh - panelHeight - 20,
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

  registerWindow(win)

  win.on('closed', () => {
    quickChatWindow = null
    if (currentSessionId) {
      unregisterSession(currentSessionId)
      currentSessionId = null
    }
  })

  // Load the same index.html with ?mode=quick-chat
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}?mode=quick-chat`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      search: 'mode=quick-chat'
    })
  }

  return win
}

function repositionWindow(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x: wx, y: wy, width: ww, height: wh } = display.workArea
  const panelHeight = Math.round(wh * 0.68)

  win.setBounds({
    x: wx + ww - PANEL_WIDTH - 12,
    y: wy + wh - panelHeight - 20,
    width: PANEL_WIDTH,
    height: panelHeight
  })
}

async function summon(): Promise<void> {
  if (!client) return

  if (!quickChatWindow || quickChatWindow.isDestroyed()) {
    quickChatWindow = createWindow()
  }

  repositionWindow(quickChatWindow)

  // Create a new session
  try {
    const session = await client.createSession()
    currentSessionId = session.id
    registerSessionWindow(session.id, quickChatWindow)

    // Fetch sense apps for the context indicator
    let senseApps: string[] = []
    try {
      const senseData = await client.senseNow() as { apps?: string[] } | null
      if (senseData && Array.isArray(senseData.apps)) {
        senseApps = senseData.apps
      }
    } catch { /* sense may be disabled */ }

    // Wait for window to be ready, then send init data
    const win = quickChatWindow
    if (win && !win.isDestroyed()) {
      // If the window is already loaded, send immediately. Otherwise wait for ready-to-show.
      const sendInit = () => {
        if (!win.isDestroyed()) {
          win.webContents.send('bond:quickChatInit', { sessionId: session.id, senseApps })
          win.show()
          win.focus()
        }
      }

      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', sendInit)
      } else {
        sendInit()
      }
    }
  } catch (e) {
    console.error('[quick-chat] Failed to create session:', e)
  }
}

async function dismiss(): Promise<void> {
  if (dismissing) return
  dismissing = true

  const win = quickChatWindow
  const sid = currentSessionId

  if (!win || win.isDestroyed()) {
    dismissing = false
    currentSessionId = null
    return
  }

  // Cancel active response if streaming
  if (sid && client) {
    try {
      await client.cancel(sid)
    } catch { /* ignore */ }
  }

  // Tell renderer to animate out — the renderer will call quickChat:dismiss when done
  win.webContents.send('bond:quickChatDismiss')
}

async function finalizeDismiss(): Promise<void> {
  const win = quickChatWindow
  const sid = currentSessionId

  if (win && !win.isDestroyed()) {
    win.hide()
  }

  if (sid) {
    unregisterSession(sid)
    currentSessionId = null

    if (client) {
      try {
        // Check if session has messages
        const messages = await client.getMessages(sid)
        if (messages.length === 0) {
          // Empty session — delete it
          await client.deleteSession(sid)
        } else {
          // Has messages — generate title and archive
          try {
            await client.generateTitle(sid)
          } catch { /* title generation failed — that's OK */ }
          await client.updateSession(sid, { archived: true, quick: true })
        }
      } catch (e) {
        console.error('[quick-chat] Failed to finalize session:', e)
      }
    }
  }

  dismissing = false
}

function toggle(): void {
  const now = Date.now()
  if (now - lastToggleTime < DEBOUNCE_MS) return
  lastToggleTime = now

  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible()) {
    dismiss()
  } else {
    summon()
  }
}

export function initQuickChat(bondClient: BondClient): void {
  client = bondClient

  registerShortcut()

  // Re-register shortcut on wake and display changes
  powerMonitor.on('resume', () => registerShortcut())
  screen.on('display-added', () => registerShortcut())
  screen.on('display-removed', () => registerShortcut())

  // Handle dismiss signal from renderer
  ipcMain.handle('quickChat:dismiss', async () => {
    await finalizeDismiss()
  })
}

export function destroyQuickChat(): void {
  unregisterShortcut()

  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.destroy()
    quickChatWindow = null
  }

  if (currentSessionId) {
    unregisterSession(currentSessionId)
    currentSessionId = null
  }

  client = null
}
