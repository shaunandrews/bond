import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server as HttpServer } from 'node:http'
import { existsSync, unlinkSync } from 'node:fs'
import type { TaggedChunk } from '../shared/stream'
import type { BondStreamChunk } from '../shared/stream'
import type { SessionMessage, AttachedImage } from '../shared/session'
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
  clearSessionApprovals,
  getCachedSkills,
  refreshSkillsCache
} from './agent'
import { removeSkill } from './skills'
import { getDb, closeDb } from './db'
import {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  deleteArchivedSessions,
  getMessages,
  saveMessages,
  savePendingApproval,
  removePendingApproval,
  clearSessionPendingApprovals,
  getPendingApprovals
} from './sessions'
import { listTodos, createTodo, updateTodo, deleteTodo, reorderTodos } from './todos'
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  addResource,
  removeResource
} from './projects'
import {
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  listItems,
  getItem,
  addItem,
  updateItem,
  deleteItem,
  reorderItems,
  renameField
} from './collections'
import { listEntries, getEntry, createEntry, updateEntry, deleteEntry, searchEntries, addComment, deleteComment } from './journal'
import { createSenseController, type SenseController } from './sense/controller'
import { getStats as getSenseStats, clearData as clearSenseData } from './sense/storage'
import { getSetting, setSetting } from './settings'
import type { SenseSettings } from '../shared/sense'
import { DEFAULT_SENSE_SETTINGS } from '../shared/sense'
import { generateJournalMeta } from './generate-journal-meta'
import { generateBondComment } from './generate-journal-comment'
import { parseTodoInput } from './parse-todo'
import { generateTitleAndSummary } from './generate-title'
import {
  getSoul,
  saveSoul,
  getModelSetting,
  saveModelSetting,
  getAccentColor,
  saveAccentColor,
  getWindowOpacity,
  saveWindowOpacity
} from './settings'
import {
  saveImages,
  getImage,
  getImages,
  listAllImages,
  deleteImage,
  importImage
} from './images'

// --- State ---

const activeQueries = new Map<string, { ac: AbortController; promise: Promise<boolean> }>()
let currentModel: string = 'sonnet'
const knownSdkSessions = new Set<string>()
let serverWss: WebSocketServer | null = null

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

  // Track pending approval chunks for replay (in-memory + SQLite)
  if (chunk.kind === 'tool_approval') {
    let pending = pendingApprovalChunks.get(sessionId)
    if (!pending) {
      pending = []
      pendingApprovalChunks.set(sessionId, pending)
    }
    pending.push(tagged)
    try { savePendingApproval(sessionId, tagged) } catch { /* best effort */ }
  }
}

function broadcastTodoChanged(): void {
  if (!serverWss) return
  const msg = JSON.stringify(makeNotification('todo.changed', {}))
  for (const client of serverWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  }
}

function broadcastProjectsChanged(): void {
  if (!serverWss) return
  const msg = JSON.stringify(makeNotification('project.changed', {}))
  for (const client of serverWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  }
}

function broadcastCollectionsChanged(): void {
  if (!serverWss) return
  const msg = JSON.stringify(makeNotification('collection.changed', {}))
  for (const client of serverWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  }
}

function broadcastJournalChanged(): void {
  if (!serverWss) return
  const msg = JSON.stringify(makeNotification('journal.changed', {}))
  for (const client of serverWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  }
}

// --- Sense ---

let senseController: SenseController | null = null

function getSenseController(): SenseController {
  if (!senseController) {
    // Load persisted settings
    let settings = DEFAULT_SENSE_SETTINGS
    try {
      const raw = getSetting('sense')
      if (raw) settings = { ...DEFAULT_SENSE_SETTINGS, ...JSON.parse(raw) }
    } catch { /* use defaults */ }

    senseController = createSenseController(settings)

    // Broadcast state changes and capture requests to all clients
    senseController.on('stateChanged', (state) => {
      broadcastSenseEvent('sense.stateChanged', { state })
    })
    senseController.on('requestCapture', (payload) => {
      broadcastSenseEvent('sense.requestCapture', payload)
    })

    // Auto-enable if it was enabled before daemon restart
    if (settings.enabled) {
      senseController.enable()
    }
  }
  return senseController
}

