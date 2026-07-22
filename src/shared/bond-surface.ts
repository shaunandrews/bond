/**
 * The single source of truth for the `window.bond` renderer surface.
 *
 * Every method the renderer can call is defined here exactly once:
 *  - `buildDaemonSurface` produces every pure daemon proxy as a one-liner over
 *    an injected RPC invoker. The desktop preload passes an invoker that rides
 *    the generic `bond:rpc` IPC channel; the browser shim passes one that
 *    calls WebBondClient directly. Method names and renderer-facing signatures
 *    are frozen here — param/result shapes flow from the RPC registry
 *    (rpc-schema.ts), which is the wire truth.
 *  - `ElectronBondSurface` declares every main-process-local method and event
 *    registrar. The preload and the browser shim both implement it, so the
 *    compiler enforces that the two runtimes expose the identical surface.
 *
 * Three daemon-backed methods deliberately live in ElectronBondSurface, not
 * the builder: setModel, saveAccentColor, and saveWindowOpacity — the desktop
 * main process broadcasts a change event to all windows after the daemon call,
 * so they keep their hand-written per-method IPC channels.
 */
import type { DispatchableMethod, RpcParams, RpcResult, CollectionUpdates, DeskConfirmedMatcher, McpPolicyWire, McpServerConfigWire } from './rpc-schema'
import type { BondSendInput, TaggedChunk } from './stream'
import type { AttachedImage, EditMode, FieldDefInput, ImageMediaType } from './session'
import type { QuestionAnswer } from './questions'
import type { TranscriptMessage } from './transcript'
import type { SenseSettings } from './sense'
import type { CoreMemory, MemoryItemInput, WorkingState } from './memory'
import type { AssetKind, LibraryAddDocumentInput } from './library'
import type { AgentSettings } from './agents'

/** How a runtime reaches the daemon. Params/results are registry-typed. */
export type RpcInvoker = <M extends DispatchableMethod>(
  method: M,
  params?: RpcParams<M>
) => Promise<RpcResult<M>>

/**
 * Every pure daemon proxy on `window.bond`. Each entry maps the frozen
 * renderer-facing signature onto its daemon RPC method and params shape.
 */
