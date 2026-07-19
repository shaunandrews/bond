import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { socketIdentity, socketLost, type DaemonHealth } from './lifecycle'
import type { BondSendInput, TaggedChunk } from '../shared/stream'
import type { BondStreamChunk } from '../shared/stream'
import type { SessionMessage, AttachedImage, EditMode } from '../shared/session'
import { parseEditMode } from '../shared/session'
import type { TranscriptMessage } from '../shared/transcript'
import { listMessages as listTranscriptMessages, upsertMessages as upsertTranscriptMessages, searchMessages as searchTranscriptMessages, insertTurnStart, startTurn, completeTurn, getSourceMessages, getMaxMessageSeq } from './transcript'
import { ensureActiveEpoch } from './epochs'
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
  refreshSkillsCache,
  buildSystemPromptPreview,
  buildAgentContextEnvelope,
} from './agent'
import { getPiAuthStatus, startPiOAuth } from './pi/runtime'
import { setRenderTransport, onRenderReady } from './web/broker'
import { getRemoteStatus } from './remote'
import type { WebRenderResult } from '../shared/web'
import { getDownloadsDir, ensureDownloadsDir } from './paths'
import { removeSkill } from './skills'
import { getDb, closeDb } from './db'
import {
  GLOBAL_TRANSCRIPT_SESSION_ID,
  ensureGlobalTranscriptSession,
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
import {
  listCollections,
  getCollection,
  getCollectionByName,
  createCollection,
  updateCollection,
  deleteCollection,
  listItems,
  getItem,
  addItem,
  updateItem,
  deleteItem,
  reorderItems,
  renameField,
  addItemComment,
  deleteItemComment,
  listItemComments,
  searchItems
} from './collections'
import { createSenseController, type SenseController } from './sense/controller'
import { getStats as getSenseStats, clearData as clearSenseData } from './sense/storage'
import { getSetting, setSetting } from './settings'
import type { SenseSettings } from '../shared/sense'
import type { CoreMemory, MemoryItemInput, WorkingState } from '../shared/memory'
import { DEFAULT_SENSE_SETTINGS } from '../shared/sense'
import { generateTitleAndSummary } from './generate-title'
import { generateDebrief } from './generate-debrief'
import {
  getDebrief,
  getDebriefBySession,
  listDebriefs,
  searchDebriefs,
  deleteDebrief,
} from './debriefs'
import { backfillDebriefs } from './generate-debrief'
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
import { readCoreMemory, withCoreMemoryLock, writeCoreMemoryAtomic } from './memory/core-memory'
import { getMemoryItem, getMemoryItemSourceIds, listRecentMemory, searchMemory, upsertMemoryItem } from './memory/store'
import { createWorkingState } from './memory/working-state'
import { finalObserverHook, memoryFlushHook, scheduleEpochObservation, waitForMemoryQueue } from './memory/service'
import { beginFirstRun, getFirstRunStatus, skipFirstRun } from './onboarding'
import { enterSandbox, exitSandbox, isSandboxed } from './sandbox'

// --- State ---

type ActiveQuery = {
  sessionId: string
  turnId: string
  epochId: string
  ac: AbortController
  promise: Promise<boolean>
}

let activeQuery: ActiveQuery | null = null
let currentModel: string = 'balanced'
let serverWss: WebSocketServer | null = null

/**
 * Quiesce everything that writes through getDb() before swapping the data
 * directory (sandbox enter/exit): abort any streaming query, drain the
 * background memory queue, and suspend Sense capture. Sense wakes on the
 * post-swap side so a simulation never records into (or out of) the wrong
 * data set.
 */
async function settleForDataSwap(): Promise<void> {
  if (activeQuery) {
    const existing = activeQuery
    existing.ac.abort()
    if (existing.sessionId) {
      clearSessionApprovals(existing.sessionId)
      pendingApprovalChunks.delete(existing.sessionId)
      try { clearSessionPendingApprovals(existing.sessionId) } catch { /* best effort */ }
    }
    try { await existing.promise } catch { /* already handled */ }
    if (activeQuery?.turnId === existing.turnId) activeQuery = null
  }
  try { await waitForMemoryQueue() } catch { /* observer failures never block the swap */ }
  senseController?.suspend()
}

function wakeAfterDataSwap(): void {
  senseController?.wake()
}

// Track which clients are subscribed to which sessions; global subscribers receive all tagged chunks.
const sessionSubscribers = new Map<string, Set<WebSocket>>()
const globalSubscribers = new Set<WebSocket>()

// Authenticated connections across all listeners (unix socket + remote TCP)
const authenticatedClients = new WeakSet<WebSocket>()

// Additional WebSocket servers (the remote LAN listener) whose clients should
// receive entity-change notifications alongside the unix-socket clients.
const extraBroadcastServers = new Set<WebSocketServer>()

export function registerBroadcastServer(wss: WebSocketServer): () => void {
  extraBroadcastServers.add(wss)
  return () => extraBroadcastServers.delete(wss)
}

function eachOpenClient(fn: (ws: WebSocket) => void): void {
  if (serverWss) {
    for (const client of serverWss.clients) {
      if (client.readyState === WebSocket.OPEN) fn(client)
    }
  }
  for (const wss of extraBroadcastServers) {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) fn(client)
    }
  }
}

