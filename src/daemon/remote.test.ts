import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocket } from 'ws'
import {
  resolveStaticPath,
  handleStaticRequest,
  handlePairRequest,
  originAllowed,
  pairingUrls,
  startRemoteServer,
  getRemoteStatus,
  type RemoteServer,
} from './remote'

describe('resolveStaticPath', () => {
  const root = '/srv/web'

  it('maps / to index.html', () => {
    expect(resolveStaticPath(root, '/')).toBe(join(root, 'index.html'))
  })

  it('maps asset paths inside the root', () => {
    expect(resolveStaticPath(root, '/assets/app.js')).toBe(join(root, 'assets/app.js'))
  })

  it('strips query strings and fragments', () => {
    expect(resolveStaticPath(root, '/index.html?v=1#t=abc')).toBe(join(root, 'index.html'))
  })

  it('rejects path traversal', () => {
    expect(resolveStaticPath(root, '/../etc/passwd')).toBeNull()
    expect(resolveStaticPath(root, '/assets/../../etc/passwd')).toBeNull()
    expect(resolveStaticPath(root, '/%2e%2e/etc/passwd')).toBeNull()
  })

  it('rejects malformed encoding and null bytes', () => {
    expect(resolveStaticPath(root, '/%zz')).toBeNull()
    expect(resolveStaticPath(root, '/a%00.html')).toBeNull()
  })
})

describe('originAllowed', () => {
  it('allows requests without an Origin header (non-browser clients)', () => {
    expect(originAllowed(undefined, '192.168.1.5:3113')).toBe(true)
  })

  it('allows an origin matching the host', () => {
    expect(originAllowed('http://192.168.1.5:3113', '192.168.1.5:3113')).toBe(true)
  })

  it('rejects a cross-origin browser request', () => {
    expect(originAllowed('http://evil.test', '192.168.1.5:3113')).toBe(false)
    expect(originAllowed('http://192.168.1.5:9999', '192.168.1.5:3113')).toBe(false)
  })

  it('rejects unparseable origins and missing hosts', () => {
    expect(originAllowed('not a url', '192.168.1.5:3113')).toBe(false)
    expect(originAllowed('http://a.test', undefined)).toBe(false)
  })
})

describe('pairingUrls', () => {
  it('builds URLs with the token in the fragment', () => {
    for (const url of pairingUrls(3113, 'tok123')) {
      expect(url).toMatch(/^http:\/\/[\d.]+:3113\/#t=tok123$/)
    }
  })
})

describe('handleStaticRequest', () => {
  function makeWebRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bond-remote-test-'))
    writeFileSync(join(dir, 'index.html'), '<h1>bond</h1>')
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    return dir
  }

  function fakeRes() {
    const state = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown, ended: false }
    const res = {
      writeHead: vi.fn((status: number, headers: Record<string, string>) => {
        state.status = status
        state.headers = headers
        return res
      }),
      end: vi.fn((body?: unknown) => {
        state.body = body
        state.ended = true
      }),
    }
    return { res: res as unknown as ServerResponse, state }
  }

  const roots: string[] = []
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('serves index.html at / with no-cache', async () => {
    const root = makeWebRoot()
    roots.push(root)
    const { res, state } = fakeRes()
    await handleStaticRequest(root, { method: 'GET', url: '/' } as IncomingMessage, res)
    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toContain('text/html')
    expect(state.headers['cache-control']).toBe('no-cache')
    expect(String(state.body)).toContain('bond')
  })

  it('serves assets with long-lived caching and the right MIME type', async () => {
    const root = makeWebRoot()
    roots.push(root)
    const { res, state } = fakeRes()
    await handleStaticRequest(root, { method: 'GET', url: '/assets/app.js' } as IncomingMessage, res)
    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toContain('text/javascript')
    expect(state.headers['cache-control']).toContain('immutable')
  })

  it('never pins the manifest or icons — their URLs are stable, not fingerprinted', async () => {
    // An immutable manifest would strand an installed Home Screen app on a
    // year-old copy the next time it changes.
    const root = makeWebRoot()
    roots.push(root)
    writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"Bond"}')
    mkdirSync(join(root, 'icons'))
    writeFileSync(join(root, 'icons', 'icon-180.png'), 'png')

    const manifest = fakeRes()
    await handleStaticRequest(root, { method: 'GET', url: '/manifest.webmanifest' } as IncomingMessage, manifest.res)
    expect(manifest.state.status).toBe(200)
    expect(manifest.state.headers['content-type']).toContain('application/manifest+json')
    expect(manifest.state.headers['cache-control']).toBe('no-cache')

    const icon = fakeRes()
    await handleStaticRequest(root, { method: 'GET', url: '/icons/icon-180.png' } as IncomingMessage, icon.res)
    expect(icon.state.headers['cache-control']).toBe('no-cache')
  })

  it('404s for missing files and traversal attempts', async () => {
    const root = makeWebRoot()
    roots.push(root)
    for (const url of ['/nope.js', '/../secret']) {
      const { res, state } = fakeRes()
      await handleStaticRequest(root, { method: 'GET', url } as IncomingMessage, res)
      expect(state.status).toBe(404)
    }
  })

  it('rejects non-GET methods', async () => {
    const root = makeWebRoot()
    roots.push(root)
    const { res, state } = fakeRes()
    await handleStaticRequest(root, { method: 'POST', url: '/' } as IncomingMessage, res)
    expect(state.status).toBe(405)
  })

  it('omits the body on HEAD requests', async () => {
    const root = makeWebRoot()
    roots.push(root)
    const { res, state } = fakeRes()
    await handleStaticRequest(root, { method: 'HEAD', url: '/' } as IncomingMessage, res)
    expect(state.status).toBe(200)
    expect(state.body).toBeUndefined()
  })
})

