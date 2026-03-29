import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBondQuery, resolvePendingApproval, clearSessionApprovals, type BondStreamChunk } from './agent'
import type { TaggedChunk } from '../shared/stream'
import {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  getMessages,
  saveMessages
} from './sessions'
import { generateTitleAndSummary } from './generate-title'
import { getSoul, saveSoul } from './settings'
import { MODEL_IDS } from '../shared/models'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const activeQueries = new Map<string, AbortController>()
let currentModel = 'sonnet'
const knownSdkSessions = new Set<string>()

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'Bond',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 20, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sendChunk(win: BrowserWindow | null, sessionId: string, chunk: BondStreamChunk): void {
  if (win && !win.isDestroyed()) {
    const tagged: TaggedChunk = { ...chunk, sessionId }
    win.webContents.send('bond:chunk', tagged)
  }
}

app.whenReady().then(() => {
  createWindow()

  // --- Chat ---
  ipcMain.handle('bond:send', async (event, text: string, sessionId?: string) => {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) {
      return { ok: false as const, error: 'Empty message' }
    }
    if (!sessionId) {
      return { ok: false as const, error: 'sessionId is required' }
    }

    // Abort any existing query for this session (not other sessions)
    const existing = activeQueries.get(sessionId)
    if (existing) {
      existing.abort()
      activeQueries.delete(sessionId)
      clearSessionApprovals(sessionId)
    }

    const ac = new AbortController()
    activeQueries.set(sessionId, ac)

    const win = BrowserWindow.fromWebContents(event.sender)
    const resumeSession = knownSdkSessions.has(sessionId)

    try {
      await runBondQuery(trimmed, {
        abortSignal: ac.signal,
        onChunk: (chunk) => sendChunk(win, sessionId, chunk),
        model: currentModel,
        sessionId,
        resumeSession
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      sendChunk(win, sessionId, { kind: 'raw_error', message })
      activeQueries.delete(sessionId)
      return { ok: false as const, error: message }
    }

    knownSdkSessions.add(sessionId)
    activeQueries.delete(sessionId)
    return { ok: true as const }
  })

  ipcMain.handle('bond:cancel', async (_e, sessionId?: string) => {
    if (sessionId) {
      const ac = activeQueries.get(sessionId)
      if (ac) {
        ac.abort()
        activeQueries.delete(sessionId)
        clearSessionApprovals(sessionId)
      }
    } else {
      // Fallback: cancel all active queries
      for (const [id, ac] of activeQueries) {
        ac.abort()
        clearSessionApprovals(id)
      }
      activeQueries.clear()
    }
    return { ok: true as const }
  })

  ipcMain.handle('bond:approvalResponse', (_e, requestId: string, approved: boolean) => {
    resolvePendingApproval(requestId, approved)
    return { ok: true as const }
  })

  // --- Model ---
  ipcMain.handle('bond:setModel', (_e, model: string) => {
    if ((MODEL_IDS as readonly string[]).includes(model)) {
      currentModel = model
    }
    return { ok: true as const }
  })

  ipcMain.handle('bond:getModel', () => currentModel)

  // --- Sessions ---
  ipcMain.handle('session:list', () => listSessions())
  ipcMain.handle('session:create', () => createSession())
  ipcMain.handle('session:get', (_e, id: string) => getSession(id))
  ipcMain.handle('session:update', (_e, id: string, updates: Record<string, unknown>) => updateSession(id, updates))
  ipcMain.handle('session:delete', (_e, id: string) => deleteSession(id))
  ipcMain.handle('session:getMessages', (_e, sessionId: string) => getMessages(sessionId))
  ipcMain.handle('session:saveMessages', (_e, sessionId: string, messages: unknown[]) => saveMessages(sessionId, messages as any))
  ipcMain.handle('session:generateTitle', async (_e, sessionId: string) => {
    const msgs = getMessages(sessionId)
    const { title, summary } = await generateTitleAndSummary(msgs)
    updateSession(sessionId, { title, summary })
    return { title, summary }
  })

  // --- Settings ---
  ipcMain.handle('settings:getSoul', () => getSoul())
  ipcMain.handle('settings:saveSoul', (_e, content: string) => saveSoul(content))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
