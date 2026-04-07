import WebSocket from 'ws'
import type { TaggedChunk } from './stream'
import type { Session, SessionMessage, AttachedImage, ImageRecord, TodoItem, Project, ProjectResource, ProjectType, Collection, CollectionItem, FieldDef, ItemComment } from './session'
import type { SenseStatus, SenseSettings, SenseCapture } from './sense'
import type { Operative, OperativeEvent, SpawnOperativeOptions } from './operative'
import {
  makeRequest,
  isResponse,
  isNotification,
  type JsonRpcResponse,
  type JsonRpcMessage
} from './protocol'

type ChunkListener = (chunk: TaggedChunk) => void
type TodoChangeListener = () => void
type ProjectChangeListener = () => void
type CollectionChangeListener = () => void
type BrowserCommandListener = (cmd: import('./browser').BrowserCommand) => void
type SenseRequestCaptureListener = (payload: { captureDir: string; captureId: string }) => void
type SenseStateChangedListener = (payload: { state: string }) => void
type OperativeChangeListener = () => void
type OperativeEventListener = (payload: { operativeId: string; event: OperativeEvent }) => void

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export class BondClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<string | number, PendingRequest>()
  private chunkListeners = new Set<ChunkListener>()
  private todoChangeListeners = new Set<TodoChangeListener>()
  private projectChangeListeners = new Set<ProjectChangeListener>()
  private collectionChangeListeners = new Set<CollectionChangeListener>()
  private browserCommandListeners = new Set<BrowserCommandListener>()
  private senseRequestCaptureListeners = new Set<SenseRequestCaptureListener>()
  private senseStateChangedListeners = new Set<SenseStateChangedListener>()
  private operativeChangeListeners = new Set<OperativeChangeListener>()
  private operativeEventListeners = new Set<OperativeEventListener>()
  private disconnectListeners = new Set<() => void>()
  private socketPath: string
  private _connected = false

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  get connected(): boolean {
    return this._connected
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws+unix://${this.socketPath}`
      this.ws = new WebSocket(url)

      this.ws.on('open', () => {
        this._connected = true
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
              p.reject(new Error(msg.error.message))
            } else {
              p.resolve(msg.result)
            }
          }
        } else if (isNotification(msg)) {
          if (msg.method === 'bond.chunk' && msg.params) {
            const chunk = msg.params as TaggedChunk
            for (const fn of this.chunkListeners) {
              fn(chunk)
            }
          } else if (msg.method === 'todo.changed') {
            for (const fn of this.todoChangeListeners) {
              fn()
            }
          } else if (msg.method === 'project.changed') {
            for (const fn of this.projectChangeListeners) {
              fn()
            }
          } else if (msg.method === 'collection.changed') {
            for (const fn of this.collectionChangeListeners) {
              fn()
            }
          } else if (msg.method === 'browser.command' && msg.params) {
            const cmd = msg.params as import('./browser').BrowserCommand
            for (const fn of this.browserCommandListeners) {
              fn(cmd)
            }
          } else if (msg.method === 'sense.requestCapture' && msg.params) {
            const payload = msg.params as { captureDir: string; captureId: string }
            for (const fn of this.senseRequestCaptureListeners) {
              fn(payload)
            }
          } else if (msg.method === 'sense.stateChanged' && msg.params) {
            const payload = msg.params as { state: string }
            for (const fn of this.senseStateChangedListeners) {
              fn(payload)
            }
          } else if (msg.method === 'operative.changed') {
            for (const fn of this.operativeChangeListeners) {
              fn()
            }
          } else if (msg.method === 'operative.event' && msg.params) {
            const payload = msg.params as { operativeId: string; event: OperativeEvent }
            for (const fn of this.operativeEventListeners) {
              fn(payload)
            }
          }
        }
      })
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

  private call(method: string, params?: unknown): Promise<unknown> {
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

  // --- Chat ---

  async send(text: string, sessionId?: string, images?: AttachedImage[]): Promise<{ ok: boolean; error?: string; imageIds?: string[] }> {
    return await this.call('bond.send', { text, sessionId, images }) as { ok: boolean; error?: string; imageIds?: string[] }
  }

  async cancel(sessionId?: string): Promise<{ ok: boolean }> {
    return await this.call('bond.cancel', { sessionId }) as { ok: boolean }
  }

  async respondToApproval(requestId: string, approved: boolean): Promise<{ ok: boolean }> {
    return await this.call('bond.approvalResponse', { requestId, approved }) as { ok: boolean }
  }

  onChunk(fn: ChunkListener): () => void {
    this.chunkListeners.add(fn)
    return () => this.chunkListeners.delete(fn)
  }

  onTodoChanged(fn: TodoChangeListener): () => void {
    this.todoChangeListeners.add(fn)
    return () => this.todoChangeListeners.delete(fn)
  }

  // --- Subscriptions ---

  async subscribe(sessionId: string): Promise<{ ok: boolean }> {
    return await this.call('bond.subscribe', { sessionId }) as { ok: boolean }
  }

  async unsubscribe(sessionId: string): Promise<{ ok: boolean }> {
    return await this.call('bond.unsubscribe', { sessionId }) as { ok: boolean }
  }

  // --- Model ---

  async setModel(model: string): Promise<{ ok: boolean }> {
    return await this.call('bond.setModel', { model }) as { ok: boolean }
  }

  async getModel(): Promise<string> {
    return await this.call('bond.getModel') as string
  }

  // --- Sessions ---

  async listSessions(): Promise<Session[]> {
    return await this.call('session.list') as Session[]
  }

  async createSession(options?: { title?: string; projectId?: string }): Promise<Session> {
    return await this.call('session.create', options) as Session
  }

  async getSession(id: string): Promise<Session | null> {
    return await this.call('session.get', { id }) as Session | null
  }

  async updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived' | 'favorited' | 'quick' | 'iconSeed' | 'editMode' | 'projectId'>>): Promise<Session | null> {
    return await this.call('session.update', { id, updates }) as Session | null
  }

  async deleteSession(id: string): Promise<boolean> {
    return await this.call('session.delete', { id }) as boolean
  }

  async deleteArchivedSessions(): Promise<{ ok: boolean; count: number }> {
    return await this.call('session.deleteArchived') as { ok: boolean; count: number }
  }

  async getMessages(sessionId: string): Promise<SessionMessage[]> {
    return await this.call('session.getMessages', { sessionId }) as SessionMessage[]
  }

  async saveMessages(sessionId: string, messages: SessionMessage[]): Promise<boolean> {
    return await this.call('session.saveMessages', { sessionId, messages }) as boolean
  }

  async generateTitle(sessionId: string): Promise<{ title: string; summary: string }> {
    return await this.call('session.generateTitle', { sessionId }) as { title: string; summary: string }
  }

  // --- Images ---

  async listImages(): Promise<ImageRecord[]> {
    return await this.call('image.list') as ImageRecord[]
  }

  async getImage(imageId: string): Promise<AttachedImage | null> {
    return await this.call('image.get', { id: imageId }) as AttachedImage | null
  }

  async getImages(ids: string[]): Promise<(AttachedImage | null)[]> {
    return await this.call('image.getMultiple', { ids }) as (AttachedImage | null)[]
  }

  async importImage(data: string, mediaType: string): Promise<ImageRecord> {
    return await this.call('image.import', { data, mediaType }) as ImageRecord
  }

  async deleteImage(imageId: string): Promise<boolean> {
    return await this.call('image.delete', { id: imageId }) as boolean
  }

  // --- Todos ---

  async listTodos(): Promise<TodoItem[]> {
    return await this.call('todo.list') as TodoItem[]
  }

  async createTodo(text: string, notes = '', group = '', projectId?: string): Promise<TodoItem> {
    return await this.call('todo.create', { text, notes, group, projectId }) as TodoItem
  }

  async updateTodo(id: string, updates: Partial<Pick<TodoItem, 'text' | 'notes' | 'group' | 'done' | 'projectId'>>): Promise<TodoItem | null> {
    return await this.call('todo.update', { id, updates }) as TodoItem | null
  }

  async deleteTodo(id: string): Promise<boolean> {
    return await this.call('todo.delete', { id }) as boolean
  }

  async parseTodo(raw: string): Promise<{ title: string; notes: string; group: string }> {
    return await this.call('todo.parse', { raw }) as { title: string; notes: string; group: string }
  }

  async reorderTodos(ids: string[]): Promise<boolean> {
    return await this.call('todo.reorder', { ids }) as boolean
  }

  // --- Skills ---

  async listSkills(): Promise<{ name: string; description: string; argumentHint: string }[]> {
    return await this.call('skills.list') as { name: string; description: string; argumentHint: string }[]
  }

  async refreshSkills(): Promise<{ name: string; description: string; argumentHint: string }[]> {
    return await this.call('skills.refresh') as { name: string; description: string; argumentHint: string }[]
  }

  async removeSkill(name: string): Promise<{ ok: boolean }> {
    return await this.call('skills.remove', { name }) as { ok: boolean }
  }

  // --- Projects ---

  async listProjects(): Promise<Project[]> {
    return await this.call('project.list') as Project[]
  }

  async getProject(id: string): Promise<Project | null> {
    return await this.call('project.get', { id }) as Project | null
  }

  async createProject(name: string, goal?: string, type?: ProjectType, deadline?: string): Promise<Project> {
    return await this.call('project.create', { name, goal, type, deadline }) as Project
  }

  async updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'goal' | 'type' | 'archived' | 'deadline'>>): Promise<Project | null> {
    return await this.call('project.update', { id, updates }) as Project | null
  }

  async deleteProject(id: string): Promise<boolean> {
    return await this.call('project.delete', { id }) as boolean
  }

  async addProjectResource(projectId: string, kind: ProjectResource['kind'], value: string, label?: string): Promise<ProjectResource> {
    return await this.call('project.addResource', { projectId, kind, value, label }) as ProjectResource
  }

  async removeProjectResource(id: string): Promise<boolean> {
    return await this.call('project.removeResource', { id }) as boolean
  }

  onProjectsChanged(fn: ProjectChangeListener): () => void {
    this.projectChangeListeners.add(fn)
    return () => this.projectChangeListeners.delete(fn)
  }

  // --- Collections ---

  async listCollections(): Promise<Collection[]> {
    return await this.call('collection.list') as Collection[]
  }

  async getCollection(id: string): Promise<Collection | null> {
    return await this.call('collection.get', { id }) as Collection | null
  }

  async createCollection(name: string, schema: FieldDef[], icon?: string): Promise<Collection> {
    return await this.call('collection.create', { name, schema, icon }) as Collection
  }

  async updateCollection(id: string, updates: Partial<Pick<Collection, 'name' | 'icon' | 'schema' | 'archived'>>): Promise<Collection | null> {
    return await this.call('collection.update', { id, updates }) as Collection | null
  }

  async deleteCollection(id: string): Promise<boolean> {
    return await this.call('collection.delete', { id }) as boolean
  }

  async renameCollectionField(id: string, oldName: string, newName: string): Promise<boolean> {
    return await this.call('collection.renameField', { id, oldName, newName }) as boolean
  }

  async listCollectionItems(collectionId: string): Promise<CollectionItem[]> {
    return await this.call('collection.listItems', { collectionId }) as CollectionItem[]
  }

  async getCollectionItem(id: string): Promise<CollectionItem | null> {
    return await this.call('collection.getItem', { id }) as CollectionItem | null
  }

  async addCollectionItem(collectionId: string, data: Record<string, unknown>): Promise<CollectionItem> {
    return await this.call('collection.addItem', { collectionId, data }) as CollectionItem
  }

  async updateCollectionItem(id: string, data: Record<string, unknown>): Promise<CollectionItem | null> {
    return await this.call('collection.updateItem', { id, data }) as CollectionItem | null
  }

  async deleteCollectionItem(id: string): Promise<boolean> {
    return await this.call('collection.deleteItem', { id }) as boolean
  }

  async reorderCollectionItems(ids: string[]): Promise<boolean> {
    return await this.call('collection.reorderItems', { ids }) as boolean
  }

  onCollectionsChanged(fn: CollectionChangeListener): () => void {
    this.collectionChangeListeners.add(fn)
    return () => this.collectionChangeListeners.delete(fn)
  }

  // --- Collection item comments ---

  async addItemComment(itemId: string, author: 'user' | 'bond', body: string): Promise<ItemComment> {
    return await this.call('collection.addItemComment', { itemId, author, body }) as ItemComment
  }

  async deleteItemComment(id: string): Promise<boolean> {
    return await this.call('collection.deleteItemComment', { id }) as boolean
  }

  async listItemComments(itemId: string): Promise<ItemComment[]> {
    return await this.call('collection.listItemComments', { itemId }) as ItemComment[]
  }

  async searchCollectionItems(collectionId: string, query: string): Promise<CollectionItem[]> {
    return await this.call('collection.searchItems', { collectionId, query }) as CollectionItem[]
  }

  async getCollectionByName(name: string): Promise<Collection | null> {
    return await this.call('collection.getByName', { name }) as Collection | null
  }

  // --- Journal (backed by Journal collection) ---

  async listJournalEntries(opts?: { author?: string; projectId?: string; tag?: string; limit?: number; offset?: number }): Promise<CollectionItem[]> {
    return await this.call('journal.list', opts) as CollectionItem[]
  }

  async getJournalEntry(id: string): Promise<CollectionItem | null> {
    return await this.call('journal.get', { id }) as CollectionItem | null
  }

  async createJournalEntry(params: { author: 'user' | 'bond'; title: string; body: string; tags?: string[]; projectId?: string; sessionId?: string }): Promise<CollectionItem> {
    return await this.call('journal.create', params) as CollectionItem
  }

  async updateJournalEntry(id: string, updates: Record<string, unknown>): Promise<CollectionItem | null> {
    return await this.call('journal.update', { id, updates }) as CollectionItem | null
  }

  async deleteJournalEntry(id: string): Promise<boolean> {
    return await this.call('journal.delete', { id }) as boolean
  }

  async searchJournalEntries(query: string): Promise<CollectionItem[]> {
    return await this.call('journal.search', { query }) as CollectionItem[]
  }

  async generateJournalMeta(id: string): Promise<CollectionItem | null> {
    return await this.call('journal.generateMeta', { id }) as CollectionItem | null
  }

  async addJournalComment(entryId: string, author: 'user' | 'bond', body: string): Promise<ItemComment> {
    return await this.call('journal.addComment', { entryId, author, body }) as ItemComment
  }

  async deleteJournalComment(id: string): Promise<boolean> {
    return await this.call('journal.deleteComment', { id }) as boolean
  }

  async generateBondComment(entryId: string): Promise<ItemComment> {
    return await this.call('journal.generateBondComment', { entryId }) as ItemComment
  }

  // --- Browser ---

  async browserOpen(url: string): Promise<unknown> {
    return await this.call('browser.open', { url })
  }

  async browserNavigate(tabId: string, url: string): Promise<unknown> {
    return await this.call('browser.navigate', { tabId, url })
  }

  async browserClose(tabId: string): Promise<unknown> {
    return await this.call('browser.close', { tabId })
  }

  async browserTabs(): Promise<unknown> {
    return await this.call('browser.tabs')
  }

  async browserRead(tabId?: string): Promise<unknown> {
    return await this.call('browser.read', { tabId })
  }

  async browserScreenshot(tabId?: string): Promise<unknown> {
    return await this.call('browser.screenshot', { tabId })
  }

  async browserExec(tabId: string | undefined, js: string): Promise<unknown> {
    return await this.call('browser.exec', { tabId, js })
  }

  async browserConsole(tabId?: string): Promise<unknown> {
    return await this.call('browser.console', { tabId })
  }

  async browserDom(tabId?: string, selector?: string): Promise<unknown> {
    return await this.call('browser.dom', { tabId, selector })
  }

  async browserNetwork(tabId?: string): Promise<unknown> {
    return await this.call('browser.network', { tabId })
  }

  async browserCommandResult(requestId: string, result: unknown): Promise<void> {
    await this.call('browser.commandResult', { requestId, result })
  }

  onBrowserCommand(fn: BrowserCommandListener): () => void {
    this.browserCommandListeners.add(fn)
    return () => this.browserCommandListeners.delete(fn)
  }

  // --- Sense ---

  async senseStatus(): Promise<SenseStatus> {
    return await this.call('sense.status') as SenseStatus
  }

  async senseEnable(): Promise<{ ok: boolean }> {
    return await this.call('sense.enable') as { ok: boolean }
  }

  async senseDisable(): Promise<{ ok: boolean }> {
    return await this.call('sense.disable') as { ok: boolean }
  }

  async sensePause(minutes?: number): Promise<{ ok: boolean; resumeAt: string }> {
    return await this.call('sense.pause', { minutes }) as { ok: boolean; resumeAt: string }
  }

  async senseResume(): Promise<{ ok: boolean }> {
    return await this.call('sense.resume') as { ok: boolean }
  }

  async senseCaptureReady(captureId: string, imagePath: string): Promise<{ ok: boolean }> {
    return await this.call('sense.captureReady', { captureId, imagePath }) as { ok: boolean }
  }

  async sensePermissionChanged(screen: boolean, accessibility: boolean): Promise<{ ok: boolean }> {
    return await this.call('sense.permissionChanged', { screen, accessibility }) as { ok: boolean }
  }

  async senseNow(): Promise<unknown> {
    return await this.call('sense.now')
  }

  async senseToday(): Promise<unknown> {
    return await this.call('sense.today')
  }

  async senseSearch(query: string, limit?: number): Promise<SenseCapture[]> {
    return await this.call('sense.search', { query, limit }) as SenseCapture[]
  }

  async senseApps(range?: string): Promise<unknown> {
    return await this.call('sense.apps', { range })
  }

  async senseTimeline(from?: string, to?: string, limit?: number): Promise<SenseCapture[]> {
    return await this.call('sense.timeline', { from, to, limit }) as SenseCapture[]
  }

  async senseCapture(id: string): Promise<{ capture: SenseCapture; image: string | null }> {
    return await this.call('sense.capture', { id }) as { capture: SenseCapture; image: string | null }
  }

  async senseSessions(from?: string, to?: string): Promise<import('./sense').SenseSession[]> {
    return await this.call('sense.sessions', { from, to }) as import('./sense').SenseSession[]
  }

  async senseSettings(): Promise<SenseSettings> {
    return await this.call('sense.settings') as SenseSettings
  }

  async senseUpdateSettings(updates: Partial<SenseSettings>): Promise<SenseSettings> {
    return await this.call('sense.updateSettings', { updates }) as SenseSettings
  }

  async senseClear(range?: { from?: string; to?: string }): Promise<{ deletedCount: number }> {
    return await this.call('sense.clear', { range }) as { deletedCount: number }
  }

  async senseStats(): Promise<{ storageBytes: number; captureCount: number; sessionCount: number; oldestCapture: string | null }> {
    return await this.call('sense.stats') as { storageBytes: number; captureCount: number; sessionCount: number; oldestCapture: string | null }
  }

  onSenseRequestCapture(fn: SenseRequestCaptureListener): () => void {
    this.senseRequestCaptureListeners.add(fn)
    return () => this.senseRequestCaptureListeners.delete(fn)
  }

  onSenseStateChanged(fn: SenseStateChangedListener): () => void {
    this.senseStateChangedListeners.add(fn)
    return () => this.senseStateChangedListeners.delete(fn)
  }

  // --- Operatives ---

  async listOperatives(filters?: { status?: string; sessionId?: string }): Promise<Operative[]> {
    return await this.call('operative.list', filters) as Operative[]
  }

  async getOperative(id: string): Promise<Operative | null> {
    return await this.call('operative.get', { id }) as Operative | null
  }

  async getOperativeEvents(id: string, afterId?: number, limit?: number): Promise<OperativeEvent[]> {
    return await this.call('operative.events', { id, afterId, limit }) as OperativeEvent[]
  }

  async spawnOperative(opts: SpawnOperativeOptions): Promise<Operative> {
    return await this.call('operative.spawn', opts) as Operative
  }

  async cancelOperative(id: string): Promise<{ ok: boolean }> {
    return await this.call('operative.cancel', { id }) as { ok: boolean }
  }

  async removeOperative(id: string): Promise<{ ok: boolean }> {
    return await this.call('operative.remove', { id }) as { ok: boolean }
  }

  async clearOperatives(status?: string): Promise<{ deleted: number }> {
    return await this.call('operative.clear', { status }) as { deleted: number }
  }

  onOperativeChanged(fn: OperativeChangeListener): () => void {
    this.operativeChangeListeners.add(fn)
    return () => this.operativeChangeListeners.delete(fn)
  }

  onOperativeEvent(fn: OperativeEventListener): () => void {
    this.operativeEventListeners.add(fn)
    return () => this.operativeEventListeners.delete(fn)
  }

  // --- Shell (client-side only, not proxied through daemon) ---

  async openExternal(_url: string): Promise<void> {
    // This stays client-side — each client handles shell.openExternal locally
    throw new Error('openExternal must be handled by the client, not the daemon')
  }

  // --- Settings ---

  async getSoul(): Promise<string> {
    return await this.call('settings.getSoul') as string
  }

  async saveSoul(content: string): Promise<boolean> {
    return await this.call('settings.saveSoul', { content }) as boolean
  }

  async getAccentColor(): Promise<string> {
    return await this.call('settings.getAccentColor') as string
  }

  async saveAccentColor(hex: string): Promise<boolean> {
    return await this.call('settings.saveAccentColor', { hex }) as boolean
  }

  async getWindowOpacity(): Promise<number> {
    return await this.call('settings.getWindowOpacity') as number
  }

  async saveWindowOpacity(opacity: number): Promise<boolean> {
    return await this.call('settings.saveWindowOpacity', { opacity }) as boolean
  }

}