describe('startRemoteServer', () => {
  let remote: RemoteServer | null = null
  const roots: string[] = []

  afterEach(async () => {
    await remote?.close()
    remote = null
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function start(attach = vi.fn()) {
    const webRoot = mkdtempSync(join(tmpdir(), 'bond-remote-test-'))
    roots.push(webRoot)
    writeFileSync(join(webRoot, 'index.html'), '<h1>bond</h1>')
    remote = startRemoteServer({ port: 0, token: 'test-token', webRoot, attach })
    if (!remote.httpServer.listening) {
      await new Promise<void>(resolve => remote!.httpServer.once('listening', resolve))
    }
    const address = remote.httpServer.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return { port, attach }
  }

  it('serves the bundle over HTTP and reports status', async () => {
    const { port } = await start()
    expect(getRemoteStatus()).toMatchObject({ running: true, port, token: 'test-token' })

    const body = await new Promise<string>((resolve, reject) => {
      httpGet({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })
    expect(body).toContain('bond')
  })

  it('attaches same-origin WebSocket connections and rejects cross-origin ones', async () => {
    const { port, attach } = await start()

    const ok = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { origin: `http://127.0.0.1:${port}` } })
    await new Promise<void>(resolve => ok.once('open', resolve))
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1))
    ok.close()

    const evil = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { origin: 'http://evil.test' } })
    const code = await new Promise<number>(resolve => evil.once('close', resolve))
    expect(code).toBe(1008)
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('clears status on close', async () => {
    await start()
    await remote!.close()
    remote = null
    expect(getRemoteStatus()).toMatchObject({ running: false, port: null, token: null })
  })

  // Regression: during a daemon restart the outgoing process briefly still
  // holds the port. ws re-emits the EADDRINUSE on the WebSocketServer, which
  // (unhandled) crashed the whole replacement daemon. It must survive,
  // retry, and bind once the port frees up.
  it('survives EADDRINUSE and binds once the port frees up', async () => {
    const { port } = await start()
    const first = remote!

    const webRoot = mkdtempSync(join(tmpdir(), 'bond-remote-test-'))
    roots.push(webRoot)
    writeFileSync(join(webRoot, 'index.html'), '<h1>second</h1>')
    const second = startRemoteServer({
      port,
      token: 'second-token',
      webRoot,
      attach: vi.fn(),
      retryDelayMs: 25,
      maxRetries: 100,
    })
    remote = second

    // Let it collide at least once — the daemon (this process) must survive.
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(getRemoteStatus()).toMatchObject({ running: true, token: 'test-token' })

    await first.close()
    await vi.waitFor(() => {
      expect(getRemoteStatus()).toMatchObject({ running: true, port, token: 'second-token' })
    })
  })
})

