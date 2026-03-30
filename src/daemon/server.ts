import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server as HttpServer } from 'node:http'
import { existsSync, unlinkSync } from 'node:fs'
import type { TaggedChunk } from '../shared/stream'
import type { BondStreamChunk } from '../shared/stream'
import type { SessionMessage } from '../shared/session'
import type { ModelId } from '../shared/models'
import {
  makeResponse,
  makeErrorResponse,
  makeNotification,
  isRequest,
  RPC_METHOD_NOT_FOUND,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  type JsonRpcRequest,
  type JsonRpcMessage
} from '../shared/protocol'
import { MODEL_IDS } from '../shared/models'
import {
  runBondQuery,
  resolvePendingApproval,
  clearSessionApprovals
} from './agent'
import { closeDb } from './db'
import {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  getMessages,
  saveMessages
} from './sessions'
import { generateTitleAndSummary } from './generate-title'
import {
  getSoul,
  saveSoul,
  getModelSetting,
  saveModelSetting,
  getAccentColor,
  saveAccentColor
} from './settings'

// --- State ---

const activeQueries = new Map<string, AbortController>()
let currentModel: string = 'sonnet'
const knownSdkSessions = new Set<string>()

// Track which clients are subscribed to which sessions
const sessionSubscribers = new Map<string, Set<WebSocket>>()

// Track pending approvals per session for replay on reconnect
const pendingApprovalChunks = new Map<string, TaggedChunk[]>()

function subscribeTo(sessionId: string, ws: WebSocket): void {
  let subs = sessionSubscribers.get(sessionId)
  if (!subs) {
    subs = new Set()
    sessionSubscribers.set(sessionId, subs)
  }
  subs.add(ws)
}

function unsubscribeFrom(sessionId: string, ws: WebSocket): void {
  const subs = sessionSubscribers.get(sessionId)
  if (subs) {
    subs.delete(ws)
    if (subs.size === 0) sessionSubscribers.delete(sessionId)
  }
}

function unsubscribeAll(ws: WebSocket): void {
  for (const subs of sessionSubscribers.values()) {
    subs.delete(ws)
  }
}

function broadcastChunk(sessionId: string, chunk: BondStreamChunk): void {
  const tagged: TaggedChunk = { ...chunk, sessionId }
  const msg = JSON.stringify(makeNotification('bond.chunk', tagged))
  const subs = sessionSubscribers.get(sessionId)
  if (!subs) return
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  }

  // Track pending approval chunks for replay
  if (chunk.kind === 'tool_approval') {
    let pending = pendingApprovalChunks.get(sessionId)
    if (!pending) {
      pending = []
      pendingApprovalChunks.set(sessionId, pending)
    }
    pending.push(tagged)
  }
}

function clearPendingApprovalChunk(requestId: string): void {
  for (const [sessionId, chunks] of pendingApprovalChunks) {
    const idx = chunks.findIndex(c => c.kind === 'tool_approval' && c.requestId === requestId)
    if (idx !== -1) {
      chunks.splice(idx, 1)
      if (chunks.length === 0) pendingApprovalChunks.delete(sessionId)
      return
    }
  }
}

// --- RPC handler ---

type RpcParams = Record<string, unknown> | unknown[] | undefined

function getParam(params: RpcParams, key: string): unknown {
  if (Array.isArray(params)) return undefined
  return params?.[key]
}

function getStringParam(params: RpcParams, key: string): string | undefined {
  const v = getParam(params, key)
  return typeof v === 'string' ? v : undefined
}

function getBoolParam(params: RpcParams, key: string): boolean | undefined {
  const v = getParam(params, key)
  return typeof v === 'boolean' ? v : undefined
}

