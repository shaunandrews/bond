import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * Remote access — the LAN web server.
 *
 * A TCP listener (distinct from the unix-socket server) that serves the built
 * browser bundle over HTTP and speaks the same JSON-RPC WebSocket protocol,
 * gated by the persistent pairing token. The static shell is served without
 * auth (it contains no data); the WebSocket auth is the security boundary.
 */

export interface RemoteServerOptions {
  port: number
  token: string
  /** Directory holding the built browser bundle (out/web). */
  webRoot: string
  /** Wires an accepted socket into the daemon's JSON-RPC dispatch. */
  attach: (ws: WebSocket) => void
  /** EADDRINUSE retry pacing — injectable for tests. */
  retryDelayMs?: number
  maxRetries?: number
}

export interface RemoteServer {
  wss: WebSocketServer
  httpServer: HttpServer
  close: () => Promise<void>
}

export interface RemoteStatus {
  running: boolean
  port: number | null
  token: string | null
  urls: string[]
}

let status: RemoteStatus = { running: false, port: null, token: null, urls: [] }

export function getRemoteStatus(): RemoteStatus {
  return { ...status, urls: [...status.urls] }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

/** Map a request URL to a file inside webRoot, or null for anything unsafe. */
export function resolveStaticPath(webRoot: string, rawUrl: string): string | null {
  const pathname = rawUrl.split('?')[0].split('#')[0]
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('..') || decoded.includes('\0')) return null
  const rel = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '')
  const root = normalize(webRoot)
  const full = normalize(join(root, rel))
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) return null
  return full
}

export async function handleStaticRequest(webRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed')
    return
  }
  const filePath = resolveStaticPath(webRoot, req.url ?? '/')
  if (!filePath) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
    return
  }
  try {
    const body = await readFile(filePath)
    const ext = extname(filePath).toLowerCase()
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      // Vite fingerprints everything except the HTML shell.
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
  }
}

/**
 * Browsers on the served page send an Origin matching the Host they loaded
 * from; anything else (a malicious page elsewhere driving a cross-origin
 * WebSocket, DNS rebinding) is rejected. Non-browser clients send no Origin
 * and still have to present the pairing token.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function lanAddresses(): string[] {
  const addresses: string[] = []
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address)
    }
  }
  return addresses
}

export function pairingUrls(port: number, token: string): string[] {
  return lanAddresses().map(address => `http://${address}:${port}/#t=${token}`)
}

export function startRemoteServer(options: RemoteServerOptions): RemoteServer {
  const { port, token, webRoot, attach, retryDelayMs = 500, maxRetries = 20 } = options

  const httpServer: HttpServer = createServer((req, res) => {
    void handleStaticRequest(webRoot, req, res)
  })
  const wss = new WebSocketServer({ server: httpServer })

  let closed = false
  let attempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      console.warn(`[bond-daemon] remote client from ${ip} rejected — origin ${req.headers.origin ?? '(none)'} does not match host`)
      ws.close(1008, 'Origin not allowed')
      return
    }
    console.log(`[bond-daemon] remote client connected from ${ip}`)
    ws.on('close', () => console.log(`[bond-daemon] remote client from ${ip} disconnected`))
    attach(ws)
  })

  // `ws` re-emits the http server's errors on the WebSocketServer; without
  // this listener an EADDRINUSE would be an uncaught 'error' event and kill
  // the whole daemon. The httpServer handler below does the actual handling.
  wss.on('error', () => {})

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    // A taken port must never take the daemon down with it. During a daemon
    // restart the outgoing process can briefly still hold the port, so
    // EADDRINUSE retries until it frees up.
    if (err.code === 'EADDRINUSE' && !closed && attempts < maxRetries) {
      attempts++
      console.warn(`[bond-daemon] remote port ${port} in use — retrying (${attempts}/${maxRetries})`)
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (!closed) httpServer.listen(port, '0.0.0.0')
      }, retryDelayMs)
      return
    }
    console.error(`[bond-daemon] remote server error: ${err.message}`)
    status = { running: false, port: null, token: null, urls: [] }
  })

  httpServer.on('listening', () => {
    const address = httpServer.address()
    const boundPort = typeof address === 'object' && address ? address.port : port
    status = { running: true, port: boundPort, token, urls: pairingUrls(boundPort, token) }
    console.log(`[bond-daemon] remote server listening on 0.0.0.0:${boundPort}`)
  })

  httpServer.listen(port, '0.0.0.0')

  return {
    wss,
    httpServer,
    close: () => new Promise<void>((resolve) => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      status = { running: false, port: null, token: null, urls: [] }
      for (const client of wss.clients) client.terminate()
      // Keep-alive HTTP connections from open browser tabs would otherwise
      // hold close() open forever — and with it the port.
      httpServer.closeAllConnections()
      wss.close(() => {
        httpServer.close(() => resolve())
      })
      // A server that never bound has nothing to close and never fires the
      // close callback in some error paths — don't let shutdown hang on it.
      if (!httpServer.listening) resolve()
    }),
  }
}