export function buildDaemonSurface(invoke: RpcInvoker) {
  return {
    // --- Chat ---
    send: (inputOrText: BondSendInput | string, sessionId?: string, images?: AttachedImage[]) =>
      invoke('bond.send', typeof inputOrText === 'string'
        ? { text: inputOrText, sessionId, images }
        : inputOrText),
    cancel: (sessionId?: string) => invoke('bond.cancel', sessionId ? { sessionId } : undefined),
    respondToApproval: (requestId: string, approved: boolean) =>
      invoke('bond.approvalResponse', { requestId, approved }),
    answerQuestion: (questionId: string, answer: QuestionAnswer) =>
      invoke('bond.questionResponse', { questionId, answer }),
    pendingQuestion: () => invoke('question.pending'),
    subscribe: (sessionId?: string) => invoke('bond.subscribe', sessionId ? { sessionId } : undefined),
    unsubscribe: (sessionId?: string) => invoke('bond.unsubscribe', sessionId ? { sessionId } : undefined),

    // --- Model + Pi setup ---
    getModel: () => invoke('bond.getModel'),
    getEditMode: () => invoke('settings.getEditMode'),
    setEditMode: (editMode: EditMode) => invoke('settings.setEditMode', { editMode }),
    getPiStatus: () => invoke('pi.status'),
    startPiOAuth: (provider: 'anthropic' | 'openai-codex') => invoke('pi.startOAuth', { provider }),

    // --- Remote access (LAN web server) ---
    remoteStatus: () => invoke('remote.status'),
    createPairingCode: () => invoke('remote.createPairingCode'),
    listRemoteDevices: () => invoke('remote.listDevices'),
    revokeRemoteDevice: (id: string) => invoke('remote.revokeDevice', { id }),
    revokeAllRemoteDevices: () => invoke('remote.revokeAllDevices'),

    // --- Continuous transcript ---
    listTranscript: (options?: { beforeSeq?: number; limit?: number }) => invoke('transcript.list', options),
    upsertTranscript: (messages: TranscriptMessage[]) => invoke('transcript.upsert', { messages }),
    searchTranscript: (query: string, limit?: number) => invoke('transcript.search', { query, limit }),

    // --- Chat threads ---
    createThread: (anchorMessageId: string) => invoke('thread.create', { anchorMessageId }),
    getThread: (threadId: string) => invoke('thread.get', { threadId }),
    getThreadForAnchor: (anchorMessageId: string) => invoke('thread.getForAnchor', { anchorMessageId }),
    listRecentThreads: (limit?: number) => invoke('thread.listRecent', { limit }),
    listThreadMessages: (threadId: string, options?: { beforeSeq?: number; limit?: number }) => invoke('thread.listMessages', { threadId, ...options }),
    touchThread: (threadId: string) => invoke('thread.touch', { threadId }),
    markThreadRead: (threadId: string) => invoke('thread.markRead', { threadId }),
    closeThread: (threadId: string) => invoke('thread.close', { threadId }),
    deleteDraftThread: (threadId: string) => invoke('thread.deleteDraft', { threadId }),

    // Legacy transport session used internally by the continuous transcript runtime.
    createSession: (options?: { title?: string }) => invoke('session.create', options),

    // --- Collections ---
    listCollections: () => invoke('collection.list'),
    getCollection: (id: string) => invoke('collection.get', { id }),
    listCollectionReferences: () => invoke('collection.listReferences'),
    createCollection: (name: string, schema: FieldDefInput[], icon?: string) =>
      invoke('collection.create', { name, schema, icon }),
    updateCollection: (id: string, updates: CollectionUpdates) => invoke('collection.update', { id, updates }),
    deleteCollection: (id: string) => invoke('collection.delete', { id }),
    renameCollectionField: (id: string, oldName: string, newName: string) =>
      invoke('collection.renameField', { id, oldName, newName }),
    listCollectionItems: (collectionId: string) => invoke('collection.listItems', { collectionId }),
    getCollectionItem: (id: string) => invoke('collection.getItem', { id }),
    addCollectionItem: (collectionId: string, data: Record<string, unknown>) =>
      invoke('collection.addItem', { collectionId, data }),
    updateCollectionItem: (id: string, data: Record<string, unknown>) =>
      invoke('collection.updateItem', { id, data }),
    deleteCollectionItem: (id: string) => invoke('collection.deleteItem', { id }),
    reorderCollectionItems: (ids: string[]) => invoke('collection.reorderItems', { ids }),
    addItemComment: (itemId: string, author: 'user' | 'bond', body: string) =>
      invoke('collection.addItemComment', { itemId, author, body }),
    deleteItemComment: (id: string) => invoke('collection.deleteItemComment', { id }),

    // --- Images ---
    listImages: () => invoke('image.list'),
    getImage: (imageId: string) => invoke('image.get', { id: imageId }),
    getImages: (ids: string[]) => invoke('image.getMultiple', { ids }),
    importImage: (data: string, mediaType: string) =>
      invoke('image.import', { data, mediaType: mediaType as ImageMediaType }),
    deleteImage: (imageId: string) => invoke('image.delete', { id: imageId }),

    // --- Library ---
    libraryList: (kind?: AssetKind, query?: string) => invoke('library.list', { kind, query }),
    libraryGet: (id: string) => invoke('library.get', { id }),
    libraryAddDocument: (input: LibraryAddDocumentInput) => invoke('library.addDocument', input),
    libraryUpdateMetadata: (id: string, updates: { title?: string; sourceUrl?: string }) =>
      invoke('library.updateMetadata', { id, updates }),
    libraryDelete: (id: string) => invoke('library.delete', { id }),
    libraryAddReference: (assetId: string, itemId: string) => invoke('library.addReference', { assetId, itemId }),
    libraryRemoveReference: (assetId: string, itemId: string) => invoke('library.removeReference', { assetId, itemId }),
    libraryListReferencesForItem: (itemId: string) => invoke('library.listReferencesForItem', { itemId }),
    libraryListBacklinksForAsset: (assetId: string) => invoke('library.listBacklinksForAsset', { assetId }),

    // --- MCP connections ---
    mcpList: () => invoke('mcp.list'),
    mcpAdd: (server: Partial<McpServerConfigWire>) => invoke('mcp.add', { server }),
    mcpAddPreset: (preset: string) => invoke('mcp.add', { preset }),
    mcpUpdate: (id: string, updates: Partial<Omit<McpServerConfigWire, 'id' | 'transport'>>) =>
      invoke('mcp.update', { id, updates }),
    mcpRemove: (id: string) => invoke('mcp.remove', { id }),
    mcpStatus: () => invoke('mcp.status'),
    mcpListTools: (server?: string, query?: string) => invoke('mcp.listTools', { server, query }),
    mcpReconnect: (id: string) => invoke('mcp.reconnect', { id }),
    mcpSetTrust: (id: string, trust: McpPolicyWire['trust']) => invoke('mcp.setTrust', { id, trust }),
    mcpClassifyTool: (id: string, tool: string, toolClass: 'read' | 'write' | 'unknown') =>
      invoke('mcp.classifyTool', { id, tool, toolClass }),
    mcpPromoteTool: (id: string, tool: string, promoted: boolean) => invoke('mcp.promoteTool', { id, tool, promoted }),
    mcpSetAlwaysAsk: (id: string, tool: string, alwaysAsk: boolean) => invoke('mcp.setAlwaysAsk', { id, tool, alwaysAsk }),
    /** Write-only: the daemon never hands a stored secret back. */
    mcpSetSecret: (ref: string, value: string) => invoke('mcp.setSecret', { ref, value }),
    mcpDeleteSecret: (ref: string) => invoke('mcp.deleteSecret', { ref }),
    mcpListSecrets: () => invoke('mcp.listSecrets'),

    // --- Agents ---
    listAgents: () => invoke('agents.list'),
    updateAgentSettings: (name: string, settings: Partial<AgentSettings>) => invoke('agents.updateSettings', { name, settings }),
    revokeAgentRunner: (command: string) => invoke('agents.revokeRunner', { command }),

    // --- Skills ---
    listSkills: () => invoke('skills.list'),
    refreshSkills: () => invoke('skills.refresh'),
    removeSkill: (name: string) => invoke('skills.remove', { name }),

    // --- Settings (reads + non-broadcast writes) ---
    getSoul: () => invoke('settings.getSoul'),
    saveSoul: (content: string) => invoke('settings.saveSoul', { content }),
    getAccentColor: () => invoke('settings.getAccentColor'),
    getWindowOpacity: () => invoke('settings.getWindowOpacity'),

    // --- Sense ---
    senseStatus: () => invoke('sense.status'),
    senseEnable: () => invoke('sense.enable'),
    senseDisable: () => invoke('sense.disable'),
    sensePause: (minutes?: number) => invoke('sense.pause', { minutes }),
    senseResume: () => invoke('sense.resume'),
    senseNow: () => invoke('sense.now'),
    senseToday: () => invoke('sense.today'),
    senseSearch: (query: string, limit?: number) => invoke('sense.search', { query, limit }),
    senseApps: (range?: string) => invoke('sense.apps', { range: range as 'today' | 'week' | undefined }),
    senseTimeline: (from?: string, to?: string, limit?: number) => invoke('sense.timeline', { from, to, limit }),
    senseCapture: (id: string) => invoke('sense.capture', { id }),
    senseSessions: (from?: string, to?: string) => invoke('sense.sessions', { from, to }),
    senseSettings: () => invoke('sense.settings'),
    senseUpdateSettings: (updates: Record<string, unknown>) =>
      invoke('sense.updateSettings', { updates: updates as Partial<SenseSettings> }),
    senseClear: (range?: { from?: string; to?: string }) => invoke('sense.clear', { range }),
    senseStats: () => invoke('sense.stats'),

    // --- Onboarding + new-user sandbox ---
    onboardingStatus: () => invoke('onboarding.status'),
    onboardingBegin: () => invoke('onboarding.begin'),
    onboardingSkip: () => invoke('onboarding.skip'),
    sandboxStatus: () => invoke('sandbox.status'),

    // --- Memory ---
    memoryCore: () => invoke('memory.core'),
    memoryUpdateCore: (core: CoreMemory) => invoke('memory.updateCore', { core }),
    memoryWorking: () => invoke('memory.working'),
    memoryUpdateWorking: (working: WorkingState) => invoke('memory.updateWorking', { working }),
    memoryClearWorking: () => invoke('memory.clearWorking'),
    memorySearch: (query: string, limit?: number) => invoke('memory.search', { query, limit }),
    memoryUpsert: (item: MemoryItemInput) => invoke('memory.upsert', { item }),
    memoryDelete: (id: string) => invoke('memory.delete', { id }),
    memorySources: (id: string) => invoke('memory.sources', { id }),
    memoryHealth: () => invoke('memory.health'),

    // --- Sense debriefs ---
    senseMemory: (limit?: number) => invoke('sense.memory', { limit }),
    senseDebrief: (id?: string, sessionId?: string) => invoke('sense.debrief', { id, sessionId }),
    senseDeleteDebrief: (id: string) => invoke('sense.deleteDebrief', { id }),
    senseSystemPromptPreview: (editMode?: EditMode) => invoke('sense.systemPromptPreview', { editMode }),

    // --- Desk ---
    deskStatus: () => invoke('desk.status'),
    deskSetRunning: (running: boolean) => invoke('desk.setRunning', { running }),
    deskBlocks: (range?: { from?: string; to?: string; limit?: number }) => invoke('desk.blocks', range),
    deskInFlight: (opts?: { since?: string; limit?: number }) => invoke('desk.inFlight', opts),
    deskThreads: (includeArchived?: boolean) => invoke('desk.threads', { includeArchived }),
    deskCreateThread: (name: string) => invoke('desk.createThread', { name }),
    deskRenameThread: (id: string, name: string) => invoke('desk.renameThread', { id, name }),
    deskMergeThreads: (targetId: string, sourceId: string) => invoke('desk.mergeThreads', { targetId, sourceId }),
    deskArchiveThread: (id: string, archived?: boolean) => invoke('desk.archiveThread', { id, archived }),
    deskStartBlock: (threadId: string) => invoke('desk.startBlock', { threadId }),
    deskReassign: (blockId: string, threadId: string, confirmedMatcher?: DeskConfirmedMatcher) =>
      invoke('desk.reassign', { blockId, threadId, confirmedMatcher }),
    deskAnswer: (questionId: string, accepted: boolean) => invoke('desk.answer', { questionId, accepted }),
    deskUpdateNote: (blockId: string, note: string) => invoke('desk.updateNote', { blockId, note }),
    deskMatchers: (confirmedOnly?: boolean) => invoke('desk.matchers', { confirmedOnly }),
    deskDisableMatcher: (id: string) => invoke('desk.disableMatcher', { id }),
    deskDeleteMatcher: (id: string) => invoke('desk.deleteMatcher', { id }),
    deskToday: () => invoke('desk.ensureToday'),
    deskLinkTodo: (itemId: string, threadId: string) => invoke('desk.linkTodo', { itemId, threadId }),
    deskUnlinkTodo: (itemId: string) => invoke('desk.unlinkTodo', { itemId }),
    deskCarryTodo: (itemId: string) => invoke('desk.carryTodo', { itemId }),
    deskStats: (windowHours?: number) => invoke('desk.stats', { windowHours }),
  }
}

