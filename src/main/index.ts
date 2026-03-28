import { config as loadEnv } from 'dotenv'
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBondQuery, type BondStreamChunk } from './agent'

loadEnv({ path: join(process.cwd(), '.env'), quiet: true })

const __dirname = fileURLToPath(new URL('.', import.meta.url))

let activeAbort: AbortController | null = null

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'Bond',
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

function sendChunk(win: BrowserWindow | null, chunk: BondStreamChunk): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('bond:chunk', chunk)
  }
}

app.whenReady().then(() => {
  createWindow()

  ipcMain.handle('bond:send', async (event, text: string) => {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) {
      return { ok: false as const, error: 'Empty message' }
    }

    activeAbort?.abort()
    const ac = new AbortController()
    activeAbort = ac

    const win = BrowserWindow.fromWebContents(event.sender)

    try {
      await runBondQuery(trimmed, {
        abortSignal: ac.signal,
        onChunk: (chunk) => sendChunk(win, chunk)
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      sendChunk(win, { kind: 'raw_error', message })
      if (activeAbort === ac) activeAbort = null
      return { ok: false as const, error: message }
    }

    if (activeAbort === ac) activeAbort = null
    return { ok: true as const }
  })

  ipcMain.handle('bond:cancel', async () => {
    activeAbort?.abort()
    activeAbort = null
    return { ok: true as const }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
