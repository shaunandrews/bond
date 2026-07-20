import WebSocket from 'ws'
import type { BondSendInput, TaggedChunk } from './stream'
import type { AttachedImage, EditMode, FieldDefInput, SessionMessage } from './session'
import type { ImageMediaType } from './session'
import type { TranscriptMessage } from './transcript'
import type { SenseSettings } from './sense'
import type { CoreMemory, MemoryItemInput, WorkingState } from './memory'
import type { WebRenderResult } from './web'
import type { ModelId } from './models'
import type {
  BondSendResult,
  CollectionUpdates,
  DispatchableMethod,
  RpcNotificationName,
  RpcNotifications,
  RpcParamsArg,
  RpcResult,
  SessionUpdates,
} from './rpc-schema'
import {
  makeRequest,
  isResponse,
  isNotification,
  type JsonRpcMessage
} from './protocol'

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

/** Rejection carrying the JSON-RPC error code and data alongside the message. */
export class RpcCallError extends Error {
  constructor(message: string, public code: number, public data?: unknown) {
    super(message)
    this.name = 'RpcCallError'
  }
}

export class BondClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<string | number, PendingRequest>()
  private notificationListeners = new Map<RpcNotificationName, Set<(payload: never) => void>>()
  private disconnectListeners = new Set<() => void>()
  private socketPath: string
  private tokenProvider: () => string | undefined
  private _connected = false
  /** null until an auth handshake completes; 0 marks a pre-versioning daemon. */
  private _daemonProtocolVersion: number | null = null

  constructor(socketPath: string, auth?: string | (() => string | undefined)) {
    this.socketPath = socketPath
    this.tokenProvider = typeof auth === 'function' ? auth : () => auth
  }

  get connected(): boolean {
    return this._connected
  }

  /** Protocol version the daemon reported at auth (null = never authenticated, 0 = pre-versioning daemon). */
  get daemonProtocolVersion(): number | null {
    return this._daemonProtocolVersion
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws+unix://${this.socketPath}`
      this.ws = new WebSocket(url)

      this.ws.on('open', async () => {
        // Authenticate if a token is available. Read through the provider on
        // every attempt — a restarted daemon mints a new token, and reconnect()
        // must pick it up without recreating the client (listeners live here).
        const token = this.tokenProvider()
        if (token && this.ws) {
          try {
            const authMsg = JSON.stringify(makeRequest(this.nextId++, 'bond.auth', { token }))
            const authPromise = new Promise<void>((authResolve, authReject) => {
              const onMsg = (raw: WebSocket.Data) => {
                try {
                  const resp = JSON.parse(raw.toString())
                  if (isResponse(resp)) {
                    this.ws?.off('message', onMsg)
                    if (resp.error) {
                      authReject(new Error(resp.error.message))
                    } else {
                      const version = (resp.result as { protocolVersion?: number } | undefined)?.protocolVersion
                      this._daemonProtocolVersion = typeof version === 'number' ? version : 0
                      authResolve()
                    }
                  }
                } catch { /* ignore parse errors during auth */ }
              }
              this.ws!.on('message', onMsg)
            })
            this.ws.send(authMsg)
            await authPromise
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
            return
          }
        }

        this._connected = true
        this.setupMessageHandler()
        resolve()
      })

      this.ws.on('error', (err) => {
        if (!this._connected) {
          reject(err)
        }
      })

      this.ws.on('close', () => {
        this._connected = false
        // Reject all pending requests
        for (const [, req] of this.pending) {
          req.reject(new Error('Connection closed'))
        }
        this.pending.clear()
        // Notify disconnect listeners
        for (const fn of this.disconnectListeners) fn()
      })
    })
  }

  private setupMessageHandler(): void {
    if (!this.ws) return
    this.ws.on('message', (data) => {
      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (isResponse(msg)) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          if (msg.error) {
            p.reject(new RpcCallError(msg.error.message, msg.error.code, msg.error.data))
          } else {
            p.resolve(msg.result)
          }
        }
      } else if (isNotification(msg)) {
        const listeners = this.notificationListeners.get(msg.method as RpcNotificationName)
        if (!listeners) return
        for (const fn of listeners) fn(msg.params as never)
      }
    })
  }

  close(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
      this._connected = false
    }
  }

  async reconnect(): Promise<void> {
    if (this.ws) {
      this.ws.removeAllListeners()
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
      this._connected = false
    }
    return this.connect()
  }

  onDisconnect(fn: () => void): () => void {
    this.disconnectListeners.add(fn)
    return () => this.disconnectListeners.delete(fn)
  }

  /** Registry-typed RPC: method names, params, and results come from RpcMethods. */
  call<M extends DispatchableMethod>(method: M, ...args: RpcParamsArg<M>): Promise<RpcResult<M>> {
    return this.callRaw(method, (args as unknown[])[0]) as Promise<RpcResult<M>>
  }

  private callRaw(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'))
      }
      const id = this.nextId++
      const msg = makeRequest(id, method, params)
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(msg))
    })
  }

  /** Subscribe to a daemon push notification. Payload types come from RpcNotifications. */
  onNotification<K extends RpcNotificationName>(method: K, fn: (payload: RpcNotifications[K]) => void): () => void {
    let listeners = this.notificationListeners.get(method)
    if (!listeners) {
      listeners = new Set()
      this.notificationListeners.set(method, listeners)
    }
    const set = listeners
    set.add(fn)
    return () => set.delete(fn)
  }

  // --- Chat ---

  async send(input: BondSendInput): Promise<BondSendResult>
  /** @deprecated Positional form kept for legacy callers — pass a BondSendInput object. */
  async send(text: string, sessionId?: string, images?: AttachedImage[]): Promise<BondSendResult>
  async send(inputOrText: BondSendInput | string, sessionId?: string, images?: AttachedImage[]): Promise<BondSendResult> {
    const params = typeof inputOrText === 'string'
      ? { text: inputOrText, sessionId, images }
      : inputOrText
    return this.call('bond.send', params)
  }

  async cancel(sessionId?: string): Promise<RpcResult<'bond.cancel'>> {
    return this.call('bond.cancel', sessionId ? { sessionId } : undefined)
  }

  async respondToApproval(requestId: string, approved: boolean): Promise<RpcResult<'bond.approvalResponse'>> {
    return this.call('bond.approvalResponse', { requestId, approved })
  }

  onChunk(fn: (chunk: TaggedChunk) => void): () => void {
    return this.onNotification('bond.chunk', fn)
  }

  // --- Subscriptions ---

  async subscribe(sessionId?: string): Promise<RpcResult<'bond.subscribe'>> {
    return this.call('bond.subscribe', sessionId ? { sessionId } : undefined)
  }

  async unsubscribe(sessionId?: string): Promise<RpcResult<'bond.unsubscribe'>> {
    return this.call('bond.unsubscribe', sessionId ? { sessionId } : undefined)
  }

  // --- Model ---

  async setModel(model: string): Promise<RpcResult<'bond.setModel'>> {
    return this.call('bond.setModel', { model: model as ModelId })
  }

  async getModel(): Promise<RpcResult<'bond.getModel'>> {
    return this.call('bond.getModel')
  }

  async getEditMode(): Promise<RpcResult<'settings.getEditMode'>> {
    return this.call('settings.getEditMode')
  }

  async setEditMode(editMode: EditMode): Promise<RpcResult<'settings.setEditMode'>> {
    return this.call('settings.setEditMode', { editMode })
  }

  async getPiStatus(): Promise<RpcResult<'pi.status'>> {
    return this.call('pi.status')
  }

  async startPiOAuth(provider: 'anthropic' | 'openai-codex'): Promise<RpcResult<'pi.startOAuth'>> {
    return this.call('pi.startOAuth', { provider })
  }

  // --- Remote access (LAN web server) ---

  async remoteStatus(): Promise<RpcResult<'remote.status'>> {
    return this.call('remote.status')
  }

  // --- Continuous transcript ---

  async listTranscript(options: { beforeSeq?: number; limit?: number } = {}): Promise<RpcResult<'transcript.list'>> {
    return this.call('transcript.list', options)
  }

  async upsertTranscript(messages: TranscriptMessage[]): Promise<RpcResult<'transcript.upsert'>> {
    return this.call('transcript.upsert', { messages })
  }

  async searchTranscript(query: string, limit?: number): Promise<RpcResult<'transcript.search'>> {
    return this.call('transcript.search', { query, limit })
  }

  // --- Sessions ---

  async listSessions(): Promise<RpcResult<'session.list'>> {
    return this.call('session.list')
  }

  async createSession(options?: { title?: string }): Promise<RpcResult<'session.create'>> {
    return this.call('session.create', options)
  }

  async getSession(id: string): Promise<RpcResult<'session.get'>> {
    return this.call('session.get', { id })
  }

  async updateSession(id: string, updates: SessionUpdates): Promise<RpcResult<'session.update'>> {
    return this.call('session.update', { id, updates })
  }

  async deleteSession(id: string): Promise<RpcResult<'session.delete'>> {
    return this.call('session.delete', { id })
  }

  async deleteArchivedSessions(): Promise<RpcResult<'session.deleteArchived'>> {
    return this.call('session.deleteArchived')
  }

  async getMessages(sessionId: string): Promise<RpcResult<'session.getMessages'>> {
    return this.call('session.getMessages', { sessionId })
  }

  async saveMessages(sessionId: string, messages: SessionMessage[]): Promise<RpcResult<'session.saveMessages'>> {
    return this.call('session.saveMessages', { sessionId, messages })
  }

  // --- Images ---

  async listImages(): Promise<RpcResult<'image.list'>> {
    return this.call('image.list')
  }

  async getImage(imageId: string): Promise<RpcResult<'image.get'>> {
    return this.call('image.get', { id: imageId })
  }

  async getImages(ids: string[]): Promise<RpcResult<'image.getMultiple'>> {
    return this.call('image.getMultiple', { ids })
  }

  async importImage(data: string, mediaType: string): Promise<RpcResult<'image.import'>> {
    return this.call('image.import', { data, mediaType: mediaType as ImageMediaType })
  }

  async deleteImage(imageId: string): Promise<RpcResult<'image.delete'>> {
    return this.call('image.delete', { id: imageId })
  }

  // --- Skills ---

  async listSkills(): Promise<RpcResult<'skills.list'>> {
    return this.call('skills.list')
  }

  async refreshSkills(): Promise<RpcResult<'skills.refresh'>> {
    return this.call('skills.refresh')
  }

  async removeSkill(name: string): Promise<RpcResult<'skills.remove'>> {
    return this.call('skills.remove', { name })
  }

  // --- Collections ---

  async listCollections(): Promise<RpcResult<'collection.list'>> {
    return this.call('collection.list')
  }

  async getCollection(id: string): Promise<RpcResult<'collection.get'>> {
    return this.call('collection.get', { id })
  }

  async createCollection(name: string, schema: FieldDefInput[], icon?: string): Promise<RpcResult<'collection.create'>> {
    return this.call('collection.create', { name, schema, icon })
  }

  async updateCollection(id: string, updates: CollectionUpdates): Promise<RpcResult<'collection.update'>> {
    return this.call('collection.update', { id, updates })
  }

  async deleteCollection(id: string): Promise<RpcResult<'collection.delete'>> {
    return this.call('collection.delete', { id })
  }

  async renameCollectionField(id: string, oldName: string, newName: string): Promise<RpcResult<'collection.renameField'>> {
    return this.call('collection.renameField', { id, oldName, newName })
  }

  async listCollectionItems(collectionId: string): Promise<RpcResult<'collection.listItems'>> {
    return this.call('collection.listItems', { collectionId })
  }

  async getCollectionItem(id: string): Promise<RpcResult<'collection.getItem'>> {
    return this.call('collection.getItem', { id })
  }

  async addCollectionItem(collectionId: string, data: Record<string, unknown>): Promise<RpcResult<'collection.addItem'>> {
    return this.call('collection.addItem', { collectionId, data })
  }

  async updateCollectionItem(id: string, data: Record<string, unknown>): Promise<RpcResult<'collection.updateItem'>> {
    return this.call('collection.updateItem', { id, data })
  }

  async deleteCollectionItem(id: string): Promise<RpcResult<'collection.deleteItem'>> {
    return this.call('collection.deleteItem', { id })
  }

  async reorderCollectionItems(ids: string[]): Promise<RpcResult<'collection.reorderItems'>> {
    return this.call('collection.reorderItems', { ids })
  }

  onCollectionsChanged(fn: () => void): () => void {
    return this.onNotification('collection.changed', fn)
  }

  onImageChanged(fn: () => void): () => void {
    return this.onNotification('image.changed', fn)
  }

  // --- Collection item comments ---

  async addItemComment(itemId: string, author: 'user' | 'bond', body: string): Promise<RpcResult<'collection.addItemComment'>> {
    return this.call('collection.addItemComment', { itemId, author, body })
  }

  async deleteItemComment(id: string): Promise<RpcResult<'collection.deleteItemComment'>> {
    return this.call('collection.deleteItemComment', { id })
  }

  async listItemComments(itemId: string): Promise<RpcResult<'collection.listItemComments'>> {
    return this.call('collection.listItemComments', { itemId })
  }

  async searchCollectionItems(collectionId: string, query: string): Promise<RpcResult<'collection.searchItems'>> {
    return this.call('collection.searchItems', { collectionId, query })
  }

  async getCollectionByName(name: string): Promise<RpcResult<'collection.getByName'>> {
    return this.call('collection.getByName', { name })
  }

  // --- Sense ---

  async senseStatus(): Promise<RpcResult<'sense.status'>> {
    return this.call('sense.status')
  }

  async senseEnable(): Promise<RpcResult<'sense.enable'>> {
    return this.call('sense.enable')
  }

  async senseDisable(): Promise<RpcResult<'sense.disable'>> {
    return this.call('sense.disable')
  }

  async sensePause(minutes?: number): Promise<RpcResult<'sense.pause'>> {
    return this.call('sense.pause', { minutes })
  }

  async senseResume(): Promise<RpcResult<'sense.resume'>> {
    return this.call('sense.resume')
  }

  async senseCaptureReady(captureId: string, imagePath: string): Promise<RpcResult<'sense.captureReady'>> {
    return this.call('sense.captureReady', { captureId, imagePath })
  }

  async webRenderReady(result: WebRenderResult): Promise<RpcResult<'web.renderReady'>> {
    return this.call('web.renderReady', { ...result })
  }

  async senseNow(): Promise<RpcResult<'sense.now'>> {
    return this.call('sense.now')
  }

  async senseToday(): Promise<RpcResult<'sense.today'>> {
    return this.call('sense.today')
  }

  async senseSearch(query: string, limit?: number): Promise<RpcResult<'sense.search'>> {
    return this.call('sense.search', { query, limit })
  }

  async senseApps(range?: string): Promise<RpcResult<'sense.apps'>> {
    return this.call('sense.apps', { range: range as 'today' | 'week' | undefined })
  }

  async senseTimeline(from?: string, to?: string, limit?: number): Promise<RpcResult<'sense.timeline'>> {
    return this.call('sense.timeline', { from, to, limit })
  }

  async senseCapture(id: string): Promise<RpcResult<'sense.capture'>> {
    return this.call('sense.capture', { id })
  }

  async senseSessions(from?: string, to?: string): Promise<RpcResult<'sense.sessions'>> {
    return this.call('sense.sessions', { from, to })
  }

  async senseSettings(): Promise<RpcResult<'sense.settings'>> {
    return this.call('sense.settings')
  }

  async senseUpdateSettings(updates: Partial<SenseSettings>): Promise<RpcResult<'sense.updateSettings'>> {
    return this.call('sense.updateSettings', { updates })
  }

  async senseClear(range?: { from?: string; to?: string }): Promise<RpcResult<'sense.clear'>> {
    return this.call('sense.clear', { range })
  }

  async senseStats(): Promise<RpcResult<'sense.stats'>> {
    return this.call('sense.stats')
  }

  // --- Onboarding ---

  async onboardingStatus(): Promise<RpcResult<'onboarding.status'>> {
    return this.call('onboarding.status')
  }

  async onboardingBegin(): Promise<RpcResult<'onboarding.begin'>> {
    return this.call('onboarding.begin')
  }

  async onboardingSkip(): Promise<RpcResult<'onboarding.skip'>> {
    return this.call('onboarding.skip')
  }

  // --- New-user sandbox ---

  async sandboxStatus(): Promise<RpcResult<'sandbox.status'>> {
    return this.call('sandbox.status')
  }

  async sandboxEnter(): Promise<RpcResult<'sandbox.enter'>> {
    return this.call('sandbox.enter')
  }

  async sandboxExit(): Promise<RpcResult<'sandbox.exit'>> {
    return this.call('sandbox.exit')
  }

  // --- Memory ---

  async memoryCore(): Promise<RpcResult<'memory.core'>> {
    return this.call('memory.core')
  }

  async memoryUpdateCore(core: CoreMemory): Promise<RpcResult<'memory.updateCore'>> {
    return this.call('memory.updateCore', { core })
  }

  async memoryWorking(): Promise<RpcResult<'memory.working'>> {
    return this.call('memory.working')
  }

  async memoryUpdateWorking(working: WorkingState): Promise<RpcResult<'memory.updateWorking'>> {
    return this.call('memory.updateWorking', { working })
  }

  async memoryClearWorking(): Promise<RpcResult<'memory.clearWorking'>> {
    return this.call('memory.clearWorking')
  }

  async memorySearch(query: string, limit?: number): Promise<RpcResult<'memory.search'>> {
    return this.call('memory.search', { query, limit })
  }

  async memoryUpsert(item: MemoryItemInput): Promise<RpcResult<'memory.upsert'>> {
    return this.call('memory.upsert', { item })
  }

  async memoryDelete(id: string): Promise<RpcResult<'memory.delete'>> {
    return this.call('memory.delete', { id })
  }

  async memorySources(id: string): Promise<RpcResult<'memory.sources'>> {
    return this.call('memory.sources', { id })
  }

  async senseMemory(limit?: number): Promise<RpcResult<'sense.memory'>> {
    return this.call('sense.memory', { limit })
  }

  async senseDebrief(id?: string, sessionId?: string): Promise<RpcResult<'sense.debrief'>> {
    return this.call('sense.debrief', { id, sessionId })
  }

  async senseDeleteDebrief(id: string): Promise<RpcResult<'sense.deleteDebrief'>> {
    return this.call('sense.deleteDebrief', { id })
  }

  async senseSystemPromptPreview(editMode?: EditMode): Promise<RpcResult<'sense.systemPromptPreview'>> {
    return this.call('sense.systemPromptPreview', { editMode })
  }

  onSenseRequestCapture(fn: (payload: RpcNotifications['sense.requestCapture']) => void): () => void {
    return this.onNotification('sense.requestCapture', fn)
  }

  onSenseStateChanged(fn: (payload: RpcNotifications['sense.stateChanged']) => void): () => void {
    return this.onNotification('sense.stateChanged', fn)
  }

  onWebRequestRender(fn: (payload: RpcNotifications['web.requestRender']) => void): () => void {
    return this.onNotification('web.requestRender', fn)
  }

  // --- Settings ---

  async getSoul(): Promise<RpcResult<'settings.getSoul'>> {
    return this.call('settings.getSoul')
  }

  async saveSoul(content: string): Promise<RpcResult<'settings.saveSoul'>> {
    return this.call('settings.saveSoul', { content })
  }

  async getAccentColor(): Promise<RpcResult<'settings.getAccentColor'>> {
    return this.call('settings.getAccentColor')
  }

  async saveAccentColor(hex: string): Promise<RpcResult<'settings.saveAccentColor'>> {
    return this.call('settings.saveAccentColor', { hex })
  }

  async getWindowOpacity(): Promise<RpcResult<'settings.getWindowOpacity'>> {
    return this.call('settings.getWindowOpacity')
  }

  async saveWindowOpacity(opacity: number): Promise<RpcResult<'settings.saveWindowOpacity'>> {
    return this.call('settings.saveWindowOpacity', { opacity })
  }

}
