import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebBondClient, readPairingToken, clearPairingToken } from './client'
import { makeResponse, makeErrorResponse, makeNotification, PROTOCOL_VERSION, type JsonRpcRequest } from '../../shared/protocol'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0
  OPEN = 1
  sent: JsonRpcRequest[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  // Test drivers
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  respondTo(method: string, result: unknown): void {
    const req = this.sent.find(m => m.method === method)
    if (!req) throw new Error(`no request for ${method}`)
    this.receive(makeResponse(req.id, result))
  }
}

function makeClient(overrides: { setTimeoutImpl?: typeof setTimeout } = {}) {
  const client = new WebBondClient({
    url: 'ws://127.0.0.1:3113/',
    token: 'tok',
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    ...overrides,
  })
  client.connect()
  const ws = FakeWebSocket.instances.at(-1)!
  return { client, ws }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  localStorage.clear()
})

describe('WebBondClient', () => {
  it('authenticates first, then flushes calls made while connecting', async () => {
    const { client, ws } = makeClient()
    const pending = client.call('transcript.list', { limit: 10 })

    ws.open()
    expect(ws.sent[0]).toMatchObject({ method: 'bond.auth', params: { token: 'tok' } })
    expect(ws.sent).toHaveLength(1)

    ws.respondTo('bond.auth', { ok: true, protocolVersion: PROTOCOL_VERSION })
    expect(client.state).toBe('connected')
    await vi.waitFor(() => expect(ws.sent.some(m => m.method === 'transcript.list')).toBe(true))

    ws.respondTo('transcript.list', { messages: [], nextBeforeSeq: null })
    expect(await pending).toEqual({ messages: [], nextBeforeSeq: null })
  })

  it('rejects calls whose response is a JSON-RPC error', async () => {
    const { client, ws } = makeClient()
    ws.open()
    ws.respondTo('bond.auth', { ok: true, protocolVersion: PROTOCOL_VERSION })

    const call = client.call('skills.remove', { name: 'x' })
    await vi.waitFor(() => expect(ws.sent.some(m => m.method === 'skills.remove')).toBe(true))
    const req = ws.sent.find(m => m.method === 'skills.remove')!
    ws.receive(makeErrorResponse(req.id, -32601, 'Unknown method'))

    await expect(call).rejects.toThrow('Unknown method')
  })

  it('dispatches bond.chunk notifications to onChunk listeners', async () => {
    const { client, ws } = makeClient()
    ws.open()
    ws.respondTo('bond.auth', { ok: true, protocolVersion: PROTOCOL_VERSION })

    const chunks: unknown[] = []
    const dispose = client.onChunk(chunk => chunks.push(chunk))
    ws.receive(makeNotification('bond.chunk', { kind: 'assistant_text', text: 'hi' }))
    expect(chunks).toEqual([{ kind: 'assistant_text', text: 'hi' }])

    dispose()
    ws.receive(makeNotification('bond.chunk', { kind: 'assistant_text', text: 'bye' }))
    expect(chunks).toHaveLength(1)
  })

  it('parks as unpaired on a rejected token and does not reconnect', async () => {
    const timeouts: Array<() => void> = []
    const setTimeoutImpl = ((fn: () => void) => { timeouts.push(fn); return 0 }) as unknown as typeof setTimeout
    const { client, ws } = makeClient({ setTimeoutImpl })

    ws.open()
    const authReq = ws.sent[0]
    ws.receive(makeErrorResponse(authReq.id, -32600, 'Invalid auth token'))
    expect(client.state).toBe('unpaired')

    ws.close()
    expect(client.state).toBe('unpaired')
    expect(timeouts).toHaveLength(0)
  })

  it('parks as mismatch when the daemon speaks a different protocol version', async () => {
    // An old daemon (or one missing the version entirely) would fail per-call
    // with Unknown method — park with a clear state instead of limping.
    const timeouts: Array<() => void> = []
    const setTimeoutImpl = ((fn: () => void) => { timeouts.push(fn); return 0 }) as unknown as typeof setTimeout
    const { client, ws } = makeClient({ setTimeoutImpl })

    ws.open()
    ws.respondTo('bond.auth', { ok: true })
    expect(client.state).toBe('mismatch')

    ws.close()
    expect(client.state).toBe('mismatch')
    expect(timeouts).toHaveLength(0)
  })

  it('reconnects with backoff after a drop and re-subscribes automatically', async () => {
    const timeouts: Array<{ fn: () => void; ms: number }> = []
    const setTimeoutImpl = ((fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return 0 }) as unknown as typeof setTimeout
    const { client, ws } = makeClient({ setTimeoutImpl })

    ws.open()
    ws.respondTo('bond.auth', { ok: true, protocolVersion: PROTOCOL_VERSION })
    const subscribed = client.subscribe()
    await vi.waitFor(() => expect(ws.sent.some(m => m.method === 'bond.subscribe')).toBe(true))
    ws.respondTo('bond.subscribe', { ok: true })
    await subscribed

    ws.close()
    expect(client.state).toBe('disconnected')
    const reconnects = timeouts.filter(t => t.ms === 1000)
    expect(reconnects).toHaveLength(1)

    reconnects[0].fn()
    const ws2 = FakeWebSocket.instances.at(-1)!
    expect(ws2).not.toBe(ws)
    ws2.open()
    ws2.respondTo('bond.auth', { ok: true, protocolVersion: PROTOCOL_VERSION })
    expect(client.state).toBe('connected')
    // The global subscription is re-established without the app's help.
    await vi.waitFor(() => expect(ws2.sent.some(m => m.method === 'bond.subscribe')).toBe(true))
  })

  it('treats a drop during the handshake as a reconnect, not a bad token', async () => {
    const timeouts: Array<() => void> = []
    const setTimeoutImpl = ((fn: () => void) => { timeouts.push(fn); return 0 }) as unknown as typeof setTimeout
    const { client, ws } = makeClient({ setTimeoutImpl })

    ws.open()
    ws.close() // server died before answering bond.auth
    expect(client.state).toBe('disconnected')
    expect(timeouts).toHaveLength(1)
  })

  // Regression: iOS kills WebSockets on lock without firing close — the
  // socket reads OPEN but is dead, and messages sent into it vanish. The
  // heartbeat must detect the zombie and tear it down so reconnect kicks in.
  it('tears down a zombie socket when the heartbeat ping gets no answer', async () => {
    const timeouts: Array<{ fn: () => void; ms: number }> = []
    const setTimeoutImpl = ((fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return 0 }) as unknown as typeof setTimeout
    const { client, ws } = makeClient({ setTimeoutImpl })
    ws.open()
    ws.respondTo('bond.auth', { ok: true, protocolVersion: PROTOCOL_VERSION })

    // Auth success scheduled the heartbeat.
    const heartbeat = timeouts.find(t => t.ms === 20_000)
    expect(heartbeat).toBeDefined()
    heartbeat!.fn()
    await vi.waitFor(() => expect(ws.sent.some(m => m.method === 'bond.ping')).toBe(true))

    // No pong — the ping deadline fires and the socket must be torn down.
    const deadline = timeouts.find(t => t.ms === 5_000)
    expect(deadline).toBeDefined()
    deadline!.fn()
    await vi.waitFor(() => expect(client.state).toBe('disconnected'))
    // …and a reconnect is scheduled.
    expect(timeouts.some(t => t.ms === 1000)).toBe(true)
  })

  it('keeps the connection and reschedules after a successful heartbeat', async () => {
    const timeouts: Array<{ fn: () => void; ms: number }> = []
    const setTimeoutImpl = ((fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return 0 }) as unknown as typeof setTimeout
    const { client, ws } = makeClient({ setTimeoutImpl })
    ws.open()
    ws.respondTo('bond.auth', { ok: true, protocolVersion: PROTOCOL_VERSION })

    timeouts.find(t => t.ms === 20_000)!.fn()
    await vi.waitFor(() => expect(ws.sent.some(m => m.method === 'bond.ping')).toBe(true))
    ws.respondTo('bond.ping', { ok: true })

    await vi.waitFor(() => expect(timeouts.filter(t => t.ms === 20_000)).toHaveLength(2))
    expect(client.state).toBe('connected')
  })

  it('notifies state listeners for the connection banner', async () => {
    const { client, ws } = makeClient()
    const states: string[] = []
    client.onStateChange(state => states.push(state))

    ws.open()
    ws.respondTo('bond.auth', { ok: true, protocolVersion: PROTOCOL_VERSION })
    expect(states).toEqual(['connected'])
  })
})

describe('readPairingToken', () => {
  it('captures the token from the URL fragment and scrubs it', () => {
    window.location.hash = '#t=abc123'
    expect(readPairingToken()).toBe('abc123')
    expect(window.location.hash).toBe('')
    // Subsequent visits read from storage.
    expect(readPairingToken()).toBe('abc123')
  })

  it('returns null when nothing is stored', () => {
    clearPairingToken()
    window.location.hash = ''
    expect(readPairingToken()).toBeNull()
  })
})
