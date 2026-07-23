import { contextBridge, ipcRenderer } from 'electron'
import { buildDaemonSurface, type BondSurface, type ElectronBondSurface, type RpcInvoker } from '../shared/bond-surface'
import type { TaggedChunk } from '../shared/stream'
import type { DeskBridge } from '../shared/desk-window'

/**
 * `window.bond` = daemon proxies (built from the shared surface builder over
 * the generic bond:rpc channel) + main-process-local methods and event
 * registrars (hand-written IPC below, typed as ElectronBondSurface so the
 * compiler enforces completeness against the browser shim).
 */

const invokeRpc: RpcInvoker = (method, params) => ipcRenderer.invoke('bond:rpc', method, params)

/** ipcRenderer.on wrapper returning a disposer, dropping the event arg. */
function listen<Args extends unknown[]>(channel: string, fn: (...args: Args) => void): () => void {
  const listener = (_: Electron.IpcRendererEvent, ...args: Args) => fn(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const electronLocalMethods: ElectronBondSurface = {
  // Push events
  onChunk: (fn: (chunk: TaggedChunk) => void) => listen('bond:chunk', fn),
  onModelChanged: (fn) => listen('bond:modelChanged', fn),
  onCollectionsChanged: (fn) => listen('bond:collectionsChanged', fn),
  onImageChanged: (fn) => listen('bond:imageChanged', fn),
  onLibraryChanged: (fn) => listen('bond:libraryChanged', fn),
  onMcpChanged: (fn) => listen('bond:mcpChanged', fn),
  onDeskChanged: (fn) => listen('bond:deskChanged', fn),
  onThreadChanged: (fn) => listen('bond:threadChanged', fn),
  onViewerFile: (fn) => listen('bond:viewerFile', fn),
  onCreateSkill: (fn) => listen('bond:createSkill', fn),
  onFullscreenChanged: (fn) => listen('bond:fullscreenChanged', fn),
  onConnectionLost: (fn) => listen('bond:connectionLost', fn),
  onConnectionRestored: (fn) => listen('bond:connectionRestored', fn),
  onAccentColor: (fn) => listen('bond:accentColor', fn),
  onWindowOpacity: (fn) => listen('bond:windowOpacity', fn),

  // Daemon proxies with main-side broadcast side effects — dedicated channels.
  setModel: (model) => ipcRenderer.invoke('bond:setModel', model),
  saveAccentColor: (hex) => ipcRenderer.invoke('settings:saveAccentColor', hex),
  saveWindowOpacity: (opacity) => ipcRenderer.invoke('settings:saveWindowOpacity', opacity),

  // Native UI + windows
  showContextMenu: (items) => ipcRenderer.invoke('context-menu:show', items),
  openSettings: () => ipcRenderer.invoke('window:openSettings'),
  openDesk: (opts) => ipcRenderer.invoke('desk:open', opts),
  openViewer: (filePath, format, title) => ipcRenderer.invoke('viewer:open', filePath, format, title),
  createSkillViaChat: (description) => ipcRenderer.invoke('settings:createSkillViaChat', description),
  // Local filesystem + shell
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  readLocalImage: (filePath) => ipcRenderer.invoke('image:readLocal', filePath),
  captureScreenshot: (outputPath) => ipcRenderer.invoke('dev:captureScreenshot', outputPath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  revealInFinder: (filePath) => ipcRenderer.invoke('shell:revealInFinder', filePath),

  // Permissions
  hasScreenRecordingPermission: () => ipcRenderer.invoke('sense:hasPermission'),

  resizeContent: (options) => ipcRenderer.invoke('window:resizeContent', options),
}

const surface: BondSurface = {
  ...buildDaemonSurface(invokeRpc),
  ...electronLocalMethods,
}

contextBridge.exposeInMainWorld('bond', surface)

/**
 * The Desk window's own tiny bridge. Deliberately NOT part of BondSurface —
 * it is window plumbing (geometry, hit regions), not product API, and forcing
 * the web shim to stub it would be noise.
 */
const deskBridge: DeskBridge = {
  setHotRects: (rects) => ipcRenderer.send('desk:setHotRects', rects),
  onHover: (fn) => listen('desk:hover', fn),
  onGeometry: (fn) => listen('desk:geometry', fn),
  ready: () => ipcRenderer.send('desk:ready'),
}

contextBridge.exposeInMainWorld('desk', deskBridge)