export type DaemonBondSurface = ReturnType<typeof buildDaemonSurface>

/**
 * Every main-process-local method and event registrar on `window.bond`.
 * The desktop preload implements these over per-method IPC channels; the
 * browser shim provides stand-ins (no-ops, window.open, local event
 * emulation). Both are compiler-enforced to cover the full set.
 */
export interface ElectronBondSurface {
  // Push events
  onChunk(fn: (chunk: TaggedChunk) => void): () => void
  onModelChanged(fn: (model: string) => void): () => void
  onCollectionsChanged(fn: () => void): () => void
  onImageChanged(fn: () => void): () => void
  onLibraryChanged(fn: () => void): () => void
  onMcpChanged(fn: () => void): () => void
  onDeskChanged(fn: () => void): () => void
  onThreadChanged(fn: () => void): () => void
  onViewerFile(fn: (filePath: string, format?: 'markdown' | 'plaintext', title?: string) => void): () => void
  onCreateSkill(fn: (description: string) => void): () => void
  onFullscreenChanged(fn: (isFullScreen: boolean) => void): () => void
  onConnectionLost(fn: () => void): () => void
  onConnectionRestored(fn: () => void): () => void
  onAccentColor(fn: (hex: string) => void): () => void
  onWindowOpacity(fn: (opacity: number) => void): () => void

