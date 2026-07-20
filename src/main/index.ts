import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, mkdirSync, unlinkSync, openSync, writeFileSync, appendFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { BondClient } from '../shared/client'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { RPC_METHOD_NAMES, type DispatchableMethod } from '../shared/rpc-schema'
import { initSense, destroySense } from './sense'
import { initWeb, destroyWeb } from './web'
import { initTray, destroyTray } from './tray'
import { initQuickChat, destroyQuickChat } from './quick-chat'
import { registerWindow, registerSessionWindow, routeChunk, broadcast } from './window-router'
import type { TaggedChunk } from '../shared/stream'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// --- Paths ---

const runtimeDir = join(homedir(), '.bond')
const socketPath = join(runtimeDir, 'bond.sock')
const tokenPath = join(runtimeDir, 'bond.token')
const logPath = join(runtimeDir, 'daemon.log')
const dataDir = join(homedir(), 'Library', 'Application Support', 'bond')

/** Allowed base directories for file:read and image:readLocal */
const ALLOWED_READ_ROOTS = [dataDir, runtimeDir]

function isAllowedPath(filePath: string): boolean {
  const resolved = resolve(filePath)
  return ALLOWED_READ_ROOTS.some(root => resolved.startsWith(root + '/') || resolved === root)
}

function ensureRuntimeDir(): void {
  if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true })
}

// --- Daemon process management ---

/**
 * A daemon is running iff something accepts connections on the socket — a
 * pid file can only describe one process and lies whenever another daemon
 * exists (that's how zombies used to accumulate). Never delete the socket
 * or pid file from here: the daemon owns its runtime files, and a spawn
 * race is safe because the daemon's own claim logic makes the loser bow out.
 */
function isDaemonRunning(): Promise<boolean> {
  return new Promise((resolveAlive) => {
    const sock = netConnect(socketPath)
    let settled = false
    const done = (alive: boolean): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolveAlive(alive)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(500, () => done(true))
  })
}

function getDaemonPath(): string {
  // Packaged app: daemon is in Contents/Resources/daemon/
  if (app.isPackaged) {
    return join(process.resourcesPath, 'daemon', 'main.mjs')
  }

  // Dev mode: daemon is pre-built to out/daemon/main.mjs
  const fromMain = join(__dirname, '../daemon/main.mjs')
  if (existsSync(fromMain)) return fromMain

  const fromRoot = join(__dirname, '../../out/daemon/main.mjs')
  if (existsSync(fromRoot)) return fromRoot

  throw new Error(`Daemon not found. Run "npm run build:daemon" first.`)
}

let daemonProcess: ChildProcess | null = null

