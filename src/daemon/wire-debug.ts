/**
 * Wire-level tool visibility.
 *
 * Logs the tool names contained in every model request the daemon sends —
 * the ground truth when a session and the code disagree about the active
 * tool manifest. One concise line per request; parsing failures are silent
 * because diagnostics must never break a request.
 */

import { gunzipSync, zstdDecompressSync } from 'node:zlib'

const MODEL_HOSTS = ['chatgpt.com', 'api.openai.com', 'api.anthropic.com']

export function isModelRequest(url: string): boolean {
  try {
    const host = new URL(url).host
    return MODEL_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

export function decodeBody(body: unknown): string | null {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) {
    try {
      if (body[0] === 0x28 && body[1] === 0xb5 && body[2] === 0x2f && body[3] === 0xfd) {
        return zstdDecompressSync(body).toString('utf-8')
      }
      if (body[0] === 0x1f && body[1] === 0x8b) {
        return gunzipSync(body).toString('utf-8')
      }
      return new TextDecoder().decode(body)
    } catch {
      return null
    }
  }
  return null
}

/** Tool names in a serialized model-request body, or null when not parseable. */
export function extractToolNames(body: unknown): string[] | null {
  const text = decodeBody(body)
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    const tools = parsed?.tools
    if (!Array.isArray(tools)) return null
    return tools.map((t: any) => t?.name ?? t?.function?.name ?? t?.type ?? '?')
  } catch {
    return null
  }
}

/** Describe a WebSocket frame's tool manifest, or null when it isn't a model request frame. */
export function describeWsFrame(data: unknown): string | null {
  if (typeof data !== 'string' || !data.includes('response.create')) return null
  try {
    const parsed = JSON.parse(data)
    const kind = parsed?.previous_response_id ? 'delta' : 'full'
    if (!Array.isArray(parsed?.tools)) return `ws tools (${kind}): NO tools field`
    const names = parsed.tools.map((t: any) => t?.name ?? t?.function?.name ?? t?.type ?? '?')
    return `ws tools (${kind}): ${JSON.stringify(names)}`
  } catch {
    return null
  }
}

/** Patch WebSocket.send so model request frames log their tool manifest. */
export function installWireWebSocketLogging(): void {
  const RealWS = globalThis.WebSocket as any
  if (!RealWS?.prototype?.send) return
  const realSend = RealWS.prototype.send
  RealWS.prototype.send = function (data: unknown) {
    try {
      const line = describeWsFrame(data)
      if (line) console.log(`[bond-daemon] ${line}`)
    } catch { /* never interfere with the frame */ }
    return realSend.call(this, data)
  }
}

/** Patch global fetch so every model request logs its tool manifest. */
export function installWireToolLogging(): void {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    try {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (isModelRequest(url)) {
        const names = extractToolNames(init?.body)
        if (names) console.log(`[bond-daemon] wire tools → ${new URL(url).host}: ${JSON.stringify(names)}`)
        else console.log(`[bond-daemon] wire tools → ${new URL(url).host}: (body not parseable)`)
      }
    } catch { /* never interfere with the request */ }
    return realFetch(input, init)
  }) as typeof fetch
}
