import { makeRequest, isResponse, isNotification, PROTOCOL_VERSION, type JsonRpcMessage } from '../../shared/protocol'
import type { TaggedChunk } from '../../shared/stream'
import type {
  DispatchableMethod,
  RpcNotificationName,
  RpcNotifications,
  RpcParamsArg,
  RpcResult,
} from '../../shared/rpc-schema'

/**
 * Browser counterpart of BondClient: the same JSON-RPC protocol over the
 * native WebSocket (the Node `ws` client can't run in a browser), speaking to
 * the daemon's remote LAN listener with the pairing token.
 *
 * Requests made before the socket is authenticated wait for the handshake, so
 * the app can start calling immediately on mount. On close it reconnects with
 * backoff — and immediately when the tab becomes visible again, since mobile
 * browsers kill background sockets. A rejected token parks the client in
 * 'unpaired' instead of hammering the server.
 */

export type ConnectionState = 'connecting' | 'connected' | 'unpaired' | 'mismatch' | 'disconnected'

export interface WebBondClientOptions {
  url: string
  token: string
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket
  /** Injectable for tests — backoff/heartbeat scheduling. */
  setTimeoutImpl?: typeof setTimeout
  /** Liveness-probe pacing — injectable for tests. */
  heartbeatMs?: number
  pingTimeoutMs?: number
}

const MAX_BACKOFF_MS = 15_000
const HEARTBEAT_MS = 20_000
const PING_TIMEOUT_MS = 5_000

export class WebBondClient {
  private ws: WebSocket | null = null
  private readonly options: WebBondClientOptions
  private nextId = 1
  private pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  private notificationListeners = new Map<RpcNotificationName, Set<(payload: never) => void>>()
  private stateListeners = new Set<(state: ConnectionState) => void>()
  private _state: ConnectionState = 'disconnected'
  private authed!: Promise<void>
  private resolveAuthed!: () => void
  private rejectAuthed!: (err: Error) => void
  private backoffMs = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private wasSubscribed = false
  private authRequestId: string | number | null = null

  constructor(options: WebBondClientOptions) {
    this.options = options
    this.resetAuthedGate()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (this._state === 'disconnected') this.connect()
        // iOS kills WebSockets on lock WITHOUT firing close — the socket
        // still reads as OPEN. Never trust it after waking; verify.
        else if (this._state === 'connected') void this.verifyAlive()
      })
    }
  }

  get state(): ConnectionState {
    return this._state
  }

  onStateChange(fn: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return
    this._state = state
    for (const fn of this.stateListeners) fn(state)
  }

  private resetAuthedGate(): void {
    this.authed = new Promise<void>((resolve, reject) => {
      this.resolveAuthed = resolve
      this.rejectAuthed = reject
    })
    // A dropped connection rejects the gate; without a handler that's an
    // unhandled rejection even when every caller awaits a fresh gate later.
    this.authed.catch(() => {})
  }

  connect(): void {
    if (this.closed || this._state === 'connecting' || this._state === 'connected') return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.setState('connecting')
    const WS = this.options.WebSocketImpl ?? WebSocket
    const ws = new WS(this.options.url)
    this.ws = ws

    ws.onopen = () => {
      const id = this.nextId++
      this.authRequestId = id
      ws.send(JSON.stringify(makeRequest(id, 'bond.auth', { token: this.options.token })))
    }

    ws.onmessage = (event: MessageEvent) => {
      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (isResponse(msg)) {
        // The auth reply is handled outside the pending map: only an explicit
        // error RESPONSE means a bad token ('unpaired', no retry loop) — a
        // dropped connection mid-handshake must stay a plain reconnect.
        if (msg.id === this.authRequestId) {
          this.authRequestId = null
          if (msg.error) {
            this.setState('unpaired')
            this.rejectAuthed(new Error('Pairing token rejected'))
          } else {
            // Version skew parks like a bad token — every call against a
            // mismatched daemon is potentially "Unknown method", and only
            // restarting Bond on the Mac (then reloading here) can fix it.
            const version = (msg.result as { protocolVersion?: number } | undefined)?.protocolVersion ?? 0
            if (version !== PROTOCOL_VERSION) {
              this.setState('mismatch')
              this.rejectAuthed(new Error(`Daemon speaks protocol ${version}, this client needs ${PROTOCOL_VERSION}`))
              return
            }
            this.backoffMs = 1000
            this.setState('connected')
            if (this.wasSubscribed) {
              void this.call('bond.subscribe').catch(() => {})
            }
            this.resolveAuthed()
            this.scheduleHeartbeat()
          }
          return
        }
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(msg.error.message))
        else entry.resolve(msg.result)
        return
      }
      if (isNotification(msg)) {
        const listeners = this.notificationListeners.get(msg.method as RpcNotificationName)
        if (listeners) for (const fn of listeners) fn(msg.params as never)
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.heartbeatTimer) {
        clearTimeout(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
      const parked = this._state === 'unpaired' || this._state === 'mismatch'
      this.rejectAuthed(new Error('Connection closed'))
      this.resetAuthedGate()
      for (const entry of this.pending.values()) entry.reject(new Error('Connection closed'))
      this.pending.clear()
      if (this.closed || parked) return
      this.setState('disconnected')
      this.reconnectTimer = (this.options.setTimeoutImpl ?? setTimeout)(() => this.connect(), this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    }

    ws.onerror = () => {
      // onclose follows and drives the retry.
    }
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.ws?.close()
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = (this.options.setTimeoutImpl ?? setTimeout)(
      () => void this.verifyAlive(),
      this.options.heartbeatMs ?? HEARTBEAT_MS,
    )
  }

  /**
   * Round-trip a bond.ping with a deadline. A socket that looks OPEN but
   * never answers is a zombie — tear it down so the normal reconnect path
   * takes over (which also flushes calls parked on the auth gate).
   */
  private async verifyAlive(): Promise<void> {
    if (this.closed || this._state !== 'connected') return
    const timeout = new Promise<never>((_, reject) => {
      (this.options.setTimeoutImpl ?? setTimeout)(
        () => reject(new Error('ping timeout')),
        this.options.pingTimeoutMs ?? PING_TIMEOUT_MS,
      )
    })
    try {
      await Promise.race([this.call('bond.ping'), timeout])
      this.scheduleHeartbeat()
    } catch {
      this.ws?.close()
    }
  }

  /** Registry-typed RPC: method names, params, and results come from RpcMethods. */
  call<M extends DispatchableMethod>(method: M, ...args: RpcParamsArg<M>): Promise<RpcResult<M>> {
    return this.callRaw(method, (args as unknown[])[0]) as Promise<RpcResult<M>>
  }

  /** Untyped path — internal messages (bond.auth is consumed before dispatch). */
  private async callRaw(method: string, params?: unknown): Promise<unknown> {
    if (method !== 'bond.auth') await this.authed
    const ws = this.ws
    if (!ws || ws.readyState !== ws.OPEN) throw new Error('Not connected')
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      ws.send(JSON.stringify(makeRequest(id, method, params)))
    })
  }

  async subscribe(sessionId?: string): Promise<{ ok: true }> {
    if (!sessionId) this.wasSubscribed = true
    return await this.call('bond.subscribe', sessionId ? { sessionId } : undefined)
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

  onChunk(fn: (chunk: TaggedChunk) => void): () => void {
    return this.onNotification('bond.chunk', fn)
  }
}