  // Daemon proxies whose desktop main handler broadcasts to all windows after
  // the call — kept on hand-written per-method channels.
  setModel(model: string): Promise<{ ok: boolean }>
  saveAccentColor(hex: string): Promise<boolean>
  saveWindowOpacity(opacity: number): Promise<boolean>

  // Native UI + windows
  showContextMenu(items: { id: string; label: string; type?: string }[]): Promise<string | null>
  openSettings(): Promise<void>
  /**
   * Reveal the Desk notch panel. Desktop-only: Desk is a non-activating
   * NSPanel owned by main, so the web shim reports `desktop_only` rather than
   * pretending. `queued` defers the open until back-fill has populated it.
   */
  openDesk(opts?: { queued?: boolean }): Promise<{ opened: boolean; reason?: string }>
  openViewer(filePath: string, format?: 'markdown' | 'plaintext', title?: string): Promise<void>
  createSkillViaChat(description: string): Promise<void>
  // Local filesystem + shell
  readFile(filePath: string): Promise<string | null>
  readLocalImage(filePath: string): Promise<string | null>
  captureScreenshot(outputPath: string): Promise<string>
  openExternal(url: string): Promise<void>
  openPath(filePath: string): Promise<string>
  revealInFinder(filePath: string): Promise<void>

  // Permissions
  hasScreenRecordingPermission(): Promise<boolean>

  /**
   * Grow the main window's content area so it fits `preferredWidth` (e.g. the
   * sum of every visible panel's preferred width plus handles), clamped to
   * the current display's work area. Never shrinks — only called when
   * opening a panel needs more room than the window currently has. Also
   * raises the window's native minimum width to `minimumWidth` so a manual
   * resize can't crush a visible panel below its hard floor. A no-op in
   * fullscreen (native bounds never change there) and on the web client
   * (which reports its real viewport width and never resizes natively).
   */
  ensureContentWidth(options: { preferredWidth: number; minimumWidth: number }): Promise<{
    width: number
    reachedPreferred: boolean
  }>
}

export type BondSurface = DaemonBondSurface & ElectronBondSurface
