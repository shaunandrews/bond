import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, mkdirSync, unlinkSync, openSync, writeFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { BondClient } from '../shared/client'
import { initSense, destroySense } from './sense'
import { initTray, destroyTray } from './tray'
import { initBrowser, destroyBrowser } from './browser'
import { initQuickChat, destroyQuickChat } from './quick-chat'
import { registerWindow, registerSessionWindow, routeChunk, broadcast } from './window-router'
import type { TaggedChunk } from '../shared/stream'
import type { AttachedImage } from '../shared/session'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// --- Paths ---

const runtimeDir = join(homedir(), '.bond')
const socketPath = join(runtimeDir, 'bond.sock')
const tokenPath = join(runtimeDir, 'bond.token')
const pidPath = join(runtimeDir, 'daemon.pid')
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

function readAuthToken(): string | undefined {
  try {
    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, 'utf-8').trim()
    }
  } catch { /* ignore */ }
  return undefined
}

async function connectClient(): Promise<void> {
  const token = readAuthToken()
  client = new BondClient(socketPath, token)

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

  // Register mainWindow with the window router for chunk routing and broadcasts
  registerWindow(mainWindow)

  // Route chunks via the window router (supports quick chat and future multi-window)
  client.onChunk((chunk: TaggedChunk) => {
    routeChunk(chunk)
  })

  // Broadcast entity change events to all windows
  client.onTodoChanged(() => broadcast('bond:todoChanged'))
  client.onProjectsChanged(() => broadcast('bond:projectsChanged'))
  client.onCollectionsChanged(() => broadcast('bond:collectionsChanged'))
  // Journal changes now flow through collections channel
  client.onOperativeChanged(() => broadcast('bond:operativeChanged'))
  client.onOperativeEvent((payload) => broadcast('bond:operativeEvent', payload))

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
      await client.reconnect()
      setupAutoReconnect()
      isReconnecting = false
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
  setupAutoReconnect()
  initSense(client)
  initTray(client)
  initQuickChat(client)

  createWindow()
  initBrowser(mainWindow!, client)

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

  // --- Chat (proxied to daemon) ---
  ipcMain.handle('bond:send', async (_event, text: string, sessionId?: string, images?: AttachedImage[]) => {
    // Register the session with the window router so chunks go to the right window
    if (sessionId) {
      const senderWindow = BrowserWindow.fromWebContents(_event.sender)
      if (senderWindow) {
        registerSessionWindow(sessionId, senderWindow)
      }
    }
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
    broadcast('bond:modelChanged', model)
    return result
  })

  ipcMain.handle('bond:getModel', () => {
    return client.getModel()
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

  // --- Sessions ---
  ipcMain.handle('session:list', () => client.listSessions())
  ipcMain.handle('session:create', (_e, options?: { title?: string }) => client.createSession(options))
  ipcMain.handle('session:get', (_e, id: string) => client.getSession(id))
  ipcMain.handle('session:update', (_e, id: string, updates: Record<string, unknown>) => client.updateSession(id, updates))
  ipcMain.handle('session:delete', (_e, id: string) => client.deleteSession(id))
  ipcMain.handle('session:deleteArchived', () => client.deleteArchivedSessions())
  ipcMain.handle('session:getMessages', (_e, sessionId: string) => client.getMessages(sessionId))
  ipcMain.handle('session:saveMessages', (_e, sessionId: string, messages: unknown[]) => {
    if (isQuitting) return true
    return client.saveMessages(sessionId, messages as any)
  })
  ipcMain.handle('session:generateTitle', (_e, sessionId: string) => client.generateTitle(sessionId))

  // --- Skills ---
  ipcMain.handle('skills:list', () => client.listSkills())
  ipcMain.handle('skills:refresh', () => client.refreshSkills())
  ipcMain.handle('skills:remove', (_e, name: string) => client.removeSkill(name))

  // --- Images ---
  ipcMain.handle('image:list', () => client.listImages())
  ipcMain.handle('image:get', (_e, imageId: string) => client.getImage(imageId))
  ipcMain.handle('image:getMultiple', (_e, ids: string[]) => client.getImages(ids))
  ipcMain.handle('image:delete', (_e, imageId: string) => client.deleteImage(imageId))

  // --- Todos ---
  ipcMain.handle('todo:list', () => client.listTodos())
  ipcMain.handle('todo:create', (_e, text: string, notes?: string, group?: string, projectId?: string) => client.createTodo(text, notes, group, projectId))
  ipcMain.handle('todo:update', (_e, id: string, updates: Record<string, unknown>) => client.updateTodo(id, updates))
  ipcMain.handle('todo:delete', (_e, id: string) => client.deleteTodo(id))
  ipcMain.handle('todo:parse', (_e, raw: string) => client.parseTodo(raw))
  ipcMain.handle('todo:reorder', (_e, ids: string[]) => client.reorderTodos(ids))

  // --- Projects ---
  ipcMain.handle('project:list', () => client.listProjects())
  ipcMain.handle('project:get', (_e, id: string) => client.getProject(id))
  ipcMain.handle('project:create', (_e, name: string, goal?: string, type?: string, deadline?: string) => client.createProject(name, goal, type as any, deadline))
  ipcMain.handle('project:update', (_e, id: string, updates: Record<string, unknown>) => client.updateProject(id, updates))
  ipcMain.handle('project:delete', (_e, id: string) => client.deleteProject(id))
  ipcMain.handle('project:addResource', (_e, projectId: string, kind: string, value: string, label?: string) => client.addProjectResource(projectId, kind as any, value, label))
  ipcMain.handle('project:removeResource', (_e, id: string) => client.removeProjectResource(id))

  // --- Collections ---
  ipcMain.handle('collection:list', () => client.listCollections())
  ipcMain.handle('collection:get', (_e, id: string) => client.getCollection(id))
  ipcMain.handle('collection:create', (_e, name: string, schema: unknown[], icon?: string) => client.createCollection(name, schema as any, icon))
  ipcMain.handle('collection:update', (_e, id: string, updates: Record<string, unknown>) => client.updateCollection(id, updates))
  ipcMain.handle('collection:delete', (_e, id: string) => client.deleteCollection(id))
  ipcMain.handle('collection:renameField', (_e, id: string, oldName: string, newName: string) => client.renameCollectionField(id, oldName, newName))
  ipcMain.handle('collection:listItems', (_e, collectionId: string) => client.listCollectionItems(collectionId))
  ipcMain.handle('collection:getItem', (_e, id: string) => client.getCollectionItem(id))
  ipcMain.handle('collection:addItem', (_e, collectionId: string, data: Record<string, unknown>) => client.addCollectionItem(collectionId, data))
  ipcMain.handle('collection:updateItem', (_e, id: string, data: Record<string, unknown>) => client.updateCollectionItem(id, data))
  ipcMain.handle('collection:deleteItem', (_e, id: string) => client.deleteCollectionItem(id))
  ipcMain.handle('collection:reorderItems', (_e, ids: string[]) => client.reorderCollectionItems(ids))

  // --- Collection item comments ---
  ipcMain.handle('collection:addItemComment', (_e, itemId: string, author: string, body: string) => client.addItemComment(itemId, author as any, body))
  ipcMain.handle('collection:deleteItemComment', (_e, id: string) => client.deleteItemComment(id))

  // --- Journal (backed by Journal collection) ---
  ipcMain.handle('journal:list', (_e, opts?: Record<string, unknown>) => client.listJournalEntries(opts as any))
  ipcMain.handle('journal:get', (_e, id: string) => client.getJournalEntry(id))
  ipcMain.handle('journal:create', (_e, params: Record<string, unknown>) => client.createJournalEntry(params as any))
  ipcMain.handle('journal:update', (_e, id: string, updates: Record<string, unknown>) => client.updateJournalEntry(id, updates))
  ipcMain.handle('journal:delete', (_e, id: string) => client.deleteJournalEntry(id))
  ipcMain.handle('journal:search', (_e, query: string) => client.searchJournalEntries(query))
  ipcMain.handle('journal:generateMeta', (_e, id: string) => client.generateJournalMeta(id))
  ipcMain.handle('journal:addComment', (_e, entryId: string, author: string, body: string) => client.addJournalComment(entryId, author as any, body))
  ipcMain.handle('journal:deleteComment', (_e, id: string) => client.deleteJournalComment(id))
  ipcMain.handle('journal:generateBondComment', (_e, entryId: string) => client.generateBondComment(entryId))

  ipcMain.handle('image:readLocal', (_e, filePath: string): string | null => {
    if (!isAllowedPath(filePath)) return null
    const EXT_TO_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
    const mime = EXT_TO_MIME[ext]
    if (!mime || !existsSync(filePath)) return null
    const data = readFileSync(filePath).toString('base64')
    return `data:${mime};base64,${data}`
  })

  // --- Settings ---
  ipcMain.handle('settings:getSoul', () => client.getSoul())
  ipcMain.handle('settings:saveSoul', (_e, content: string) => client.saveSoul(content))
  ipcMain.handle('settings:getAccentColor', () => client.getAccentColor())
  ipcMain.handle('settings:saveAccentColor', async (_e, hex: string) => {
    const result = await client.saveAccentColor(hex)
    broadcast('bond:accentColor', hex)
    return result
  })
  ipcMain.handle('settings:getWindowOpacity', () => client.getWindowOpacity())
  ipcMain.handle('settings:saveWindowOpacity', async (_e, opacity: number) => {
    const result = await client.saveWindowOpacity(opacity)
    broadcast('bond:windowOpacity', opacity)
    return result
  })

  // Sense IPC handlers — proxy to daemon via BondClient
  ipcMain.handle('sense:status', () => client.senseStatus())
  ipcMain.handle('sense:enable', () => client.senseEnable())
  ipcMain.handle('sense:disable', () => client.senseDisable())
  ipcMain.handle('sense:pause', (_e, minutes?: number) => client.sensePause(minutes))
  ipcMain.handle('sense:resume', () => client.senseResume())
  ipcMain.handle('sense:now', () => client.senseNow())
  ipcMain.handle('sense:today', () => client.senseToday())
  ipcMain.handle('sense:search', (_e, query: string, limit?: number) => client.senseSearch(query, limit))
  ipcMain.handle('sense:apps', (_e, range?: string) => client.senseApps(range))
  ipcMain.handle('sense:timeline', (_e, from?: string, to?: string, limit?: number) => client.senseTimeline(from, to, limit))
  ipcMain.handle('sense:capture', (_e, id: string) => client.senseCapture(id))
  ipcMain.handle('sense:sessions', (_e, from?: string, to?: string) => client.senseSessions(from, to))
  ipcMain.handle('sense:settings', () => client.senseSettings())
  ipcMain.handle('sense:updateSettings', (_e, updates: Record<string, unknown>) => client.senseUpdateSettings(updates))
  ipcMain.handle('sense:clear', (_e, range?: { from?: string; to?: string }) => client.senseClear(range))
  ipcMain.handle('sense:stats', () => client.senseStats())
  ipcMain.handle('sense:hasPermission', () => {
    const { hasScreenRecordingPermission } = require('./sense') as typeof import('./sense')
    return hasScreenRecordingPermission()
  })

  // --- Operatives ---
  ipcMain.handle('operative:list', (_e, filters?) => client.listOperatives(filters))
  ipcMain.handle('operative:get', (_e, id: string) => client.getOperative(id))
  ipcMain.handle('operative:spawn', (_e, opts) => client.spawnOperative(opts))
  ipcMain.handle('operative:events', (_e, id: string, afterId?: number, limit?: number) => client.getOperativeEvents(id, afterId, limit))
  ipcMain.handle('operative:cancel', (_e, id: string) => client.cancelOperative(id))
  ipcMain.handle('operative:remove', (_e, id: string) => client.removeOperative(id))
  ipcMain.handle('operative:clear', (_e, status?: string) => client.clearOperatives(status))

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
  destroyBrowser()
  client?.close()
})
