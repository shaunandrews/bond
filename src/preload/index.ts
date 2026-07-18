import { contextBridge, ipcRenderer } from 'electron'
import type { TaggedChunk } from '../shared/stream'
import type { Session, SessionMessage, AttachedImage, ImageRecord, Collection, CollectionItem, FieldDef, ItemComment } from '../shared/session'

contextBridge.exposeInMainWorld('bond', {
  send: (text: string, sessionId?: string, images?: AttachedImage[]) => ipcRenderer.invoke('bond:send', text, sessionId, images) as Promise<{ ok: boolean; error?: string; imageIds?: string[] }>,
  cancel: (sessionId?: string) => ipcRenderer.invoke('bond:cancel', sessionId) as Promise<{ ok: boolean }>,
  respondToApproval: (requestId: string, approved: boolean) =>
    ipcRenderer.invoke('bond:approvalResponse', requestId, approved) as Promise<{ ok: boolean }>,
  subscribe: (sessionId: string) =>
    ipcRenderer.invoke('bond:subscribe', sessionId) as Promise<{ ok: boolean }>,
  unsubscribe: (sessionId: string) =>
    ipcRenderer.invoke('bond:unsubscribe', sessionId) as Promise<{ ok: boolean }>,
  onChunk: (fn: (chunk: TaggedChunk) => void) => {
    const listener = (_: Electron.IpcRendererEvent, chunk: TaggedChunk) => fn(chunk)
    ipcRenderer.on('bond:chunk', listener)
    return () => ipcRenderer.removeListener('bond:chunk', listener)
  },

  // Model
  setModel: (model: string) => ipcRenderer.invoke('bond:setModel', model) as Promise<{ ok: boolean }>,
  getModel: () => ipcRenderer.invoke('bond:getModel') as Promise<string>,
  getPiStatus: () => ipcRenderer.invoke('pi:status') as Promise<{ configured: boolean; providers: Array<{ providerId: string; type: 'api_key' | 'oauth' }> }>,
  startPiOAuth: (provider: 'anthropic' | 'openai-codex') => ipcRenderer.invoke('pi:startOAuth', provider) as Promise<{ url: string; instructions?: string; deviceCode?: string }>,

  onModelChanged: (fn: (model: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, model: string) => fn(model)
    ipcRenderer.on('bond:modelChanged', listener)
    return () => ipcRenderer.removeListener('bond:modelChanged', listener)
  },

  // Context menu
  showContextMenu: (items: { id: string; label: string; type?: string }[]) =>
    ipcRenderer.invoke('context-menu:show', items) as Promise<string | null>,

  // Sessions
  listSessions: () => ipcRenderer.invoke('session:list') as Promise<Session[]>,
  createSession: (options?: { title?: string }) => ipcRenderer.invoke('session:create', options) as Promise<Session>,
  getSession: (id: string) => ipcRenderer.invoke('session:get', id) as Promise<Session | null>,
  updateSession: (id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived' | 'favorited' | 'quick' | 'iconSeed' | 'editMode'>>) => ipcRenderer.invoke('session:update', id, updates) as Promise<Session | null>,
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', id) as Promise<boolean>,
  deleteArchivedSessions: () => ipcRenderer.invoke('session:deleteArchived') as Promise<{ ok: boolean; count: number }>,
  getMessages: (sessionId: string) => ipcRenderer.invoke('session:getMessages', sessionId) as Promise<SessionMessage[]>,
  saveMessages: (sessionId: string, messages: SessionMessage[]) =>
    ipcRenderer.invoke('session:saveMessages', sessionId, messages) as Promise<boolean>,
  generateTitle: (sessionId: string, userMessage?: string) =>
    ipcRenderer.invoke('session:generateTitle', sessionId, userMessage) as Promise<{ title: string; summary: string }>,

  // Collections
  listCollections: () => ipcRenderer.invoke('collection:list') as Promise<Collection[]>,
  getCollection: (id: string) => ipcRenderer.invoke('collection:get', id) as Promise<Collection | null>,
  createCollection: (name: string, schema: FieldDef[], icon?: string) => ipcRenderer.invoke('collection:create', name, schema, icon) as Promise<Collection>,
  updateCollection: (id: string, updates: Partial<Pick<Collection, 'name' | 'icon' | 'schema' | 'archived'>>) => ipcRenderer.invoke('collection:update', id, updates) as Promise<Collection | null>,
  deleteCollection: (id: string) => ipcRenderer.invoke('collection:delete', id) as Promise<boolean>,
  renameCollectionField: (id: string, oldName: string, newName: string) => ipcRenderer.invoke('collection:renameField', id, oldName, newName) as Promise<boolean>,
  listCollectionItems: (collectionId: string) => ipcRenderer.invoke('collection:listItems', collectionId) as Promise<CollectionItem[]>,
  getCollectionItem: (id: string) => ipcRenderer.invoke('collection:getItem', id) as Promise<CollectionItem | null>,
  addCollectionItem: (collectionId: string, data: Record<string, unknown>) => ipcRenderer.invoke('collection:addItem', collectionId, data) as Promise<CollectionItem>,
  updateCollectionItem: (id: string, data: Record<string, unknown>) => ipcRenderer.invoke('collection:updateItem', id, data) as Promise<CollectionItem | null>,
  deleteCollectionItem: (id: string) => ipcRenderer.invoke('collection:deleteItem', id) as Promise<boolean>,
  reorderCollectionItems: (ids: string[]) => ipcRenderer.invoke('collection:reorderItems', ids) as Promise<boolean>,
  addItemComment: (itemId: string, author: 'user' | 'bond', body: string) =>
    ipcRenderer.invoke('collection:addItemComment', itemId, author, body) as Promise<ItemComment>,
  deleteItemComment: (id: string) => ipcRenderer.invoke('collection:deleteItemComment', id) as Promise<boolean>,
  onCollectionsChanged: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('bond:collectionsChanged', listener)
    return () => ipcRenderer.removeListener('bond:collectionsChanged', listener)
  },

  // Images
  listImages: () => ipcRenderer.invoke('image:list') as Promise<ImageRecord[]>,
  getImage: (imageId: string) => ipcRenderer.invoke('image:get', imageId) as Promise<AttachedImage | null>,
  getImages: (ids: string[]) => ipcRenderer.invoke('image:getMultiple', ids) as Promise<(AttachedImage | null)[]>,
  importImage: (data: string, mediaType: string) => ipcRenderer.invoke('image:import', data, mediaType) as Promise<ImageRecord>,
  deleteImage: (imageId: string) => ipcRenderer.invoke('image:delete', imageId) as Promise<boolean>,
  onImageChanged: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('bond:imageChanged', listener)
    return () => ipcRenderer.removeListener('bond:imageChanged', listener)
  },

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list') as Promise<{ name: string; description: string; argumentHint: string }[]>,
  refreshSkills: () => ipcRenderer.invoke('skills:refresh') as Promise<{ name: string; description: string; argumentHint: string }[]>,
  removeSkill: (name: string) => ipcRenderer.invoke('skills:remove', name) as Promise<{ ok: boolean }>,

  // Local images
  readLocalImage: (filePath: string) => ipcRenderer.invoke('image:readLocal', filePath) as Promise<string | null>,

  // File viewing
  openViewer: (filePath: string) => ipcRenderer.invoke('viewer:open', filePath) as Promise<void>,
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath) as Promise<string | null>,
  onViewerFile: (fn: (filePath: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, filePath: string) => fn(filePath)
    ipcRenderer.on('bond:viewerFile', listener)
    return () => ipcRenderer.removeListener('bond:viewerFile', listener)
  },

  // Dev
  captureScreenshot: (outputPath: string) => ipcRenderer.invoke('dev:captureScreenshot', outputPath) as Promise<string>,

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url) as Promise<void>,
  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath) as Promise<string>,

  // Fullscreen
  onFullscreenChanged: (fn: (isFullScreen: boolean) => void) => {
    const listener = (_: Electron.IpcRendererEvent, isFullScreen: boolean) => fn(isFullScreen)
    ipcRenderer.on('bond:fullscreenChanged', listener)
    return () => ipcRenderer.removeListener('bond:fullscreenChanged', listener)
  },

  // Settings window
  openSettings: () => ipcRenderer.invoke('window:openSettings') as Promise<void>,
  createSkillViaChat: (description: string) => ipcRenderer.invoke('settings:createSkillViaChat', description) as Promise<void>,
  onCreateSkill: (fn: (description: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, description: string) => fn(description)
    ipcRenderer.on('bond:createSkill', listener)
    return () => ipcRenderer.removeListener('bond:createSkill', listener)
  },

  // Connection status
  onConnectionLost: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('bond:connectionLost', listener)
    return () => ipcRenderer.removeListener('bond:connectionLost', listener)
  },
  onConnectionRestored: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('bond:connectionRestored', listener)
    return () => ipcRenderer.removeListener('bond:connectionRestored', listener)
  },

  // Settings
  getSoul: () => ipcRenderer.invoke('settings:getSoul') as Promise<string>,
  saveSoul: (content: string) => ipcRenderer.invoke('settings:saveSoul', content) as Promise<boolean>,
  getAccentColor: () => ipcRenderer.invoke('settings:getAccentColor') as Promise<string>,
  saveAccentColor: (hex: string) => ipcRenderer.invoke('settings:saveAccentColor', hex) as Promise<boolean>,
  onAccentColor: (fn: (hex: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, hex: string) => fn(hex)
    ipcRenderer.on('bond:accentColor', listener)
    return () => ipcRenderer.removeListener('bond:accentColor', listener)
  },
  getWindowOpacity: () => ipcRenderer.invoke('settings:getWindowOpacity') as Promise<number>,
  saveWindowOpacity: (opacity: number) => ipcRenderer.invoke('settings:saveWindowOpacity', opacity) as Promise<boolean>,
  onWindowOpacity: (fn: (opacity: number) => void) => {
    const listener = (_: Electron.IpcRendererEvent, opacity: number) => fn(opacity)
    ipcRenderer.on('bond:windowOpacity', listener)
    return () => ipcRenderer.removeListener('bond:windowOpacity', listener)
  },

  // Quick Chat
  onQuickChatInit: (fn: (data: { sessionId: string; senseApps: string[] }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { sessionId: string; senseApps: string[] }) => fn(data)
    ipcRenderer.on('bond:quickChatInit', listener)
    return () => ipcRenderer.removeListener('bond:quickChatInit', listener)
  },
  onQuickChatDismiss: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('bond:quickChatDismiss', listener)
    return () => ipcRenderer.removeListener('bond:quickChatDismiss', listener)
  },
  quickChatDismissed: () => ipcRenderer.invoke('quickChat:dismiss') as Promise<void>,

  // Sense
  senseStatus: () => ipcRenderer.invoke('sense:status'),
  senseEnable: () => ipcRenderer.invoke('sense:enable'),
  senseDisable: () => ipcRenderer.invoke('sense:disable'),
  sensePause: (minutes?: number) => ipcRenderer.invoke('sense:pause', minutes),
  senseResume: () => ipcRenderer.invoke('sense:resume'),
  senseNow: () => ipcRenderer.invoke('sense:now'),
  senseToday: () => ipcRenderer.invoke('sense:today'),
  senseSearch: (query: string, limit?: number) => ipcRenderer.invoke('sense:search', query, limit),
  senseApps: (range?: string) => ipcRenderer.invoke('sense:apps', range),
  senseTimeline: (from?: string, to?: string, limit?: number) => ipcRenderer.invoke('sense:timeline', from, to, limit),
  senseCapture: (id: string) => ipcRenderer.invoke('sense:capture', id),
  senseSessions: (from?: string, to?: string) => ipcRenderer.invoke('sense:sessions', from, to),
  senseSettings: () => ipcRenderer.invoke('sense:settings'),
  senseUpdateSettings: (updates: Record<string, unknown>) => ipcRenderer.invoke('sense:updateSettings', updates),
  senseClear: (range?: { from?: string; to?: string }) => ipcRenderer.invoke('sense:clear', range),
  senseStats: () => ipcRenderer.invoke('sense:stats'),
  hasScreenRecordingPermission: () => ipcRenderer.invoke('sense:hasPermission'),

  // Sense Debriefs
  senseMemory: (limit?: number) =>
    ipcRenderer.invoke('sense:memory', limit),
  senseDebrief: (id?: string, sessionId?: string) =>
    ipcRenderer.invoke('sense:debrief', id, sessionId),
  senseDeleteDebrief: (id: string) =>
    ipcRenderer.invoke('sense:deleteDebrief', id),
  senseSystemPromptPreview: (editMode?: import('../shared/session').EditMode) =>
    ipcRenderer.invoke('sense:systemPromptPreview', editMode),

})