const TOKEN_STORAGE_KEY = 'bond:remote-token'
const DEVICE_TOKEN_STORAGE_KEY = 'bond:device-credential'

/**
 * The pairing token arrives in the URL fragment (`#t=…`) on first visit and
 * is kept in localStorage after that. The fragment is scrubbed from the URL
 * so it doesn't linger in the address bar or get shared by accident.
 */
export function readPairingToken(): string | null {
  const match = window.location.hash.match(/[#&]t=([0-9a-f]+)/)
  if (match) {
    try { localStorage.setItem(TOKEN_STORAGE_KEY, match[1]) } catch { /* private mode */ }
    history.replaceState(null, '', window.location.pathname + window.location.search)
    return match[1]
  }
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function clearPairingToken(): void {
  try { localStorage.removeItem(TOKEN_STORAGE_KEY) } catch { /* ignore */ }
}

/**
 * A Home Screen web app has its own storage context and can never read the
 * token Safari saved, so it earns its own credential through the pairing-code
 * exchange and keeps it here.
 */
export function readDeviceCredential(): string | null {
  try {
    return localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeDeviceCredential(token: string): void {
  try { localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, token) } catch { /* private mode */ }
}

export function clearDeviceCredential(): void {
  try { localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY) } catch { /* ignore */ }
}

/**
 * A device credential outranks the shared token: if this client has paired on
 * its own, that credential is the one an owner can revoke individually.
 */
export function resolveAuthToken(): string | null {
  return readDeviceCredential() ?? readPairingToken()
}

/** True when running as an installed Home Screen / desktop web app. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false
  // iOS Safari predates display-mode and only sets the legacy navigator flag.
  if ((navigator as { standalone?: boolean }).standalone === true) return true
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches === true
  } catch {
    return false
  }
}

export type PairingError = 'invalid' | 'expired' | 'used' | 'throttled' | 'unavailable' | 'offline'

export type PairingOutcome = { ok: true; deviceToken: string } | { ok: false; reason: PairingError }

/**
 * Redeem a one-time code for this device's credential. Plain HTTP, not RPC:
 * an unpaired client has no token, and the WebSocket auth gate hangs up on a
 * bad one.
 */
export async function exchangePairingCode(code: string, fetchImpl: typeof fetch = fetch): Promise<PairingOutcome> {
  let res: Response
  try {
    res = await fetchImpl('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  } catch {
    // The Mac is asleep, off the network, or on a different Wi-Fi — never
    // report this as a bad code.
    return { ok: false, reason: 'offline' }
  }

  let payload: { deviceToken?: unknown; error?: unknown } = {}
  try {
    payload = (await res.json()) as typeof payload
  } catch { /* fall through to the status-based verdict */ }

  if (res.ok && typeof payload.deviceToken === 'string') {
    storeDeviceCredential(payload.deviceToken)
    return { ok: true, deviceToken: payload.deviceToken }
  }
  const reason = payload.error
  const known: PairingError[] = ['invalid', 'expired', 'used', 'throttled', 'unavailable']
  return { ok: false, reason: known.includes(reason as PairingError) ? (reason as PairingError) : 'invalid' }
}