// Track pending approvals per session for replay on reconnect
const pendingApprovalChunks = new Map<string, TaggedChunk[]>()

function subscribeTo(sessionId: string | undefined, ws: WebSocket): void {
  if (!sessionId) {
    globalSubscribers.add(ws)
    return
  }
  let subs = sessionSubscribers.get(sessionId)
  if (!subs) {
    subs = new Set()
    sessionSubscribers.set(sessionId, subs)
  }
  subs.add(ws)
}

function unsubscribeFrom(sessionId: string | undefined, ws: WebSocket): void {
  if (!sessionId) {
    globalSubscribers.delete(ws)
    return
  }
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
  globalSubscribers.delete(ws)
}

function broadcastChunk(sessionId: string | undefined, chunk: BondStreamChunk, tags?: { epochId?: string; turnId?: string; assistantMessageId?: string }): void {
  const tagged: TaggedChunk = { ...chunk, ...(sessionId ? { sessionId } : {}), ...tags }
  const msg = JSON.stringify(makeNotification('bond.chunk', tagged))
  const recipients = new Set<WebSocket>(globalSubscribers)
  const subs = sessionId ? sessionSubscribers.get(sessionId) : undefined
  if (subs) {
    for (const ws of subs) recipients.add(ws)
  }
  for (const ws of recipients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  }

  // Track pending approval chunks for replay (in-memory + SQLite)
  if (chunk.kind === 'tool_approval' && sessionId) {
    let pending = pendingApprovalChunks.get(sessionId)
    if (!pending) {
      pending = []
      pendingApprovalChunks.set(sessionId, pending)
    }
    pending.push(tagged)
    try { savePendingApproval(sessionId, tagged) } catch { /* best effort */ }
  }
}

function broadcastImageChanged(): void {
  const msg = JSON.stringify(makeNotification('image.changed', {}))
  eachOpenClient(client => client.send(msg))
}

function broadcastCollectionsChanged(): void {
  const msg = JSON.stringify(makeNotification('collection.changed', {}))
  eachOpenClient(client => client.send(msg))
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
  const msg = JSON.stringify(makeNotification(method, params))
  eachOpenClient(client => client.send(msg))
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

function guessExt(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg',
    'application/pdf': '.pdf', 'text/html': '.html',
    'application/json': '.json', 'text/plain': '.txt',
  }
  return map[contentType] || ''
}

const WORKING_MEMORY_SETTING = 'memory.working'

function readWorkingMemory(): WorkingState {
  const raw = getSetting(WORKING_MEMORY_SETTING)
  if (!raw) return createWorkingState()
  try {
    return createWorkingState(JSON.parse(raw) as Partial<WorkingState>)
  } catch {
    return createWorkingState()
  }
}

function writeWorkingMemory(working: WorkingState): WorkingState {
  const next = createWorkingState({ ...working, updatedAt: new Date().toISOString() })
  setSetting(WORKING_MEMORY_SETTING, JSON.stringify(next))
  return next
}

function sourceIdsForMemoryTags(tags: string[]): string[] {
  return tags
    .filter(tag => tag.startsWith('source:'))
    .map(tag => tag.slice('source:'.length).trim())
    .filter(Boolean)
}

