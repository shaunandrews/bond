import WebSocket from 'ws'
import type { TaggedChunk } from './stream'
import type { Session, SessionMessage, AttachedImage } from './session'
import type { WordPressSite, WordPressSiteDetails } from './wordpress'
import {
  makeRequest,
  isResponse,
  isNotification,
  type JsonRpcResponse,
  type JsonRpcMessage
} from './protocol'

type ChunkListener = (chunk: TaggedChunk) => void

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export class BondClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<string | number, PendingRequest>()
  private chunkListeners = new Set<ChunkListener>()
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

  async createSession(options?: { siteId?: string; title?: string }): Promise<Session> {
    return await this.call('session.create', options) as Session
  }

  async getSession(id: string): Promise<Session | null> {
    return await this.call('session.get', { id }) as Session | null
  }

  async updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived' | 'editMode' | 'siteId'>>): Promise<Session | null> {
    return await this.call('session.update', { id, updates }) as Session | null
  }

  async deleteSession(id: string): Promise<boolean> {
    return await this.call('session.delete', { id }) as boolean
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

  async getImage(imageId: string): Promise<AttachedImage | null> {
    return await this.call('image.get', { id: imageId }) as AttachedImage | null
  }

  async getImages(ids: string[]): Promise<(AttachedImage | null)[]> {
    return await this.call('image.getMultiple', { ids }) as (AttachedImage | null)[]
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

  // --- WordPress ---

  async listWordPressSites(): Promise<{ available: boolean; sites: WordPressSite[] }> {
    return await this.call('wordpress.list') as { available: boolean; sites: WordPressSite[] }
  }

  async getWordPressSiteDetails(path: string): Promise<WordPressSiteDetails | null> {
    return await this.call('wordpress.details', { path }) as WordPressSiteDetails | null
  }

  async createWordPressSite(name: string): Promise<{ available: boolean; sites: WordPressSite[] }> {
    return await this.call('wordpress.create', { name }) as { available: boolean; sites: WordPressSite[] }
  }

  async startWordPressSite(path: string): Promise<{ available: boolean; sites: WordPressSite[] }> {
    return await this.call('wordpress.start', { path }) as { available: boolean; sites: WordPressSite[] }
  }

  async stopWordPressSite(path: string): Promise<{ available: boolean; sites: WordPressSite[] }> {
    return await this.call('wordpress.stop', { path }) as { available: boolean; sites: WordPressSite[] }
  }

  async deleteWordPressSite(path: string): Promise<{ available: boolean; sites: WordPressSite[] }> {
    return await this.call('wordpress.delete', { path }) as { available: boolean; sites: WordPressSite[] }
  }
}