describe('handlePairRequest', () => {
  function fakeReq(options: {
    method?: string
    body?: string
    origin?: string
    host?: string
  } = {}): IncomingMessage {
    const { method = 'POST', body = '{}', origin, host = '192.168.1.5:3113' } = options
    const listeners: Record<string, ((arg?: unknown) => void)[]> = {}
    const req = {
      method,
      url: '/api/pair',
      headers: { origin, host },
      destroy: vi.fn(),
      on(event: string, fn: (arg?: unknown) => void) {
        ;(listeners[event] ??= []).push(fn)
        // Deliver the body once 'end' is subscribed — by then 'data' is too.
        // A future reordering makes this time out loudly rather than pass.
        if (event === 'end') {
          queueMicrotask(() => {
            for (const l of listeners.data ?? []) l(Buffer.from(body))
            for (const l of listeners.end ?? []) l()
          })
        }
        return req
      },
    }
    return req as unknown as IncomingMessage
  }

  function fakeRes() {
    const state = { status: 0, headers: {} as Record<string, string>, body: '' }
    const res = {
      writeHead: vi.fn((status: number, headers: Record<string, string>) => {
        state.status = status
        state.headers = headers
        return res
      }),
      end: vi.fn((body?: unknown) => { state.body = String(body ?? '') }),
    }
    return { res: res as unknown as ServerResponse, state }
  }

  const okExchange = () => ({ ok: true as const, deviceToken: 'a'.repeat(64), deviceId: 'device-1' })

  it('returns a device credential for a good code', async () => {
    const exchange = vi.fn(okExchange)
    const { res, state } = fakeRes()
    await handlePairRequest(fakeReq({ body: JSON.stringify({ code: 'ABCD1234' }) }), res, exchange)
    expect(exchange).toHaveBeenCalledWith('ABCD1234')
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toEqual({ deviceToken: 'a'.repeat(64), deviceId: 'device-1' })
  })

  it('never caches the credential response', async () => {
    const { res, state } = fakeRes()
    await handlePairRequest(fakeReq({ body: JSON.stringify({ code: 'ABCD1234' }) }), res, okExchange)
    expect(state.headers['cache-control']).toBe('no-store')
  })

  it('passes through each rejection reason', async () => {
    for (const reason of ['invalid', 'expired', 'used'] as const) {
      const { res, state } = fakeRes()
      await handlePairRequest(fakeReq({ body: JSON.stringify({ code: 'X' }) }), res, () => ({ ok: false, reason }))
      expect(state.status).toBe(400)
      expect(JSON.parse(state.body)).toEqual({ error: reason })
    }
  })

  it('answers 429 when throttled so a client can tell guessing from a bad code', async () => {
    const { res, state } = fakeRes()
    await handlePairRequest(
      fakeReq({ body: JSON.stringify({ code: 'X' }) }),
      res,
      () => ({ ok: false, reason: 'throttled' }),
    )
    expect(state.status).toBe(429)
  })

  it('rejects non-POST methods', async () => {
    const { res, state } = fakeRes()
    await handlePairRequest(fakeReq({ method: 'GET' }), res, okExchange)
    expect(state.status).toBe(405)
  })

  it('rejects a cross-origin POST — a hostile page must not spend codes', async () => {
    const exchange = vi.fn(okExchange)
    const { res, state } = fakeRes()
    await handlePairRequest(fakeReq({ origin: 'http://evil.test' }), res, exchange)
    expect(state.status).toBe(403)
    expect(exchange).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and non-string codes', async () => {
    for (const body of ['not json', JSON.stringify({ code: 42 }), JSON.stringify({})]) {
      const exchange = vi.fn(okExchange)
      const { res, state } = fakeRes()
      await handlePairRequest(fakeReq({ body }), res, exchange)
      expect(state.status).toBe(400)
      expect(exchange).not.toHaveBeenCalled()
    }
  })

  it('rejects an oversized body without reading it all', async () => {
    const exchange = vi.fn(okExchange)
    const { res, state } = fakeRes()
    const req = fakeReq({ body: 'x'.repeat(2048) })
    await handlePairRequest(req, res, exchange)
    expect(state.status).toBe(400)
    expect(exchange).not.toHaveBeenCalled()
    expect(req.destroy).toHaveBeenCalled()
  })

  it('reports unavailable when no exchange is wired', async () => {
    const { res, state } = fakeRes()
    await handlePairRequest(fakeReq({ body: JSON.stringify({ code: 'ABCD1234' }) }), res, undefined)
    expect(state.status).toBe(503)
    expect(JSON.parse(state.body)).toEqual({ error: 'unavailable' })
  })

  it('contains a throwing exchange instead of killing the request', async () => {
    const { res, state } = fakeRes()
    await handlePairRequest(
      fakeReq({ body: JSON.stringify({ code: 'ABCD1234' }) }),
      res,
      () => { throw new Error('db is gone') },
    )
    expect(state.status).toBe(500)
  })
})