async function handleRequest(req: JsonRpcRequest, ws: WebSocket): Promise<string> {
  const { id, method, params } = req
  const p = params as RpcParams

  try {
    switch (method) {
      // --- Chat ---
      case 'bond.send': {
        const text = getStringParam(p, 'text')?.trim()
        const sessionId = getStringParam(p, 'sessionId')
        if (!text) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'text is required'))
        if (!sessionId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'sessionId is required'))

        // Auto-subscribe this client to the session
        subscribeTo(sessionId, ws)

        // Abort existing query for this session
        const existing = activeQueries.get(sessionId)
        if (existing) {
          existing.abort()
          activeQueries.delete(sessionId)
          clearSessionApprovals(sessionId)
        }

        const ac = new AbortController()
        activeQueries.set(sessionId, ac)
        const resumeSession = knownSdkSessions.has(sessionId)

        try {
          await runBondQuery(text, {
            abortSignal: ac.signal,
            onChunk: (chunk) => broadcastChunk(sessionId, chunk),
            model: currentModel,
            sessionId,
            resumeSession
          })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          broadcastChunk(sessionId, { kind: 'raw_error', message })
          activeQueries.delete(sessionId)
          return JSON.stringify(makeResponse(id, { ok: false, error: message }))
        }

        knownSdkSessions.add(sessionId)
        activeQueries.delete(sessionId)
        return JSON.stringify(makeResponse(id, { ok: true }))
      }

      case 'bond.cancel': {
        const sessionId = getStringParam(p, 'sessionId')
        if (sessionId) {
          const ac = activeQueries.get(sessionId)
          if (ac) {
            ac.abort()
            activeQueries.delete(sessionId)
            clearSessionApprovals(sessionId)
          }
        } else {
          for (const [sid, ac] of activeQueries) {
            ac.abort()
            clearSessionApprovals(sid)
          }
          activeQueries.clear()
        }
        return JSON.stringify(makeResponse(id, { ok: true }))
      }

      case 'bond.approvalResponse': {
        const requestId = getStringParam(p, 'requestId')
        const approved = getBoolParam(p, 'approved')
        if (!requestId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'requestId is required'))
        if (approved === undefined) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'approved is required'))
        resolvePendingApproval(requestId, approved)
        clearPendingApprovalChunk(requestId)
        return JSON.stringify(makeResponse(id, { ok: true }))
      }

      // --- Subscriptions ---
      case 'bond.subscribe': {
        const sessionId = getStringParam(p, 'sessionId')
        if (!sessionId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'sessionId is required'))
        subscribeTo(sessionId, ws)

        // Replay pending approval chunks
        const pending = pendingApprovalChunks.get(sessionId)
        if (pending) {
          for (const chunk of pending) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(makeNotification('bond.chunk', chunk)))
            }
          }
        }

        return JSON.stringify(makeResponse(id, { ok: true }))
      }

      case 'bond.unsubscribe': {
        const sessionId = getStringParam(p, 'sessionId')
        if (!sessionId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'sessionId is required'))
        unsubscribeFrom(sessionId, ws)
        return JSON.stringify(makeResponse(id, { ok: true }))
      }

      // --- Model ---
      case 'bond.setModel': {
        const model = getStringParam(p, 'model')
        if (model && (MODEL_IDS as readonly string[]).includes(model)) {
          currentModel = model
          saveModelSetting(model as ModelId)
        }
        return JSON.stringify(makeResponse(id, { ok: true }))
      }

      case 'bond.getModel':
        return JSON.stringify(makeResponse(id, currentModel))

      // --- Sessions ---
      case 'session.list':
        return JSON.stringify(makeResponse(id, listSessions()))

      case 'session.create':
        return JSON.stringify(makeResponse(id, createSession()))

      case 'session.get': {
        const sid = getStringParam(p, 'id')
        if (!sid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        return JSON.stringify(makeResponse(id, getSession(sid)))
      }

      case 'session.update': {
        const sid = getStringParam(p, 'id')
        const updates = getParam(p, 'updates') as Record<string, unknown> | undefined
        if (!sid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        return JSON.stringify(makeResponse(id, updateSession(sid, updates ?? {})))
      }

      case 'session.delete': {
        const sid = getStringParam(p, 'id')
        if (!sid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        return JSON.stringify(makeResponse(id, deleteSession(sid)))
      }

      case 'session.getMessages': {
        const sid = getStringParam(p, 'sessionId')
        if (!sid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'sessionId is required'))
        return JSON.stringify(makeResponse(id, getMessages(sid)))
      }

      case 'session.saveMessages': {
        const sid = getStringParam(p, 'sessionId')
        const msgs = getParam(p, 'messages') as SessionMessage[] | undefined
        if (!sid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'sessionId is required'))
        if (!msgs) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'messages is required'))
        return JSON.stringify(makeResponse(id, saveMessages(sid, msgs)))
      }

      case 'session.generateTitle': {
        const sid = getStringParam(p, 'sessionId')
        if (!sid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'sessionId is required'))
        const msgs = getMessages(sid)
        const result = await generateTitleAndSummary(msgs)
        updateSession(sid, result)
        return JSON.stringify(makeResponse(id, result))
      }

      // --- Settings ---
      case 'settings.getSoul':
        return JSON.stringify(makeResponse(id, getSoul()))

      case 'settings.saveSoul': {
        const content = getStringParam(p, 'content')
        if (content === undefined) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'content is required'))
        return JSON.stringify(makeResponse(id, saveSoul(content)))
      }

      case 'settings.getAccentColor':
        return JSON.stringify(makeResponse(id, getAccentColor()))

      case 'settings.saveAccentColor': {
        const hex = getStringParam(p, 'hex')
        if (!hex) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'hex is required'))
        return JSON.stringify(makeResponse(id, saveAccentColor(hex)))
      }

      default:
        return JSON.stringify(makeErrorResponse(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`))
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return JSON.stringify(makeErrorResponse(id, RPC_INTERNAL_ERROR, message))
  }
}

// --- Server lifecycle ---

export interface BondServer {
  close: () => Promise<void>
  wss: WebSocketServer
}

export function startServer(socketPath: string): BondServer {
  // Clean up stale socket
  if (existsSync(socketPath)) {
    unlinkSync(socketPath)
  }

  // Load persisted model
  currentModel = getModelSetting()

  const httpServer: HttpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        ws.send(JSON.stringify(makeErrorResponse(0, -32700, 'Parse error')))
        return
      }

      if (isRequest(msg)) {
        const response = await handleRequest(msg, ws)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(response)
        }
      }
      // Notifications from client are fire-and-forget, nothing to handle currently
    })

    ws.on('close', () => {
      unsubscribeAll(ws)
    })
  })

  httpServer.listen(socketPath)

  return {
    wss,
    close: () => new Promise<void>((resolve) => {
      // Abort all active queries
      for (const [sid, ac] of activeQueries) {
        ac.abort()
        clearSessionApprovals(sid)
      }
      activeQueries.clear()
      knownSdkSessions.clear()

      wss.close(() => {
        httpServer.close(() => {
          // Clean up socket file
          closeDb()
          if (existsSync(socketPath)) {
            try { unlinkSync(socketPath) } catch { /* ignore */ }
          }
          resolve()
        })
      })
    })
  }
}
