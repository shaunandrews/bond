import WebSocket from 'ws'
import type { TaggedChunk } from './stream'
import type { Session, SessionMessage, AttachedImage, ImageRecord, TodoItem, Project, ProjectResource, ProjectType, Collection, CollectionItem, FieldDef } from './session'
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

  async updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived' | 'favorited' | 'iconSeed' | 'editMode' | 'projectId'>>): Promise<Session | null> {
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