function findSystemNode(): string {
  // process.execPath is Electron, not Node. Find the real system node.
  // When launched from Finder, PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin)
  // so we use a login shell to pick up nvm/fnm/volta/brew paths from ~/.zshrc.
  try {
    const fromShell = execFileSync('/bin/zsh', ['-l', '-c', 'which node'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim()
    if (fromShell && existsSync(fromShell)) return fromShell
  } catch { /* fall through to well-known paths */ }

  // Fallback: check common install locations directly
  const candidates = [
    '/opt/homebrew/bin/node',   // Homebrew on Apple Silicon
    '/usr/local/bin/node',      // Homebrew on Intel / manual install
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    'Node.js not found. Bond requires Node.js to run.\n' +
    'Install it from https://nodejs.org or via Homebrew: brew install node'
  )
}

function resolveUserPath(): string {
  // Finder-launched apps get minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
  // Resolve the full user PATH via login shell, same approach as findSystemNode().
  try {
    const fullPath = execFileSync('/bin/zsh', ['-l', '-c', 'echo $PATH'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim()
    if (fullPath) return fullPath
  } catch { /* fall through */ }

  // Fallback: augment current PATH with common locations
  const current = process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'
  const extras = ['/opt/homebrew/bin', '/usr/local/bin']
  const parts = current.split(':')
  for (const extra of extras) {
    if (!parts.includes(extra)) parts.push(extra)
  }
  return parts.join(':')
}

function spawnDaemon(): void {
  const daemonPath = getDaemonPath()
  const nodePath = findSystemNode()
  ensureRuntimeDir()
  const logFd = openSync(logPath, 'a')

  // In packaged mode, daemon deps live alongside daemon/main.mjs.
  // NODE_PATH ensures CJS require() can find them as a fallback.
  // PATH must be resolved from a login shell so the daemon can find
  // user-installed binaries.
  const daemonDir = join(daemonPath, '..')
  const daemonNodeModules = join(daemonDir, 'node_modules')
  const env: Record<string, string | undefined> = { ...process.env }
  if (app.isPackaged) {
    env.PATH = resolveUserPath()
    if (existsSync(daemonNodeModules)) {
      env.NODE_PATH = daemonNodeModules
    }
  }

  daemonProcess = spawn(nodePath, [daemonPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env
  })

  daemonProcess.unref()
}

async function ensureDaemon(): Promise<void> {
  ensureRuntimeDir()

  if (await isDaemonRunning()) return

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

function readAuthToken(): string | undefined {
  try {
    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, 'utf-8').trim()
    }
  } catch { /* ignore */ }
  return undefined
}

/**
 * Hard-fail on protocol skew: the daemon deliberately outlives app updates
 * (launchd KeepAlive), and a mismatched pair fails per-call with "Unknown
 * method" — some features silently broken beats nothing visibly broken.
 */
function daemonProtocolMismatch(): boolean {
  const version = client.daemonProtocolVersion
  return version !== null && version !== PROTOCOL_VERSION
}

function showProtocolMismatchDialog(): void {
  dialog.showErrorBox(
    'Bond daemon is out of date',
    `The running Bond daemon speaks protocol ${client.daemonProtocolVersion || 'pre-1'} but this app needs ${PROTOCOL_VERSION}.\n\nRun "bin/bond restart" (dev) or log out and back in, then reopen Bond.`
  )
}

async function connectClient(): Promise<void> {
  client = new BondClient(socketPath, readAuthToken)

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
const viewerWindows = new Map<string, BrowserWindow>()
const viewerWatchers = new Map<string, FSWatcher>()

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
    trafficLightPosition: { x: 20, y: 16 },
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

  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('bond:fullscreenChanged', true)
  })

  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('bond:fullscreenChanged', false)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Dev-only: mirror renderer [entrance] logs and errors to a file so the
  // first-run entrance can be diagnosed without opening DevTools.
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_event, level, message) => {
      if (!message.includes('[entrance]') && level < 3) return
      try {
        appendFileSync('/tmp/bond-renderer.log', `${new Date().toISOString()} [${level}] ${message}\n`)
      } catch { /* best effort */ }
    })
  }

  // Register mainWindow with the window router for chunk routing and broadcasts
  registerWindow(mainWindow)

  // Route chunks via the window router (supports quick chat and future multi-window)
  client.onChunk((chunk: TaggedChunk) => {
    routeChunk(chunk)
  })

  // Broadcast entity change events to all windows
  client.onCollectionsChanged(() => broadcast('bond:collectionsChanged'))
  client.onImageChanged(() => broadcast('bond:imageChanged'))
  client.onMcpChanged(() => broadcast('bond:mcpChanged'))
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * New-user simulation = the REAL app running against an isolated, empty
 * sandbox data directory in the daemon. Entering swaps the data set and
 * reloads the window so the genuine first-run experience triggers naturally;
 * exiting restores the real data and reloads again.
 */
let simulationActive = false

function reloadIntoCurrentData(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else {
    mainWindow.webContents.reload()
    mainWindow.focus()
  }
}

/**
 * Flag the current page to skip its beforeunload transcript persistence.
 * Must complete BEFORE the daemon's data swap: otherwise the dying page's
 * persist fires against the post-swap data set and leaks the real transcript
 * into the sandbox (which then no longer looks like a fresh install).
 * executeJavaScript resolves only after the script ran, so this is a
 * synchronous guarantee inside the page.
 */
async function suppressRendererPersist(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    await mainWindow.webContents.executeJavaScript('window.__bondSuppressPersist = true; true')
  } catch { /* page unloaded or unresponsive — nothing left to persist */ }
}

async function enterNewUserSimulation(): Promise<void> {
  if (simulationActive) return
  await suppressRendererPersist()
  await client.sandboxEnter()
  simulationActive = true
  buildApplicationMenu()
  reloadIntoCurrentData()
}

