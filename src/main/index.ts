import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, unlinkSync, openSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { BondClient } from '../shared/client'
import type { TaggedChunk } from '../shared/stream'
import type { AttachedImage } from '../shared/session'

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

// --- Windows ---

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
      sandbox: false,
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
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

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  // Center settings window on the same display as the main window
  const parentBounds = mainWindow?.getBounds()
  const display = parentBounds
    ? require('electron').screen.getDisplayMatching(parentBounds)
    : require('electron').screen.getPrimaryDisplay()
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea
  const sw = 600, sh = 580

  settingsWindow = new BrowserWindow({
    width: sw,
    height: sh,
    x: Math.round(dx + (dw - sw) / 2),
    y: Math.round(dy + (dh - sh) / 2),
    minWidth: 480,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    title: 'Settings',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  settingsWindow.on('ready-to-show', () => {
    settingsWindow!.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void settingsWindow.loadURL(`${devUrl}/settings.html`)
  } else {
    void settingsWindow.loadFile(join(__dirname, '../renderer/settings.html'))
  }
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  await ensureDaemon()
  await connectClient()

  createWindow()

  // --- Dev: capture screenshot via file trigger ---
  // Touch /tmp/bond-capture to trigger, result lands at /tmp/bond-screenshot.png
  const captureTrigger = '/tmp/bond-capture'
  const captureOutput = '/tmp/bond-screenshot.png'
  const { watch } = await import('node:fs')
  // Clean up stale trigger on startup
  try { unlinkSync(captureTrigger) } catch { /* ignore */ }
  watch('/tmp', (_eventType, filename) => {
    if (filename !== 'bond-capture') return
    if (!existsSync(captureTrigger)) return
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    win.webContents.capturePage().then((image) => {
      writeFileSync(captureOutput, image.toPNG())
      try { unlinkSync(captureTrigger) } catch { /* ignore */ }
    })
  })

  ipcMain.handle('dev:captureScreenshot', async (_e, outputPath: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('No window available')
    const image = await win.webContents.capturePage()
    writeFileSync(outputPath, image.toPNG())
    return outputPath
  })

  // --- Settings window ---
  ipcMain.handle('window:openSettings', () => {
    createSettingsWindow()
  })

  ipcMain.handle('settings:createSkillViaChat', (_e, description: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bond:createSkill', description)
      mainWindow.focus()
    }
  })

  // --- External links (stays client-side) ---
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      return shell.openExternal(url)
    }
  })

  // --- Chat (proxied to daemon) ---
  ipcMain.handle('bond:send', async (_event, text: string, sessionId?: string, images?: AttachedImage[]) => {
    return client.send(text, sessionId, images)
  })

  ipcMain.handle('bond:cancel', async (_e, sessionId?: string) => {
    return client.cancel(sessionId)
  })

  ipcMain.handle('bond:approvalResponse', (_e, requestId: string, approved: boolean) => {
    return client.respondToApproval(requestId, approved)
  })

  // --- Model ---
  ipcMain.handle('bond:setModel', async (_e, model: string) => {
    const result = await client.setModel(model)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bond:modelChanged', model)
    }
    return result
  })

  ipcMain.handle('bond:getModel', () => {
    return client.getModel()
  })

  // --- Sessions ---
  ipcMain.handle('session:list', () => client.listSessions())
  ipcMain.handle('session:create', (_e, options?: { siteId?: string; title?: string }) => client.createSession(options))
  ipcMain.handle('session:get', (_e, id: string) => client.getSession(id))
  ipcMain.handle('session:update', (_e, id: string, updates: Record<string, unknown>) => client.updateSession(id, updates))
  ipcMain.handle('session:delete', (_e, id: string) => client.deleteSession(id))
  ipcMain.handle('session:getMessages', (_e, sessionId: string) => client.getMessages(sessionId))
  ipcMain.handle('session:saveMessages', (_e, sessionId: string, messages: unknown[]) => client.saveMessages(sessionId, messages as any))
  ipcMain.handle('session:generateTitle', (_e, sessionId: string) => client.generateTitle(sessionId))

  // --- Skills ---
  ipcMain.handle('skills:list', () => client.listSkills())
  ipcMain.handle('skills:refresh', () => client.refreshSkills())
  ipcMain.handle('skills:remove', (_e, name: string) => client.removeSkill(name))

  // --- Images ---
  ipcMain.handle('image:get', (_e, imageId: string) => client.getImage(imageId))
  ipcMain.handle('image:getMultiple', (_e, ids: string[]) => client.getImages(ids))

  ipcMain.handle('image:readLocal', (_e, filePath: string): string | null => {
    const EXT_TO_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
    const mime = EXT_TO_MIME[ext]
    if (!mime || !existsSync(filePath)) return null
    const data = readFileSync(filePath).toString('base64')
    return `data:${mime};base64,${data}`
  })

  // --- WordPress ---
  ipcMain.handle('wordpress:list', () => client.listWordPressSites())
  ipcMain.handle('wordpress:details', (_e, path: string) => client.getWordPressSiteDetails(path))
  ipcMain.handle('wordpress:create', (_e, name: string) => client.createWordPressSite(name))
  ipcMain.handle('wordpress:delete', (_e, path: string) => client.deleteWordPressSite(path))
  ipcMain.handle('wordpress:start', (_e, path: string) => client.startWordPressSite(path))
  ipcMain.handle('wordpress:stop', (_e, path: string) => client.stopWordPressSite(path))

  // --- Settings ---
  ipcMain.handle('settings:getSoul', () => client.getSoul())
  ipcMain.handle('settings:saveSoul', (_e, content: string) => client.saveSoul(content))
  ipcMain.handle('settings:getAccentColor', () => client.getAccentColor())
  ipcMain.handle('settings:saveAccentColor', async (_e, hex: string) => {
    const result = await client.saveAccentColor(hex)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bond:accentColor', hex)
    }
    return result
  })
  ipcMain.handle('settings:getWindowOpacity', () => client.getWindowOpacity())
  ipcMain.handle('settings:saveWindowOpacity', async (_e, opacity: number) => {
    const result = await client.saveWindowOpacity(opacity)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bond:windowOpacity', opacity)
    }
    return result
  })

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
