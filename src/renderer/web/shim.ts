import type { WebBondClient } from './client'
import type { BondSendInput } from '../../shared/stream'
import type { AttachedImage, EditMode } from '../../shared/session'

/**
 * Builds a `window.bond` for the browser on top of WebBondClient, so the
 * existing renderer components run unchanged. Methods that map to daemon RPCs
 * go straight through; Electron-only methods become safe no-ops (openExternal
 * uses window.open). The three settings-change events the desktop app
 * synthesizes in its main process (model/accent/opacity) are emitted locally
 * right after this client's own save, since the daemon never broadcasts them.
 */
export function buildBondShim(client: WebBondClient): Window['bond'] {
  const noopDisposer = () => () => {}

  // Local stand-ins for the desktop app's cross-window setting broadcasts.
  const modelListeners = new Set<(model: string) => void>()
  const accentListeners = new Set<(hex: string) => void>()
  const opacityListeners = new Set<(opacity: number) => void>()

  return {
    send: ((inputOrText: BondSendInput | string, sessionId?: string, images?: AttachedImage[]) =>
      client.call('bond.send', typeof inputOrText === 'string' ? { text: inputOrText, sessionId, images } : inputOrText)) as Window['bond']['send'],
    cancel: (sessionId?: string) => client.call('bond.cancel', sessionId ? { sessionId } : undefined),
    respondToApproval: (requestId: string, approved: boolean) => client.call('bond.approvalResponse', { requestId, approved }),
    subscribe: (sessionId?: string) => client.subscribe(sessionId),
    unsubscribe: (sessionId?: string) => client.call('bond.unsubscribe', sessionId ? { sessionId } : undefined),
    onChunk: (fn) => client.onChunk(fn),

    listTranscript: (options) => client.call('transcript.list', options),
    upsertTranscript: (messages) => client.call('transcript.upsert', { messages }),
    searchTranscript: (query, limit) => client.call('transcript.search', { query, limit }),
    createSession: (options) => client.call('session.create', options),

    listImages: () => client.call('image.list'),
    getImage: (imageId) => client.call('image.get', { id: imageId }),
    getImages: (ids) => client.call('image.getMultiple', { ids }),
    importImage: (data, mediaType) => client.call('image.import', { data, mediaType }),
    deleteImage: (imageId) => client.call('image.delete', { id: imageId }),
    onImageChanged: (fn) => client.onNotification('image.changed', () => fn()),

    listSkills: () => client.call('skills.list'),
    refreshSkills: () => client.call('skills.refresh'),
    removeSkill: (name) => client.call('skills.remove', { name }),

    // Local filesystem and window management don't exist in a browser.
    readLocalImage: async () => null,
    captureScreenshot: async () => '',
    openExternal: async (url: string) => { window.open(url, '_blank', 'noopener') },
    openPath: async () => '',
    openViewer: async () => {},
    readFile: async () => null,
    onViewerFile: noopDisposer,
    openSettings: async () => {},
    createSkillViaChat: async () => {},
    onCreateSkill: noopDisposer,

    setModel: async (model) => {
      const result = await client.call<{ ok: boolean }>('bond.setModel', { model })
      for (const fn of modelListeners) fn(model)
      return result
    },
    getModel: () => client.call('bond.getModel'),
    getEditMode: () => client.call('settings.getEditMode'),
    setEditMode: (editMode: EditMode) => client.call('settings.setEditMode', { editMode }),
    getPiStatus: () => client.call('pi.status'),
    startPiOAuth: (provider) => client.call('pi.startOAuth', { provider }),
    remoteStatus: () => client.call('remote.status'),
    onModelChanged: (fn) => {
      modelListeners.add(fn)
      return () => modelListeners.delete(fn)
    },

    getSoul: () => client.call('settings.getSoul'),
    saveSoul: (content) => client.call('settings.saveSoul', { content }),
    getAccentColor: () => client.call('settings.getAccentColor'),
    saveAccentColor: async (hex) => {
      const result = await client.call<boolean>('settings.saveAccentColor', { hex })
      for (const fn of accentListeners) fn(hex)
      return result
    },
    onAccentColor: (fn) => {
      accentListeners.add(fn)
      return () => accentListeners.delete(fn)
    },
    getWindowOpacity: () => client.call('settings.getWindowOpacity'),
    saveWindowOpacity: async (opacity) => {
      const result = await client.call<boolean>('settings.saveWindowOpacity', { opacity })
      for (const fn of opacityListeners) fn(opacity)
      return result
    },
    onWindowOpacity: (fn) => {
      opacityListeners.add(fn)
      return () => opacityListeners.delete(fn)
    },

    listCollections: () => client.call('collection.list'),
    getCollection: (id) => client.call('collection.get', { id }),
    createCollection: (name, schema, icon) => client.call('collection.create', { name, schema, icon }),
    updateCollection: (id, updates) => client.call('collection.update', { id, updates }),
    deleteCollection: (id) => client.call('collection.delete', { id }),
    renameCollectionField: (id, oldName, newName) => client.call('collection.renameField', { id, oldName, newName }),
    listCollectionItems: (collectionId) => client.call('collection.listItems', { collectionId }),
    getCollectionItem: (id) => client.call('collection.getItem', { id }),
    addCollectionItem: (collectionId, data) => client.call('collection.addItem', { collectionId, data }),
    updateCollectionItem: (id, data) => client.call('collection.updateItem', { id, data }),
    deleteCollectionItem: (id) => client.call('collection.deleteItem', { id }),
    reorderCollectionItems: (ids) => client.call('collection.reorderItems', { ids }),
    addItemComment: (itemId, author, body) => client.call('collection.addItemComment', { itemId, author, body }),
    deleteItemComment: (id) => client.call('collection.deleteItemComment', { id }),
    onCollectionsChanged: (fn) => client.onNotification('collection.changed', () => fn()),

    senseStatus: () => client.call('sense.status'),
    senseEnable: () => client.call('sense.enable'),
    senseDisable: () => client.call('sense.disable'),
    sensePause: (minutes) => client.call('sense.pause', { minutes }),
    senseResume: () => client.call('sense.resume'),
    senseNow: () => client.call('sense.now'),
    senseToday: () => client.call('sense.today'),
    senseSearch: (query, limit) => client.call('sense.search', { query, limit }),
    senseApps: (range) => client.call('sense.apps', { range }),
    senseTimeline: (from, to, limit) => client.call('sense.timeline', { from, to, limit }),
    senseCapture: (id) => client.call('sense.capture', { id }),
    senseSessions: (from, to) => client.call('sense.sessions', { from, to }),
    senseSettings: () => client.call('sense.settings'),
    senseUpdateSettings: (updates) => client.call('sense.updateSettings', { updates }),
    senseClear: (range) => client.call('sense.clear', { range }),
    senseStats: () => client.call('sense.stats'),
    hasScreenRecordingPermission: async () => false,

    onboardingStatus: () => client.call('onboarding.status'),
    onboardingBegin: () => client.call('onboarding.begin'),
    onboardingSkip: () => client.call('onboarding.skip'),
    sandboxStatus: () => client.call('sandbox.status'),

    memoryCore: () => client.call('memory.core'),
    memoryUpdateCore: (core) => client.call('memory.updateCore', { core }),
    memoryWorking: () => client.call('memory.working'),
    memoryUpdateWorking: (working) => client.call('memory.updateWorking', { working }),
    memoryClearWorking: () => client.call('memory.clearWorking'),
    memorySearch: (query, limit) => client.call('memory.search', { query, limit }),
    memoryUpsert: (item) => client.call('memory.upsert', { item }),
    memoryDelete: (id) => client.call('memory.delete', { id }),
    memorySources: (id) => client.call('memory.sources', { id }),
    senseMemory: (limit) => client.call('sense.memory', { limit }),
    senseDebrief: (id, sessionId) => client.call('sense.debrief', { id, sessionId }),
    senseDeleteDebrief: (id) => client.call('sense.deleteDebrief', { id }),
    senseSystemPromptPreview: (editMode) => client.call('sense.systemPromptPreview', { editMode }),

    onQuickChatInit: noopDisposer,
    onQuickChatDismiss: noopDisposer,
    quickChatDismissed: async () => {},

    onConnectionLost: (fn) => client.onStateChange((state) => { if (state === 'disconnected') fn() }),
    onConnectionRestored: (fn) => {
      let wasLost = false
      return client.onStateChange((state) => {
        if (state === 'disconnected') wasLost = true
        else if (state === 'connected' && wasLost) { wasLost = false; fn() }
      })
    },
  }
}