async function exitNewUserSimulation(): Promise<void> {
  if (!simulationActive) {
    // The daemon may be sandboxed from a previous window session — trust it.
    const status = await client.sandboxStatus()
    if (!status.sandboxed) return
  }
  await suppressRendererPersist()
  await client.sandboxExit()
  simulationActive = false
  buildApplicationMenu()
  reloadIntoCurrentData()
}

function toggleNewUserSimulation(): void {
  void (simulationActive ? exitNewUserSimulation() : enterNewUserSimulation()).catch(error => {
    console.error('[bond] new-user simulation toggle failed:', error)
  })
}

/**
 * Install the native application (menu-bar) menu. Bond ships no custom menu
 * otherwise, so this reproduces the standard macOS menus and adds the
 * "Run New-User Simulation" action at the OS level (not in in-app Settings).
 */
function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { label: simulationActive ? 'Exit New-User Simulation' : 'Run New-User Simulation', accelerator: 'CommandOrControl+Alt+N', click: () => toggleNewUserSimulation() },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' as const }, { role: 'delete' as const }, { role: 'selectAll' as const }]
          : [{ role: 'delete' as const }, { type: 'separator' as const }, { role: 'selectAll' as const }]),
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(!isMac ? [{ label: simulationActive ? 'Exit New-User Simulation' : 'Run New-User Simulation', accelerator: 'CommandOrControl+Alt+N', click: () => toggleNewUserSimulation() }, { type: 'separator' as const }] : []),
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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

function createViewerWindow(filePath: string): void {
  // Reuse existing viewer for the same file
  const existing = viewerWindows.get(filePath)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }

  const parentBounds = mainWindow?.getBounds()
  const display = parentBounds
    ? require('electron').screen.getDisplayMatching(parentBounds)
    : require('electron').screen.getPrimaryDisplay()
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea
  const vw = 700, vh = 600

  const filename = filePath.split('/').pop() ?? 'Viewer'

  const win = new BrowserWindow({
    width: vw,
    height: vh,
    x: Math.round(dx + (dw - vw) / 2),
    y: Math.round(dy + (dh - vh) / 2),
    minWidth: 400,
    minHeight: 300,
    show: false,
    autoHideMenuBar: true,
    title: filename,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  viewerWindows.set(filePath, win)

  win.on('ready-to-show', () => {
    win.show()
    win.webContents.send('bond:viewerFile', filePath)

    // Watch the file for changes and push updates to the viewer.
    // Some editors do atomic saves (write tmp + rename), which fires 'rename'
    // and can invalidate the watcher. On rename, re-establish the watch.
    function startWatching(): void {
      try {
        const watcher = watch(filePath, { persistent: false }, (eventType) => {
          if (win.isDestroyed()) return
          if (eventType === 'change') {
            win.webContents.send('bond:viewerFile', filePath)
          } else if (eventType === 'rename') {
            watcher.close()
            viewerWatchers.delete(filePath)
            // Re-read immediately (file was replaced)
            if (existsSync(filePath)) {
              win.webContents.send('bond:viewerFile', filePath)
              setTimeout(startWatching, 100)
            }
          }
        })
        viewerWatchers.set(filePath, watcher)
      } catch { /* file may not exist yet */ }
    }
    startWatching()
  })

  win.on('closed', () => {
    viewerWindows.delete(filePath)
    const watcher = viewerWatchers.get(filePath)
    if (watcher) {
      watcher.close()
      viewerWatchers.delete(filePath)
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}/viewer.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/viewer.html'))
  }
}

// --- App lifecycle ---

let isReconnecting = false
let isQuitting = false

function setupAutoReconnect(): void {
  client.onDisconnect(() => {
    if (isQuitting || isReconnecting) return
    isReconnecting = true
    console.warn('[bond] daemon connection lost, attempting reconnect...')
    broadcast('bond:connectionLost')
    attemptReconnect()
  })
}

async function attemptReconnect(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      await ensureDaemon()
      // Reconnect the SAME client instance: its token provider re-reads the
      // restarted daemon's fresh token, and every registered push listener
      // (chunks, sense, web renders, tray, quick chat) survives. Recreating
      // the client here once silently severed all of them until app relaunch.
      await client.reconnect()
      isReconnecting = false
      if (daemonProtocolMismatch()) {
        showProtocolMismatchDialog()
        app.quit()
        return
      }
      console.log('[bond] reconnected to daemon')
      broadcast('bond:connectionRestored')
      return
    } catch {
      // Keep trying
    }
  }
  isReconnecting = false
  console.error('[bond] failed to reconnect after 30 attempts')
}

