import type { WebBondClient } from './client'
import { buildDaemonSurface, type BondSurface, type ElectronBondSurface, type RpcInvoker } from '../../shared/bond-surface'
import type { ModelId } from '../../shared/models'

/**
 * Builds a `window.bond` for the browser on top of WebBondClient, so the
 * existing renderer components run unchanged. Daemon proxies come from the
 * shared surface builder (the same one the desktop preload uses), invoked
 * directly over the WebSocket; Electron-only methods become safe stand-ins
 * (openExternal uses window.open). The three settings-change events the
 * desktop app synthesizes in its main process (model/accent/opacity) are
 * emitted locally right after this client's own save, since the daemon never
 * broadcasts them.
 */
export function buildBondShim(client: WebBondClient): BondSurface {
  const noopDisposer = () => () => {}

  // Local stand-ins for the desktop app's cross-window setting broadcasts.
  const modelListeners = new Set<(model: string) => void>()
  const accentListeners = new Set<(hex: string) => void>()
  const opacityListeners = new Set<(opacity: number) => void>()

  // The tuple cast is the generic invoker boundary: RpcParamsArg<M> cannot be
  // resolved for an open M, but the runtime shape is identical.
  const invoke: RpcInvoker = (method, params) => client.call(method, ...([params] as never))

  const electronStubs: ElectronBondSurface = {
    // Push events — real wiring over WebBondClient notifications/state.
    onChunk: (fn) => client.onChunk(fn),
    onCollectionsChanged: (fn) => client.onNotification('collection.changed', () => fn()),
    onImageChanged: (fn) => client.onNotification('image.changed', () => fn()),
    onConnectionLost: (fn) => client.onStateChange((state) => { if (state === 'disconnected') fn() }),
    onConnectionRestored: (fn) => {
      let wasLost = false
      return client.onStateChange((state) => {
        if (state === 'disconnected') wasLost = true
        else if (state === 'connected' && wasLost) { wasLost = false; fn() }
      })
    },
    onModelChanged: (fn) => {
      modelListeners.add(fn)
      return () => { modelListeners.delete(fn) }
    },
    onAccentColor: (fn) => {
      accentListeners.add(fn)
      return () => { accentListeners.delete(fn) }
    },
    onWindowOpacity: (fn) => {
      opacityListeners.add(fn)
      return () => { opacityListeners.delete(fn) }
    },
    onViewerFile: noopDisposer,
    onCreateSkill: noopDisposer,
    onFullscreenChanged: noopDisposer,
    onQuickChatInit: noopDisposer,
    onQuickChatDismiss: noopDisposer,

    // Broadcast-side-effect trio: call the daemon, then emit locally like the
    // desktop main process broadcasts to its windows.
    setModel: async (model) => {
      const result = await client.call('bond.setModel', { model: model as ModelId })
      for (const fn of modelListeners) fn(model)
      return result
    },
    saveAccentColor: async (hex) => {
      const result = await client.call('settings.saveAccentColor', { hex })
      for (const fn of accentListeners) fn(hex)
      return result
    },
    saveWindowOpacity: async (opacity) => {
      const result = await client.call('settings.saveWindowOpacity', { opacity })
      for (const fn of opacityListeners) fn(opacity)
      return result
    },

    // Local filesystem and window management don't exist in a browser.
    showContextMenu: async () => null,
    openSettings: async () => {},
    openViewer: async () => {},
    createSkillViaChat: async () => {},
    quickChatDismissed: async () => {},
    readFile: async () => null,
    readLocalImage: async () => null,
    captureScreenshot: async () => '',
    openExternal: async (url) => { window.open(url, '_blank', 'noopener') },
    openPath: async () => '',
    hasScreenRecordingPermission: async () => false,
  }

  return {
    ...buildDaemonSurface(invoke),
    ...electronStubs,
    // Route subscribe through WebBondClient so it remembers the global
    // subscription and re-subscribes after every reconnect.
    subscribe: (sessionId?: string) => client.subscribe(sessionId),
  }
}
