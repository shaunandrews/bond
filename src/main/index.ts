import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, unlinkSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { BondClient } from '../shared/client'
import type { TaggedChunk } from '../shared/stream'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// --- Paths ---

const runtimeDir = join(homedir(), '.bond')
const socketPath = join(runtimeDir, 'bond.sock')
const pidPath = join(runtimeDir, 'daemon.pid')
const logPath = join(runtimeDir, 'daemon.log')

function ensureRuntimeDir(): void {
  if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true })
}

// --- Daemon process management ---

function isDaemonRunning(): boolean {
  if (!existsSync(pidPath)) return false
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    return true
  } catch {
    try { unlinkSync(pidPath) } catch { /* ignore */ }
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath) } catch { /* ignore */ }
    }
    return false
  }
}

function getDaemonPath(): string {
  // Daemon is always pre-built to out/daemon/main.mjs
  const fromMain = join(__dirname, '../daemon/main.mjs')
  if (existsSync(fromMain)) return fromMain

  const fromRoot = join(__dirname, '../../out/daemon/main.mjs')
  if (existsSync(fromRoot)) return fromRoot

  throw new Error(`Daemon not found. Run "npm run build:daemon" first.`)
}

let daemonProcess: ChildProcess | null = null

function findSystemNode(): string {
  // process.execPath is Electron, not Node. Find the real system node.
  try {
    return execFileSync('/bin/sh', ['-c', 'which node'], { encoding: 'utf-8' }).trim()
  } catch {
    return 'node' // fall back to PATH lookup
  }
}

function spawnDaemon(): void {
  const daemonPath = getDaemonPath()
  const nodePath = findSystemNode()
  ensureRuntimeDir()
  const logFd = openSync(logPath, 'a')

  daemonProcess = spawn(nodePath, [daemonPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env }
  })

  daemonProcess.unref()
}

async function ensureDaemon(): Promise<void> {
  ensureRuntimeDir()

  if (isDaemonRunning()) return

  spawnDaemon()

  // Wait for socket to appear
  const maxWait = 5000
  const interval = 50
  let waited = 0
  while (!existsSync(socketPath) && waited < maxWait) {
    await new Promise((r) => setTimeout(r, interval))
    waited += interval
  }

  if (!existsSync(socketPath)) {
    throw new Error('Daemon failed to start — socket not created')
  }
}

// --- Client ---

let client: BondClient

async function connectClient(): Promise<void> {
  client = new BondClient(socketPath)

  let lastError: Error | undefined
  for (let i = 0; i < 10; i++) {
    try {
      await client.connect()
      return
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw lastError ?? new Error('Failed to connect to daemon')
}

// --- Window ---

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
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  client.onChunk((chunk: TaggedChunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bond:chunk', chunk)
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  await ensureDaemon()
  await connectClient()

  createWindow()

  // --- External links (stays client-side) ---
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      return shell.openExternal(url)
    }
  })

  // --- Chat (proxied to daemon) ---
  ipcMain.handle('bond:send', async (_event, text: string, sessionId?: string) => {
    return client.send(text, sessionId)
  })

  ipcMain.handle('bond:cancel', async (_e, sessionId?: string) => {
    return client.cancel(sessionId)
  })

  ipcMain.handle('bond:approvalResponse', (_e, requestId: string, approved: boolean) => {
    return client.respondToApproval(requestId, approved)
  })

  // --- Model ---
  ipcMain.handle('bond:setModel', (_e, model: string) => {
    return client.setModel(model)
  })

  ipcMain.handle('bond:getModel', () => {
    return client.getModel()
  })

  // --- Sessions ---
  ipcMain.handle('session:list', () => client.listSessions())
  ipcMain.handle('session:create', () => client.createSession())
  ipcMain.handle('session:get', (_e, id: string) => client.getSession(id))
  ipcMain.handle('session:update', (_e, id: string, updates: Record<string, unknown>) => client.updateSession(id, updates))
  ipcMain.handle('session:delete', (_e, id: string) => client.deleteSession(id))
  ipcMain.handle('session:getMessages', (_e, sessionId: string) => client.getMessages(sessionId))
  ipcMain.handle('session:saveMessages', (_e, sessionId: string, messages: unknown[]) => client.saveMessages(sessionId, messages as any))
  ipcMain.handle('session:generateTitle', (_e, sessionId: string) => client.generateTitle(sessionId))

  // --- Settings ---
  ipcMain.handle('settings:getSoul', () => client.getSoul())
  ipcMain.handle('settings:saveSoul', (_e, content: string) => client.saveSoul(content))
  ipcMain.handle('settings:getAccentColor', () => client.getAccentColor())
  ipcMain.handle('settings:saveAccentColor', (_e, hex: string) => client.saveAccentColor(hex))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Daemon keeps running — only close our client connection
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  client?.close()
})