// Prevent duplicate instances — second launch focuses the existing window
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(async () => {
  await ensureDaemon()
  await connectClient()
  if (daemonProtocolMismatch()) {
    showProtocolMismatchDialog()
    app.quit()
    return
  }
  setupAutoReconnect()
  initSense(client)
  initWeb(client)
  initTray(client)
  initQuickChat(client)

  createWindow()
  try {
    simulationActive = (await client.sandboxStatus()).sandboxed
  } catch { /* older daemon without sandbox support */ }
  buildApplicationMenu()

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

  ipcMain.handle('shell:openPath', (_e, filePath: string) => {
    if (typeof filePath === 'string') {
      return shell.openPath(filePath)
    }
  })

  ipcMain.handle('viewer:open', (_e, filePath: string) => {
    if (typeof filePath === 'string') {
      createViewerWindow(filePath)
    }
  })

  ipcMain.handle('file:read', (_e, filePath: string): string | null => {
    if (typeof filePath !== 'string') return null
    if (!isAllowedPath(filePath)) return null
    try {
      if (!existsSync(filePath)) return null
      return readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  })

  // --- Daemon proxies: one generic channel, registry-gated ---
  // Every pure daemon proxy on window.bond rides bond:rpc (see
  // src/shared/bond-surface.ts). Only methods with main-side broadcast side
  // effects keep dedicated channels below.
  const RPC_METHODS = new Set<string>(RPC_METHOD_NAMES)
  ipcMain.handle('bond:rpc', (event, method: string, params: unknown) => {
    if (!RPC_METHODS.has(method) || method === 'bond.auth') {
      throw new Error(`Unknown RPC method: ${method}`)
    }
    if (method === 'bond.send') {
      // Legacy session windows still register for the old renderer until the UI cutover lands.
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId
      if (sessionId) {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win) registerSessionWindow(sessionId, win)
      }
    }
    return client.call(method as DispatchableMethod, params as never)
  })

  // --- Model (broadcasts to all windows after the daemon call) ---
  ipcMain.handle('bond:setModel', async (_e, model: string) => {
    const result = await client.setModel(model)
    broadcast('bond:modelChanged', model)
    return result
  })

  // --- Context menu ---
  ipcMain.handle('context-menu:show', (_e, items: { id: string; label: string; type?: string }[]) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    return new Promise<string | null>(resolve => {
      const template = items.map(item => {
        if (item.type === 'separator') return { type: 'separator' as const }
        return { label: item.label, click: () => resolve(item.id) }
      })
      const menu = Menu.buildFromTemplate(template)
      menu.popup({ window: win, callback: () => resolve(null) })
    })
  })

  ipcMain.handle('image:readLocal', (_e, filePath: string): string | null => {
    if (!isAllowedPath(filePath)) return null
    const EXT_TO_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
    const mime = EXT_TO_MIME[ext]
    if (!mime || !existsSync(filePath)) return null
    const data = readFileSync(filePath).toString('base64')
    return `data:${mime};base64,${data}`
  })

  // --- Settings with main-side broadcast (all windows react to the change) ---
  ipcMain.handle('settings:saveAccentColor', async (_e, hex: string) => {
    const result = await client.saveAccentColor(hex)
    broadcast('bond:accentColor', hex)
    return result
  })
  ipcMain.handle('settings:saveWindowOpacity', async (_e, opacity: number) => {
    const result = await client.saveWindowOpacity(opacity)
    broadcast('bond:windowOpacity', opacity)
    return result
  })

  ipcMain.handle('sense:hasPermission', () => {
    const { hasScreenRecordingPermission } = require('./sense') as typeof import('./sense')
    return hasScreenRecordingPermission()
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
  isQuitting = true
  destroyQuickChat()
  destroyTray()
  destroySense()
  destroyWeb()
  client?.close()
})