function persistSenseSettings(settings: SenseSettings): void {
  setSetting('sense', JSON.stringify(settings))
}

function broadcastSenseEvent(method: string, params: unknown): void {
  if (!serverWss) return
  const msg = JSON.stringify(makeNotification(method, params))
  for (const client of serverWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  }
}

function clearPendingApprovalChunk(requestId: string): void {
  for (const [sessionId, chunks] of pendingApprovalChunks) {
    const idx = chunks.findIndex(c => c.kind === 'tool_approval' && c.requestId === requestId)
    if (idx !== -1) {
      chunks.splice(idx, 1)
      if (chunks.length === 0) pendingApprovalChunks.delete(sessionId)
      break
    }
  }
  try { removePendingApproval(requestId) } catch { /* best effort */ }
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

function getNumberParam(params: RpcParams, key: string): number | undefined {
  const v = getParam(params, key)
  return typeof v === 'number' ? v : undefined
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
        const images = getParam(p, 'images') as AttachedImage[] | undefined
        if (!text && !images?.length) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'text or images required'))
        if (!sessionId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'sessionId is required'))

        const session = getSession(sessionId)
        if (!session) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'session not found'))

        // Auto-subscribe this client to the session
        subscribeTo(sessionId, ws)

        // Abort existing query for this session and wait for it to finish
        const existing = activeQueries.get(sessionId)
        if (existing) {
          existing.ac.abort()
          clearSessionApprovals(sessionId)
          try { await existing.promise } catch { /* already handled */ }
          activeQueries.delete(sessionId)
        }

        // Save images to permanent storage before running the query
        let imageIds: string[] | undefined
        if (images?.length) {
          imageIds = saveImages(sessionId, images)
        }

        const ac = new AbortController()
        let shouldResume = knownSdkSessions.has(sessionId)

        // Retry loop for startup failures only (runBondQuery throws when chunkCount === 0).
        // Mid-stream crashes return false with raw_error already broadcast — no auto-retry.
        const queryPromise = (async () => {
          let succeeded = false

          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              succeeded = await runBondQuery(text ?? '', {
                abortSignal: ac.signal,
                onChunk: (chunk) => broadcastChunk(sessionId, chunk),
                model: currentModel,
                sessionId,
                resumeSession: shouldResume,
                imageIds,
                editMode: session.editMode,
              })
              break // Query ran (success or graceful failure) — stop retrying
            } catch (e) {
              if (ac.signal.aborted) return false

              const errorMsg = e instanceof Error ? e.message : String(e)
              const isAlreadyInUse = errorMsg.includes('already in use')

              if (attempt === 2) {
                // Final attempt — broadcast error to user
                broadcastChunk(sessionId, { kind: 'raw_error', message: errorMsg })
                return false
              }

              if (shouldResume && !isAlreadyInUse) {
                // Resume failed for a non-collision reason — switch to fresh
                console.warn('[bond] resume failed, will retry fresh:', sessionId)
                knownSdkSessions.delete(sessionId)
                shouldResume = false
              } else if (!shouldResume && isAlreadyInUse) {
                // Fresh start rejected — SDK already has this session on disk. Switch to resume.
                console.warn('[bond] session exists in SDK, will retry with resume:', sessionId)
                shouldResume = true
              } else {
                // Other startup failure — retry same strategy after a delay
                console.warn('[bond] startup failure, retrying after delay:', sessionId)
                await new Promise(r => setTimeout(r, 500))
              }
            }
          }

          return succeeded
        })()

        activeQueries.set(sessionId, { ac, promise: queryPromise })
        broadcastChunk(sessionId, { kind: 'query_start' })

        // Fire-and-forget: clean up when the query finishes, don't block the RPC response
        queryPromise.then((succeeded) => {
          if (succeeded) {
            knownSdkSessions.add(sessionId)
          } else {
            knownSdkSessions.delete(sessionId)
          }
          activeQueries.delete(sessionId)
          // Clear pending approvals — they're no longer actionable after query ends
          pendingApprovalChunks.delete(sessionId)
          try { clearSessionPendingApprovals(sessionId) } catch { /* best effort */ }
          broadcastChunk(sessionId, { kind: 'query_end', succeeded })
        })

        return JSON.stringify(makeResponse(id, { ok: true, imageIds }))
      }

      case 'bond.cancel': {
        const sessionId = getStringParam(p, 'sessionId')
        if (sessionId) {
          const entry = activeQueries.get(sessionId)
          if (entry) {
            entry.ac.abort()
            clearSessionApprovals(sessionId)
            pendingApprovalChunks.delete(sessionId)
            try { clearSessionPendingApprovals(sessionId) } catch { /* best effort */ }
            try { await entry.promise } catch { /* already handled */ }
            activeQueries.delete(sessionId)
          }
        } else {
          for (const [sid, entry] of activeQueries) {
            entry.ac.abort()
            clearSessionApprovals(sid)
            pendingApprovalChunks.delete(sid)
            try { clearSessionPendingApprovals(sid) } catch { /* best effort */ }
          }
          await Promise.allSettled([...activeQueries.values()].map(e => e.promise))
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

        // Replay pending approval chunks — prefer in-memory, fall back to SQLite
        let pending = pendingApprovalChunks.get(sessionId)
        if (!pending || pending.length === 0) {
          try {
            const dbApprovals = getPendingApprovals(sessionId)
            if (dbApprovals.length > 0) {
              pending = dbApprovals
              pendingApprovalChunks.set(sessionId, dbApprovals)
            }
          } catch { /* best effort */ }
        }
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

      case 'session.create': {
        const sessionTitle = getStringParam(p, 'title')
        const projectId = getStringParam(p, 'projectId')
        return JSON.stringify(makeResponse(id, createSession({ title: sessionTitle || undefined, projectId: projectId || undefined })))
      }

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

      case 'session.deleteArchived': {
        const count = deleteArchivedSessions()
        return JSON.stringify(makeResponse(id, { ok: true, count }))
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

      case 'settings.getWindowOpacity':
        return JSON.stringify(makeResponse(id, getWindowOpacity()))

      case 'settings.saveWindowOpacity': {
        const opacity = getParam(p, 'opacity')
        if (typeof opacity !== 'number') return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'opacity is required'))
        return JSON.stringify(makeResponse(id, saveWindowOpacity(opacity)))
      }

      // --- Skills ---
      case 'skills.list':
        return JSON.stringify(makeResponse(id, getCachedSkills()))

      case 'skills.refresh':
        return JSON.stringify(makeResponse(id, refreshSkillsCache()))

      case 'skills.remove': {
        const name = getStringParam(p, 'name')
        if (!name) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'name is required'))
        const removed = removeSkill(name)
        if (removed) refreshSkillsCache()
        return JSON.stringify(makeResponse(id, { ok: removed }))
      }

      // --- Images ---
      case 'image.list':
        return JSON.stringify(makeResponse(id, listAllImages()))

      case 'image.get': {
        const imageId = getStringParam(p, 'id')
        if (!imageId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        return JSON.stringify(makeResponse(id, getImage(imageId)))
      }

      case 'image.getMultiple': {
        const ids = getParam(p, 'ids') as string[] | undefined
        if (!ids || !Array.isArray(ids)) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'ids is required'))
        return JSON.stringify(makeResponse(id, getImages(ids)))
      }

      case 'image.import': {
        const data = getStringParam(p, 'data')
        const mediaType = getStringParam(p, 'mediaType')
        if (!data || !mediaType) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'data and mediaType are required'))
        return JSON.stringify(makeResponse(id, importImage(data, mediaType as any)))
      }

      case 'image.delete': {
        const imageId = getStringParam(p, 'id')
        if (!imageId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        return JSON.stringify(makeResponse(id, deleteImage(imageId)))
      }

      // --- Todos ---
      case 'todo.list':
        return JSON.stringify(makeResponse(id, listTodos()))

      case 'todo.create': {
        const text = getStringParam(p, 'text')
        if (!text) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'text is required'))
        const notes = getStringParam(p, 'notes') ?? ''
        const group = getStringParam(p, 'group') ?? ''
        const projectId = getStringParam(p, 'projectId')
        const newTodo = createTodo(text, notes, group, projectId)
        broadcastTodoChanged()
        return JSON.stringify(makeResponse(id, newTodo))
      }

      case 'todo.update': {
        const todoId = getStringParam(p, 'id')
        if (!todoId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const updates = getParam(p, 'updates') as Partial<{ text: string; done: boolean }> | undefined
        const updated = updateTodo(todoId, updates ?? {})
        broadcastTodoChanged()
        return JSON.stringify(makeResponse(id, updated))
      }

      case 'todo.delete': {
        const todoId = getStringParam(p, 'id')
        if (!todoId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const deleted = deleteTodo(todoId)
        broadcastTodoChanged()
        return JSON.stringify(makeResponse(id, deleted))
      }

      case 'todo.parse': {
        const raw = getStringParam(p, 'raw')
        if (!raw) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'raw is required'))
        const parsed = await parseTodoInput(raw)
        return JSON.stringify(makeResponse(id, parsed))
      }

      case 'todo.reorder': {
        const ids = getParam(p, 'ids') as string[] | undefined
        if (!ids || !Array.isArray(ids)) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'ids array is required'))
        reorderTodos(ids)
        broadcastTodoChanged()
        return JSON.stringify(makeResponse(id, true))
      }

      // --- Projects ---
      case 'project.list':
        return JSON.stringify(makeResponse(id, listProjects()))

      case 'project.get': {
        const pid = getStringParam(p, 'id')
        if (!pid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        return JSON.stringify(makeResponse(id, getProject(pid)))
      }

      case 'project.create': {
        const name = getStringParam(p, 'name')
        if (!name) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'name is required'))
        const goal = getStringParam(p, 'goal') ?? ''
        const type = getStringParam(p, 'type') ?? 'generic'
        const deadline = getStringParam(p, 'deadline')
        const project = createProject(name, goal, type as any, deadline)
        broadcastProjectsChanged()
        return JSON.stringify(makeResponse(id, project))
      }

      case 'project.update': {
        const pid = getStringParam(p, 'id')
        if (!pid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const updates = getParam(p, 'updates') as Record<string, unknown> | undefined
        const updated = updateProject(pid, updates ?? {})
        broadcastProjectsChanged()
        return JSON.stringify(makeResponse(id, updated))
      }

      case 'project.delete': {
        const pid = getStringParam(p, 'id')
        if (!pid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const deleted = deleteProject(pid)
        broadcastProjectsChanged()
        return JSON.stringify(makeResponse(id, deleted))
      }

      case 'project.addResource': {
        const pid = getStringParam(p, 'projectId')
        const kind = getStringParam(p, 'kind')
        const value = getStringParam(p, 'value')
        if (!pid || !kind || !value) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'projectId, kind, and value are required'))
        const label = getStringParam(p, 'label')
        const resource = addResource(pid, kind as any, value, label)
        broadcastProjectsChanged()
        return JSON.stringify(makeResponse(id, resource))
      }

      case 'project.removeResource': {
        const rid = getStringParam(p, 'id')
        if (!rid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const removed = removeResource(rid)
        broadcastProjectsChanged()
        return JSON.stringify(makeResponse(id, removed))
      }

      // --- Collections ---
      case 'collection.list':
        return JSON.stringify(makeResponse(id, listCollections()))

      case 'collection.get': {
        const cid = getStringParam(p, 'id')
        if (!cid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        return JSON.stringify(makeResponse(id, getCollection(cid)))
      }

      case 'collection.create': {
        const name = getStringParam(p, 'name')
        if (!name) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'name is required'))
        const schema = getParam(p, 'schema') as unknown[] | undefined
        if (!schema || !Array.isArray(schema)) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'schema is required'))
        const icon = getStringParam(p, 'icon') ?? ''
        const collection = createCollection(name, schema as any, icon)
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, collection))
      }

      case 'collection.update': {
        const cid = getStringParam(p, 'id')
        if (!cid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const updates = getParam(p, 'updates') as Record<string, unknown> | undefined
        const updated = updateCollection(cid, updates ?? {})
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, updated))
      }

      case 'collection.delete': {
        const cid = getStringParam(p, 'id')
        if (!cid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const deleted = deleteCollection(cid)
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, deleted))
      }

      case 'collection.renameField': {
        const cid = getStringParam(p, 'id')
        const oldName = getStringParam(p, 'oldName')
        const newName = getStringParam(p, 'newName')
        if (!cid || !oldName || !newName) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id, oldName, and newName are required'))
        const renamed = renameField(cid, oldName, newName)
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, renamed))
      }

      case 'collection.listItems': {
        const collectionId = getStringParam(p, 'collectionId')
        if (!collectionId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'collectionId is required'))
        return JSON.stringify(makeResponse(id, listItems(collectionId)))
      }

      case 'collection.getItem': {
        const itemId = getStringParam(p, 'id')
        if (!itemId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        return JSON.stringify(makeResponse(id, getItem(itemId)))
      }

      case 'collection.addItem': {
        const collectionId = getStringParam(p, 'collectionId')
        if (!collectionId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'collectionId is required'))
        const data = getParam(p, 'data') as Record<string, unknown> | undefined
        if (!data) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'data is required'))
        const item = addItem(collectionId, data)
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, item))
      }

      case 'collection.updateItem': {
        const itemId = getStringParam(p, 'id')
        if (!itemId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const data = getParam(p, 'data') as Record<string, unknown> | undefined
        if (!data) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'data is required'))
        const updated = updateItem(itemId, data)
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, updated))
      }

      case 'collection.deleteItem': {
        const itemId = getStringParam(p, 'id')
        if (!itemId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const deleted = deleteItem(itemId)
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, deleted))
      }

      case 'collection.reorderItems': {
        const ids = getParam(p, 'ids') as string[] | undefined
        if (!ids || !Array.isArray(ids)) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'ids array is required'))
        reorderItems(ids)
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, true))
      }

      // --- Journal ---
      case 'journal.list': {
        const author = getStringParam(p, 'author')
        const projectId = getStringParam(p, 'projectId')
        const tag = getStringParam(p, 'tag')
        const limit = getParam(p, 'limit') as number | undefined
        const offset = getParam(p, 'offset') as number | undefined
        return JSON.stringify(makeResponse(id, listEntries({ author, projectId, tag, limit, offset })))
      }

      case 'journal.get': {
        const eid = getStringParam(p, 'id')
        if (!eid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        return JSON.stringify(makeResponse(id, getEntry(eid)))
      }

      case 'journal.create': {
        const author = getStringParam(p, 'author') as 'user' | 'bond' | undefined
        const title = getStringParam(p, 'title')
        const body = getStringParam(p, 'body')
        if (!author || !title || !body) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'author, title, and body are required'))
        const tags = getParam(p, 'tags') as string[] | undefined
        const projectId = getStringParam(p, 'projectId')
        const sessionId = getStringParam(p, 'sessionId')
        const entry = createEntry({ author, title, body, tags, projectId, sessionId })
        broadcastJournalChanged()
        return JSON.stringify(makeResponse(id, entry))
      }

      case 'journal.update': {
        const eid = getStringParam(p, 'id')
        if (!eid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const updates = getParam(p, 'updates') as Record<string, unknown> | undefined
        const updated = updateEntry(eid, updates ?? {})
        broadcastJournalChanged()
        return JSON.stringify(makeResponse(id, updated))
      }

      case 'journal.delete': {
        const eid = getStringParam(p, 'id')
        if (!eid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const deleted = deleteEntry(eid)
        broadcastJournalChanged()
        return JSON.stringify(makeResponse(id, deleted))
      }

      case 'journal.search': {
        const query = getStringParam(p, 'query')
        if (!query) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'query is required'))
        return JSON.stringify(makeResponse(id, searchEntries(query)))
      }

      case 'journal.generateMeta': {
        const eid = getStringParam(p, 'id')
        if (!eid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const entry = getEntry(eid)
        if (!entry) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'entry not found'))
        const meta = await generateJournalMeta(entry.body)
        const updated = updateEntry(eid, { title: meta.title, tags: meta.tags })
        broadcastJournalChanged()
        return JSON.stringify(makeResponse(id, updated))
      }

      case 'journal.addComment': {
        const entryId = getStringParam(p, 'entryId')
        const author = getStringParam(p, 'author') as 'user' | 'bond' | undefined
        const body = getStringParam(p, 'body')
        if (!entryId || !author || !body) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'entryId, author, and body are required'))
        const comment = addComment(entryId, author, body)
        broadcastJournalChanged()
        return JSON.stringify(makeResponse(id, comment))
      }

      case 'journal.deleteComment': {
        const cid = getStringParam(p, 'id')
        if (!cid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const deleted = deleteComment(cid)
        broadcastJournalChanged()
        return JSON.stringify(makeResponse(id, deleted))
      }

      case 'journal.generateBondComment': {
        const eid = getStringParam(p, 'entryId')
        if (!eid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'entryId is required'))
        const entry = getEntry(eid)
        if (!entry) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'entry not found'))
        const commentBody = await generateBondComment(entry.body, entry.title)
        const comment = addComment(eid, 'bond', commentBody)
        broadcastJournalChanged()
        return JSON.stringify(makeResponse(id, comment))
      }

      // --- Sense ---
      case 'sense.status': {
        const ctrl = getSenseController()
        const stats = getSenseStats()
        return JSON.stringify(makeResponse(id, {
          enabled: ctrl.getSettings().enabled,
          state: ctrl.getState(),
          ...stats,
        }))
      }
      case 'sense.enable': {
        const ctrl = getSenseController()
        ctrl.enable()
        persistSenseSettings(ctrl.getSettings())
        return JSON.stringify(makeResponse(id, { ok: true }))
      }
      case 'sense.disable': {
        const ctrl = getSenseController()
        ctrl.disable()
        persistSenseSettings(ctrl.getSettings())
        return JSON.stringify(makeResponse(id, { ok: true }))
      }
      case 'sense.pause': {
        const ctrl = getSenseController()
        const minutes = getNumberParam(p, 'minutes') ?? 10
        ctrl.pause(minutes)
        return JSON.stringify(makeResponse(id, { ok: true, resumeAt: new Date(Date.now() + minutes * 60_000).toISOString() }))
      }
      case 'sense.resume': {
        const ctrl = getSenseController()
        ctrl.resume()
        return JSON.stringify(makeResponse(id, { ok: true }))
      }
      case 'sense.captureReady': {
        const ctrl = getSenseController()
        const captureId = getStringParam(p, 'captureId')
        const imagePath = getStringParam(p, 'imagePath')
        if (!captureId || !imagePath) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'captureId and imagePath required'))
        ctrl.onCaptureReady(captureId, imagePath)
        return JSON.stringify(makeResponse(id, { ok: true }))
      }
      case 'sense.permissionChanged': {
        // Main process notifies daemon about permission changes
        return JSON.stringify(makeResponse(id, { ok: true }))
      }
      case 'sense.now': {
        const db = getDb()
        const capture = db.prepare(
          'SELECT * FROM sense_captures ORDER BY captured_at DESC LIMIT 1'
        ).get() as Record<string, unknown> | undefined
        const ctrl = getSenseController()
        return JSON.stringify(makeResponse(id, {
          capture: capture ?? null,
          state: ctrl.getState(),
        }))
      }
      case 'sense.today': {
        const db = getDb()
        const today = new Date().toISOString().split('T')[0]
        const sessions = db.prepare(
          "SELECT * FROM sense_sessions WHERE started_at >= ? ORDER BY started_at ASC"
        ).all(today + 'T00:00:00Z')
        const apps = db.prepare(`
          SELECT app_name, COUNT(*) as capture_count,
            MIN(captured_at) as first_seen, MAX(captured_at) as last_seen
          FROM sense_captures
          WHERE captured_at >= ? AND app_name IS NOT NULL
          GROUP BY app_name
          ORDER BY capture_count DESC
        `).all(today + 'T00:00:00Z')
        return JSON.stringify(makeResponse(id, { sessions, apps }))
      }
      case 'sense.search': {
        const query = getStringParam(p, 'query')
        if (!query) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'query required'))
        const limit = getNumberParam(p, 'limit') ?? 20
        const db = getDb()
        // LIKE-based search (FTS5 may be unavailable or out of sync)
        const results = db.prepare(`
          SELECT * FROM sense_captures
          WHERE text_content LIKE ? OR app_name LIKE ? OR window_title LIKE ?
          ORDER BY captured_at DESC
          LIMIT ?
        `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit)
        return JSON.stringify(makeResponse(id, results))
      }
      case 'sense.apps': {
        const range = getStringParam(p, 'range') ?? 'today'
        const db = getDb()
        let since: string
        const now = new Date()
        if (range === 'week') {
          const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
          since = weekAgo.toISOString()
        } else {
          since = now.toISOString().split('T')[0] + 'T00:00:00Z'
        }
        const apps = db.prepare(`
          SELECT app_name, app_bundle_id, COUNT(*) as capture_count,
            MIN(captured_at) as first_seen, MAX(captured_at) as last_seen
          FROM sense_captures
          WHERE captured_at >= ? AND app_name IS NOT NULL
          GROUP BY app_bundle_id
          ORDER BY capture_count DESC
        `).all(since)
        return JSON.stringify(makeResponse(id, apps))
      }
      case 'sense.timeline': {
        const from = getStringParam(p, 'from')
        const to = getStringParam(p, 'to')
        const limit = getNumberParam(p, 'limit') ?? 50
        const db = getDb()
        let sql = 'SELECT * FROM sense_captures WHERE 1=1'
        const params: (string | number)[] = []
        if (from) { sql += ' AND captured_at >= ?'; params.push(from) }
        if (to) { sql += ' AND captured_at <= ?'; params.push(to) }
        sql += ' ORDER BY captured_at DESC LIMIT ?'
        params.push(limit)
        const results = db.prepare(sql).all(...params)
        return JSON.stringify(makeResponse(id, results))
      }
      case 'sense.settings': {
        const ctrl = getSenseController()
        return JSON.stringify(makeResponse(id, ctrl.getSettings()))
      }
      case 'sense.updateSettings': {
        const updates = getParam(p, 'updates') as Partial<SenseSettings> | undefined
        if (!updates) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'updates required'))
        const ctrl = getSenseController()
        const newSettings = ctrl.updateSettings(updates)
        persistSenseSettings(newSettings)
        return JSON.stringify(makeResponse(id, newSettings))
      }
      case 'sense.clear': {
        const range = getParam(p, 'range') as { from?: string; to?: string } | undefined
        const deleted = clearSenseData(range)
        return JSON.stringify(makeResponse(id, { deletedCount: deleted }))
      }
      case 'sense.stats': {
        const stats = getSenseStats()
        return JSON.stringify(makeResponse(id, stats))
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

  // Eagerly initialize Sense controller so it auto-enables on daemon startup
  getSenseController()

  const httpServer: HttpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer })
  serverWss = wss

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
      for (const [sid, entry] of activeQueries) {
        entry.ac.abort()
        clearSessionApprovals(sid)
      }
      activeQueries.clear()
      knownSdkSessions.clear()

      // Clean up sense controller
      if (senseController) {
        senseController.destroy()
        senseController = null
      }

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