async function handleRequest(req: JsonRpcRequest, ws: WebSocket): Promise<string> {
  const { id, method, params } = req
  const p = params as RpcParams

  try {
    switch (method) {
      // --- Chat ---
      case 'bond.send': {
        const input = p as Partial<BondSendInput> & { sessionId?: string }
        const text = typeof input.text === 'string' ? input.text.trim() : ''
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined
        const images = Array.isArray(input.images) ? input.images as AttachedImage[] : undefined
        if (!text && !images?.length) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'text or images required'))

        const session = sessionId ? getSession(sessionId) : null
        if (sessionId && !session) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'session not found'))

        subscribeTo(sessionId, ws)

        if (activeQuery) {
          const existing = activeQuery
          existing.ac.abort()
          if (existing.sessionId) {
            clearSessionApprovals(existing.sessionId)
            pendingApprovalChunks.delete(existing.sessionId)
            try { clearSessionPendingApprovals(existing.sessionId) } catch { /* best effort */ }
          }
          try { await existing.promise } catch { /* already handled */ }
          if (activeQuery?.turnId === existing.turnId) activeQuery = null
        }

        let imageIds: string[] | undefined
        if (images?.length) {
          if (!sessionId) ensureGlobalTranscriptSession()
          imageIds = saveImages(sessionId ?? GLOBAL_TRANSCRIPT_SESSION_ID, images)
          // Chat attachments land in the media library too — without this the
          // Media panel sits on "No images uploaded yet" until an app restart.
          broadcastImageChanged()
        }

        const cleanText = text.replace(/@\[([^\]]+)\]\(project:[a-f0-9-]+\)/g, '@$1')
        const epochResult = await ensureActiveEpoch({
          finalObserver: finalObserverHook,
          memoryFlush: memoryFlushHook,
          logger: console,
        })
        const epoch = epochResult.epoch
        const turnId = typeof input.turnId === 'string' ? input.turnId : randomUUID()
        const userMessageId = typeof input.userMessageId === 'string' ? input.userMessageId : randomUUID()
        const assistantMessageId = typeof input.assistantMessageId === 'string' ? input.assistantMessageId : randomUUID()
        const activityMessageId = typeof input.activityMessageId === 'string' ? input.activityMessageId : randomUUID()
        const tags = { epochId: epoch.id, turnId, assistantMessageId }

        insertTurnStart({
          epochId: epoch.id,
          turnId,
          userMessageId,
          assistantMessageId,
          activityMessageId,
          text: cleanText,
          model: currentModel,
          imageIds,
          activityData: { turnId, userMessageId, assistantMessageId, status: 'working', startedAt: Date.now(), events: [] },
        })
        startTurn(turnId, epoch.id)

        // Tell every other live viewer about this turn's user message and
        // message ids. Without this, a second client (desktop vs. phone)
        // streams the response but never shows the user bubble, and mints a
        // duplicate activity row under its own id. The sender dedupes by id.
        broadcastChunk(sessionId, {
          kind: 'turn_start',
          turnId,
          userMessageId,
          assistantMessageId,
          activityMessageId,
          text: cleanText,
          imageIds,
        }, tags)

        const contextEnvelope = buildAgentContextEnvelope({
          query: cleanText,
          sessionId: sessionId ?? epoch.piSessionId,
          excludeMessageIds: [userMessageId, assistantMessageId, activityMessageId],
          previousEpoch: epochResult.previousEpoch,
        })

        const ac = new AbortController()
        let assistantText = ''
        const queryPromise = runBondQuery(cleanText, {
          abortSignal: ac.signal,
          onChunk: (chunk) => {
            if (chunk.kind === 'assistant_text') assistantText += chunk.text
            // Generated images land in the media library too, like attachments.
            if (chunk.kind === 'generated_image') broadcastImageChanged()
            broadcastChunk(sessionId, chunk.kind === 'assistant_text' ? { ...chunk, assistantMessageId } : chunk, tags)
          },
          model: currentModel,
          sessionId: sessionId ?? epoch.piSessionId,
          piSessionId: epoch.piSessionId,
          imageIds,
          editMode: input.editMode ?? session?.editMode ?? parseEditMode(getSetting('edit_mode')),
          contextEnvelope,
          memorySourceMessageId: userMessageId,
          onboardingHooks: {
            // Lets the tour's enable_sense tool flip Sense on after explicit
            // user consent — same path as the Settings toggle.
            enableSense: () => {
              const ctrl = getSenseController()
              ctrl.enable()
              persistSenseSettings(ctrl.getSettings())
              return { enabled: ctrl.getSettings().enabled, state: ctrl.getState() }
            },
          },
        }).then((result) => {
          const succeeded = result.succeeded
          if (assistantText.trim()) {
            upsertTranscriptMessages([{ id: assistantMessageId, epochId: epoch.id, turnId, role: 'bond', text: assistantText }])
          }
          completeTurn({
            turnId,
            status: ac.signal.aborted ? 'cancelled' : succeeded ? 'done' : 'failed',
            contextTokens: result.contextTokens,
            contextWindow: result.contextWindow,
          })
          if (succeeded && !ac.signal.aborted) {
            scheduleEpochObservation({
              epochId: epoch.id,
              toSeq: getMaxMessageSeq(),
              sessionId: sessionId ?? epoch.piSessionId,
              userText: cleanText,
              logger: console,
            })
          }
          return succeeded
        }).catch((error) => {
          completeTurn({ turnId, status: ac.signal.aborted ? 'cancelled' : 'failed' })
          broadcastChunk(sessionId, { kind: 'raw_error', message: error instanceof Error ? error.message : String(error) }, tags)
          return false
        })

        activeQuery = { sessionId: sessionId ?? '', turnId, epochId: epoch.id, ac, promise: queryPromise }
        broadcastChunk(sessionId, { kind: 'query_start' }, tags)

        queryPromise.then((succeeded) => {
          if (activeQuery?.turnId === turnId) activeQuery = null
          if (sessionId) {
            pendingApprovalChunks.delete(sessionId)
            try { clearSessionPendingApprovals(sessionId) } catch { /* best effort */ }
          }
          broadcastChunk(sessionId, { kind: 'query_end', succeeded }, tags)
        })

        return JSON.stringify(makeResponse(id, { ok: true, queued: false, imageIds, turnId, epochId: epoch.id }))
      }

      case 'bond.cancel': {
        const sessionId = getStringParam(p, 'sessionId')
        const entry = activeQuery
        if (entry && (!sessionId || entry.sessionId === sessionId)) {
          entry.ac.abort()
          if (entry.sessionId) {
            clearSessionApprovals(entry.sessionId)
            pendingApprovalChunks.delete(entry.sessionId)
            try { clearSessionPendingApprovals(entry.sessionId) } catch { /* best effort */ }
          }
          try { await entry.promise } catch { /* already handled */ }
          if (activeQuery?.turnId === entry.turnId) activeQuery = null
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
        // Let every other live viewer flip its pending approval prompt —
        // otherwise a second client shows a stale prompt until query_end.
        broadcastChunk(undefined, { kind: 'approval_resolved', requestId, approved })
        return JSON.stringify(makeResponse(id, { ok: true }))
      }

      // --- Remote access (LAN web server) ---
      case 'remote.status': {
        return JSON.stringify(makeResponse(id, getRemoteStatus()))
      }

      // Liveness probe — phone browsers use it to detect zombie sockets
      // (iOS kills WebSockets on lock without firing close events).
      case 'bond.ping':
        return JSON.stringify(makeResponse(id, { ok: true }))

      // --- Subscriptions ---
      case 'bond.subscribe': {
        const sessionId = getStringParam(p, 'sessionId')
        subscribeTo(sessionId, ws)

        // Replay pending approval chunks — prefer in-memory, fall back to SQLite
        let pending = sessionId ? pendingApprovalChunks.get(sessionId) : undefined
        if (sessionId && (!pending || pending.length === 0)) {
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

      // --- Continuous transcript ---
      case 'transcript.list': {
        const before = getParam(p, 'beforeSeq')
        const limitValue = getParam(p, 'limit')
        const beforeSeq = typeof before === 'number' ? before : undefined
        const limit = typeof limitValue === 'number' ? limitValue : undefined
        return JSON.stringify(makeResponse(id, listTranscriptMessages({ beforeSeq, limit })))
      }

      case 'transcript.upsert': {
        const messages = getParam(p, 'messages')
        if (!Array.isArray(messages)) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'messages must be an array'))
        upsertTranscriptMessages(messages as TranscriptMessage[])
        return JSON.stringify(makeResponse(id, { ok: true }))
      }

      case 'transcript.search': {
        const query = getStringParam(p, 'query')
        if (!query) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'query is required'))
        const limitValue = getParam(p, 'limit')
        return JSON.stringify(makeResponse(id, { messages: searchTranscriptMessages(query, { limit: typeof limitValue === 'number' ? limitValue : undefined }) }))
      }

      // --- Sessions ---
      case 'session.list':
        return JSON.stringify(makeResponse(id, listSessions()))

      case 'session.create': {
        const sessionTitle = getStringParam(p, 'title')
        return JSON.stringify(makeResponse(id, createSession({ title: sessionTitle || undefined })))
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
        const result = updateSession(sid, updates ?? {})

        // Trigger debrief on archive (regenerates if one already exists from a prior archive)
        if (updates?.archived === true) {
          generateDebrief(sid).catch((err) => {
            console.warn('[bond] debrief generation failed:', err.message)
          })
        }

        return JSON.stringify(makeResponse(id, result))
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

      // --- Pi setup ---
      case 'pi.status':
        return JSON.stringify(makeResponse(id, await getPiAuthStatus()))
      case 'pi.startOAuth': {
        const provider = getStringParam(p, 'provider')
        if (provider !== 'anthropic' && provider !== 'openai-codex') {
          return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'A supported OAuth provider is required'))
        }
        return JSON.stringify(makeResponse(id, await startPiOAuth(provider)))
      }

      // --- Settings ---
      case 'settings.getEditMode':
        return JSON.stringify(makeResponse(id, parseEditMode(getSetting('edit_mode'))))

      case 'settings.setEditMode': {
        const raw = getParam(p, 'editMode')
        if (!raw || typeof raw !== 'object' || !('type' in (raw as object))) {
          return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'editMode is required'))
        }
        const editMode = parseEditMode(raw)
        setSetting('edit_mode', JSON.stringify(editMode))
        // One global mode: every live client (desktop, phone, quick chat)
        // mirrors the change immediately instead of drifting until reload.
        broadcastChunk(undefined, { kind: 'edit_mode_changed', editMode })
        return JSON.stringify(makeResponse(id, { ok: true }))
      }

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
        const image = importImage(data, mediaType as any)
        broadcastImageChanged()
        return JSON.stringify(makeResponse(id, image))
      }

      case 'image.delete': {
        const imageId = getStringParam(p, 'id')
        if (!imageId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const deleted = deleteImage(imageId)
        if (deleted) broadcastImageChanged()
        return JSON.stringify(makeResponse(id, deleted))
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

      // --- Collection item comments ---

      case 'collection.addItemComment': {
        const itemId = getStringParam(p, 'itemId')
        const author = getStringParam(p, 'author') as 'user' | 'bond' | undefined
        const body = getStringParam(p, 'body')
        if (!itemId || !author || !body) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'itemId, author, and body are required'))
        const comment = addItemComment(itemId, author, body)
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, comment))
      }

      case 'collection.deleteItemComment': {
        const cid = getStringParam(p, 'id')
        if (!cid) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const deleted = deleteItemComment(cid)
        broadcastCollectionsChanged()
        return JSON.stringify(makeResponse(id, deleted))
      }

      case 'collection.listItemComments': {
        const itemId = getStringParam(p, 'itemId')
        if (!itemId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'itemId is required'))
        return JSON.stringify(makeResponse(id, listItemComments(itemId)))
      }

      case 'collection.searchItems': {
        const collectionId = getStringParam(p, 'collectionId')
        const query = getStringParam(p, 'query')
        if (!collectionId || !query) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'collectionId and query are required'))
        return JSON.stringify(makeResponse(id, searchItems(collectionId, query)))
      }

      case 'collection.getByName': {
        const name = getStringParam(p, 'name')
        if (!name) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'name is required'))
        return JSON.stringify(makeResponse(id, getCollectionByName(name)))
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

      // --- Web (hidden-browser render round-trip) ---
      case 'web.renderReady': {
        const renderId = getStringParam(p, 'renderId')
        if (!renderId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'renderId is required'))
        const handled = onRenderReady(p as unknown as WebRenderResult)
        return JSON.stringify(makeResponse(id, { ok: handled }))
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
        const now = new Date()
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString()
        const sessions = db.prepare(
          "SELECT * FROM sense_sessions WHERE started_at >= ? ORDER BY started_at ASC"
        ).all(todayStart)
        const apps = db.prepare(`
          SELECT app_name, COUNT(*) as capture_count,
            MIN(captured_at) as first_seen, MAX(captured_at) as last_seen
          FROM sense_captures
          WHERE captured_at >= ? AND app_name IS NOT NULL
          GROUP BY app_name
          ORDER BY capture_count DESC
        `).all(todayStart)
        return JSON.stringify(makeResponse(id, { sessions, apps }))
      }
      case 'sense.search': {
        const searchQuery = getStringParam(p, 'query')
        if (!searchQuery) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'query required'))
        const limit = getNumberParam(p, 'limit') ?? 20
        const db = getDb()

        // Cross-channel search: screen captures + session debriefs
        const captures = db.prepare(`
          SELECT *, 'see' as channel FROM sense_captures
          WHERE text_content LIKE ? OR app_name LIKE ? OR window_title LIKE ?
          ORDER BY captured_at DESC
          LIMIT ?
        `).all(`%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`, limit) as Record<string, unknown>[]

        const debriefResults = searchDebriefs(searchQuery, limit).map(d => ({
          ...d,
          channel: 'chat' as const,
        }))

        // Unified results sorted by date
        const unified = [
          ...captures.map(c => ({ ...c, _sortDate: c.captured_at as string })),
          ...debriefResults.map(d => ({ ...d, _sortDate: d.createdAt })),
        ].sort((a, b) => b._sortDate.localeCompare(a._sortDate)).slice(0, limit)

        return JSON.stringify(makeResponse(id, unified))
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
          since = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString()
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
        const limit = getNumberParam(p, 'limit') ?? 5000
        const db = getDb()
        let sql = 'SELECT * FROM sense_captures WHERE 1=1'
        const params: (string | number)[] = []
        if (from) { sql += ' AND captured_at >= ?'; params.push(from) }
        if (to) { sql += ' AND captured_at <= ?'; params.push(to) }
        sql += ' ORDER BY captured_at ASC LIMIT ?'
        params.push(limit)
        const results = db.prepare(sql).all(...params)
        return JSON.stringify(makeResponse(id, results))
      }
      case 'sense.capture': {
        const captureId = getStringParam(p, 'id')
        if (!captureId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id required'))
        const db = getDb()
        const capture = db.prepare('SELECT * FROM sense_captures WHERE id = ?').get(captureId) as Record<string, unknown> | undefined
        if (!capture) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'capture not found'))
        let image: string | null = null
        const imgPath = capture.image_path as string | null
        if (imgPath && existsSync(imgPath)) {
          try {
            image = readFileSync(imgPath).toString('base64')
          } catch { /* image unreadable */ }
        }
        return JSON.stringify(makeResponse(id, { capture, image }))
      }
      case 'sense.sessions': {
        const from = getStringParam(p, 'from')
        const to = getStringParam(p, 'to')
        const db = getDb()
        let sql = 'SELECT * FROM sense_sessions WHERE 1=1'
        const params: string[] = []
        if (from) { sql += ' AND (ended_at >= ? OR ended_at IS NULL)'; params.push(from) }
        if (to) { sql += ' AND started_at <= ?'; params.push(to) }
        sql += ' ORDER BY started_at ASC'
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

      // --- Onboarding ---
      case 'onboarding.status':
        return JSON.stringify(makeResponse(id, getFirstRunStatus()))
      case 'onboarding.begin':
        return JSON.stringify(makeResponse(id, beginFirstRun()))
      case 'onboarding.skip':
        return JSON.stringify(makeResponse(id, skipFirstRun()))

      // --- New-user sandbox ---
      case 'sandbox.status':
        return JSON.stringify(makeResponse(id, { sandboxed: isSandboxed() }))
      case 'sandbox.enter': {
        // Sense stays suspended while sandboxed — a fresh install has no Sense.
        await settleForDataSwap()
        try {
          enterSandbox()
        } catch (error) {
          wakeAfterDataSwap()
          throw error
        }
        return JSON.stringify(makeResponse(id, { sandboxed: true }))
      }
      case 'sandbox.exit': {
        await settleForDataSwap()
        exitSandbox()
        wakeAfterDataSwap()
        return JSON.stringify(makeResponse(id, { sandboxed: false }))
      }

      // --- Memory ---
      case 'memory.core': {
        return JSON.stringify(makeResponse(id, readCoreMemory() as CoreMemory))
      }
      case 'memory.updateCore': {
        const core = getParam(p, 'core') as CoreMemory | undefined
        if (!core) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'core is required'))
        const saved = await withCoreMemoryLock(() => writeCoreMemoryAtomic({ ...core, updatedAt: new Date().toISOString() }))
        return JSON.stringify(makeResponse(id, saved))
      }
      case 'memory.working': {
        return JSON.stringify(makeResponse(id, readWorkingMemory()))
      }
      case 'memory.updateWorking': {
        const working = getParam(p, 'working') as WorkingState | undefined
        if (!working) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'working is required'))
        return JSON.stringify(makeResponse(id, writeWorkingMemory(working)))
      }
      case 'memory.clearWorking': {
        const empty = writeWorkingMemory(createWorkingState())
        return JSON.stringify(makeResponse(id, empty))
      }
      case 'memory.search': {
        const query = getStringParam(p, 'query') ?? ''
        const limit = getNumberParam(p, 'limit') ?? 20
        const results = query.trim()
          ? searchMemory(query, { limit })
          : listRecentMemory({ limit }).map(item => ({ item, score: 0 }))
        return JSON.stringify(makeResponse(id, { results }))
      }
      case 'memory.upsert': {
        const item = getParam(p, 'item') as MemoryItemInput | undefined
        if (!item || typeof item.text !== 'string') return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'item.text is required'))
        return JSON.stringify(makeResponse(id, upsertMemoryItem(item)))
      }
      case 'memory.delete': {
        const memoryId = getStringParam(p, 'id')
        if (!memoryId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const current = getMemoryItem(memoryId)
        if (!current) return JSON.stringify(makeResponse(id, { ok: false }))
        upsertMemoryItem({ ...current, active: false, updatedAt: new Date().toISOString() })
        return JSON.stringify(makeResponse(id, { ok: true }))
      }
      case 'memory.sources': {
        const memoryId = getStringParam(p, 'id')
        if (!memoryId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const item = getMemoryItem(memoryId)
        const relatedSourceIds = item ? getMemoryItemSourceIds(item.id) : []
        const sourceIds = relatedSourceIds.length > 0 ? relatedSourceIds : (item ? sourceIdsForMemoryTags(item.tags) : [])
        return JSON.stringify(makeResponse(id, { sourceIds, messages: getSourceMessages(sourceIds) }))
      }

      // --- Sense Debriefs ---
      case 'sense.memory': {
        const limit = getNumberParam(p, 'limit') ?? 20
        const debriefs = listDebriefs({ limit })
        return JSON.stringify(makeResponse(id, { debriefs }))
      }
      case 'sense.debrief': {
        const debriefId = getStringParam(p, 'id')
        const sessionId = getStringParam(p, 'sessionId')
        let debrief = null
        if (debriefId) debrief = getDebrief(debriefId)
        else if (sessionId) debrief = getDebriefBySession(sessionId)
        return JSON.stringify(makeResponse(id, debrief))
      }
      case 'sense.deleteDebrief': {
        const debriefId = getStringParam(p, 'id')
        if (!debriefId) return JSON.stringify(makeErrorResponse(id, RPC_INVALID_PARAMS, 'id is required'))
        const ok = deleteDebrief(debriefId)
        return JSON.stringify(makeResponse(id, { ok }))
      }
      case 'sense.systemPromptPreview': {
        const editMode = getParam(p, 'editMode') as EditMode | undefined
        const prompt = buildSystemPromptPreview({ editMode })
        return JSON.stringify(makeResponse(id, { prompt }))
      }
      case 'sense.backfill': {
        const limit = getNumberParam(p, 'limit') ?? 50
        backfillDebriefs(limit).then(result => {
          console.log(`[bond] backfill complete: ${result.generated} generated, ${result.skipped} skipped, ${result.failed} failed`)
        }).catch(err => {
          console.warn('[bond] backfill failed:', err.message)
        })
        return JSON.stringify(makeResponse(id, { ok: true, message: 'Backfill started in background' }))
      }

      default:
        return JSON.stringify(makeErrorResponse(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`))
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return JSON.stringify(makeErrorResponse(id, RPC_INTERNAL_ERROR, message))
  }
}

// --- Connection handling ---

/**
 * Wire a WebSocket into the JSON-RPC dispatch. Shared by every listener: the
 * unix-socket server passes the per-start daemon token, the remote LAN server
 * passes the persistent pairing token. Subscriber state is module-level, so
 * clients from any listener join the same broadcast pools.
 */
export function attachConnection(ws: WebSocket, expectedToken?: string): void {
  ws.on('message', async (data) => {
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(data.toString())
    } catch {
      ws.send(JSON.stringify(makeErrorResponse(0, -32700, 'Parse error')))
      return
    }

    // Auth gate: if a token is configured, the first message must be bond.auth
    if (expectedToken && !authenticatedClients.has(ws)) {
      if (isRequest(msg) && msg.method === 'bond.auth') {
        const token = (msg.params as any)?.token
        if (token === expectedToken) {
          authenticatedClients.add(ws)
          ws.send(JSON.stringify(makeResponse(msg.id, { ok: true })))
        } else {
          console.warn('[bond-daemon] client auth failed — invalid token')
          ws.send(JSON.stringify(makeErrorResponse(msg.id, -32600, 'Invalid auth token')))
          ws.close()
        }
        return
      }
      // Not authenticated and not an auth request — reject
      ws.send(JSON.stringify(makeErrorResponse(
        isRequest(msg) ? msg.id : 0,
        -32600,
        'Authentication required — send bond.auth first'
      )))
      ws.close()
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
}

// --- Server lifecycle ---

export interface BondServer {
  close: () => Promise<void>
  wss: WebSocketServer
}

export function startServer(socketPath: string, authToken?: string, health?: DaemonHealth): BondServer {
  // The caller must have claimed the socket path via claimSocket() first —
  // an EADDRINUSE here means the single-instance guard was bypassed, and
  // crashing loudly beats silently stealing a live daemon's socket.

  // Load persisted model
  currentModel = getModelSetting()

  // Eagerly initialize Sense controller so it auto-enables on daemon startup
  getSenseController()

  // Web tools ask connected app clients to render pages in a hidden browser
  // window. Delivery is a broadcast — only the Electron main process listens.
  setRenderTransport((request) => {
    if (!serverWss) return false
    const msg = JSON.stringify(makeNotification('web.requestRender', { ...request }))
    let delivered = false
    for (const client of serverWss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg)
        delivered = true
      }
    }
    return delivered
  })

  // /health is the lifecycle source of truth: bin/bond asks the socket who
  // is serving (pid, bundle build time) instead of trusting the pid file.
  // The socket file is chmod 0600, so no auth gate is needed.
  const httpServer: HttpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health' && health) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(health))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ server: httpServer })
  serverWss = wss

  wss.on('connection', (ws) => attachConnection(ws, authToken))

  httpServer.listen(socketPath)

  // Restrict socket file permissions to owner-only
  try { chmodSync(socketPath, 0o600) } catch { /* ignore on platforms that don't support it */ }

  // Remember which file we bound — close() must never unlink a successor's
  // socket after this daemon has been orphaned.
  const boundIdentity = socketIdentity(socketPath)

  return {
    wss,
    close: () => new Promise<void>((resolve) => {
      // Abort the active query
      if (activeQuery) {
        activeQuery.ac.abort()
        clearSessionApprovals(activeQuery.sessionId)
        activeQuery = null
      }
      globalSubscribers.clear()

      // Clean up sense controller
      if (senseController) {
        senseController.destroy()
        senseController = null
      }
      setRenderTransport(null)

      wss.close(() => {
        httpServer.close(() => {
          // Clean up the socket file — only if it is still the one we bound
          closeDb()
          if (boundIdentity && !socketLost(socketPath, boundIdentity)) {
            try { unlinkSync(socketPath) } catch { /* ignore */ }
          }
          resolve()
        })
      })
    })
  }
}
