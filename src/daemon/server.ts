import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server as HttpServer } from 'node:http'
import { existsSync, unlinkSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { socketIdentity, socketLost, type DaemonHealth } from './lifecycle'
import type { TaggedChunk } from '../shared/stream'
import type { BondStreamChunk } from '../shared/stream'
import type { SessionMessage, AttachedImage, EditMode, FieldDefInput } from '../shared/session'
import { parseEditMode } from '../shared/session'
import type { TranscriptMessage } from '../shared/transcript'
import { listMessages as listTranscriptMessages, upsertMessages as upsertTranscriptMessages, searchMessages as searchTranscriptMessages, getSourceMessages, reconcileInterruptedTurns } from './transcript'
import type { ModelId } from '../shared/models'
import type { DispatchableMethod, RpcParams, RpcResult } from '../shared/rpc-schema'
import {
  makeResponse,
  makeErrorResponse,
  makeNotification,
  isRequest,
  RPC_METHOD_NOT_FOUND,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_VALIDATION_ERROR,
  PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcMessage
} from '../shared/protocol'
import { MODEL_IDS } from '../shared/models'
import {
  getCachedSkills,
  refreshSkillsCache,
  buildSystemPromptPreview,
} from './agent'
import { getPiAuthStatus, startPiOAuth } from './pi/runtime'
import { resolveApproval } from './approvals'
import { resolveQuestion, currentPendingQuestion } from './questions'
import { parseQuestionAnswer } from '../shared/questions'
import { setTurnTransport, startBondTurn, cancelActiveTurn, settleTurns, abortActiveTurnForShutdown } from './turns'
import { setRenderTransport, onRenderReady } from './web/broker'
import {
  MCP_PRESETS,
  McpConfigError,
  addMcpServer,
  classifyMcpTool,
  getMcpServers,
  getPreset,
  promoteMcpTool,
  removeMcpServer,
  setMcpAlwaysAsk,
  updateMcpPolicy,
  updateMcpServer,
  type McpServerConfig,
} from './mcp/config'
import { listSecretRefs as listMcpSecretRefs, removeSecret as removeMcpSecret, setSecret as setMcpSecret } from './mcp/keychain'
import { classifyTool as classifyMcpToolClass, firstSegmentOptions, routeSpecFromSchema, suggestToolClass as suggestMcpToolClass } from './mcp/policy'
import { policyFor as mcpPolicyFor, reconnectMcpServer, searchCatalog as searchMcpCatalog, serverStatuses as mcpServerStatuses } from './mcp/manager'
import { getRemoteStatus } from './remote'
import { createPairingCode, listDevices, revokeAllDevices, revokeDevice } from './pairing'
import { removeSkill } from './skills'
import { listAgents, revokeAgentRunner, updateAgentSettings } from './agents/service'
import * as desk from './desk/service'
import { createDeskWorker, type DeskWorker } from './desk/worker'
import { getRuntime as getDeskRuntime } from './desk/store'
import { getDb, closeDb } from './db'
import { buildMatchQuery } from './fts'
import {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  deleteArchivedSessions,
  getMessages,
  saveMessages
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
  searchItems,
  listReferences,
  CollectionValidationError
} from './collections'
import { createSenseController, type SenseController } from './sense/controller'
import { getStats as getSenseStats, clearData as clearSenseData } from './sense/storage'
import { getSetting, setSetting, getSenseSettings, setSenseSettings } from './settings'
import type { SenseSettings } from '../shared/sense'
import type { CoreMemory, MemoryItemInput, WorkingState } from '../shared/memory'
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
  getImage,
  getImages,
  listAllImages,
  deleteImage,
  importImage
} from './images'
import {
  getAsset,
  listAssets,
  addDocument,
  updateAssetMetadata,
  deleteAsset,
  addReference as addAssetReference,
  removeReference as removeAssetReference,
  listReferencesForItem,
  listBacklinksForAsset,
} from './library'
import { readCoreMemory, withCoreMemoryLock, writeCoreMemoryAtomic } from './memory/core-memory'
import { getMemoryItem, getMemoryItemSourceIds, listRecentMemory, searchMemory, upsertMemoryItem } from './memory/store'
import { createWorkingState } from './memory/working-state'
import { readWorkingMemoryState, waitForMemoryQueue, writeWorkingMemoryState } from './memory/service'
import { beginFirstRun, getFirstRunStatus, skipFirstRun } from './onboarding'
import { enterSandbox, exitSandbox, isSandboxed } from './sandbox'

// --- State ---

let currentModel: ModelId = 'balanced'
let serverWss: WebSocketServer | null = null

/**
 * Quiesce everything that writes through getDb() before swapping the data
 * directory (sandbox enter/exit): abort any streaming query, drain the
 * background memory queue, and suspend Sense capture. Sense wakes on the
 * post-swap side so a simulation never records into (or out of) the wrong
 * data set.
 */
async function settleForDataSwap(): Promise<void> {
  try { await settleTurns() } catch { /* already handled */ }
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
}

function broadcastImageChanged(): void {
  const msg = JSON.stringify(makeNotification('image.changed', {}))
  eachOpenClient(client => client.send(msg))
}

function broadcastCollectionsChanged(): void {
  const msg = JSON.stringify(makeNotification('collection.changed', {}))
  eachOpenClient(client => client.send(msg))
}

function broadcastLibraryChanged(): void {
  const msg = JSON.stringify(makeNotification('library.changed', {}))
  eachOpenClient(client => client.send(msg))
}

function broadcastMcpChanged(): void {
  const msg = JSON.stringify(makeNotification('mcp.changed', {}))
  eachOpenClient(client => client.send(msg))
}

/** Every MCP policy write shares this shape: unknown id → invalid params, change → broadcast. */
function requireMcpServer(server: McpServerConfig | null, id: string): McpServerConfig {
  if (!server) throw new RpcError(RPC_INVALID_PARAMS, `No MCP server called "${id}"`)
  broadcastMcpChanged()
  return server
}


// --- Sense ---

let senseController: SenseController | null = null

function getSenseController(): SenseController {
  if (!senseController) {
    const settings = getSenseSettings()
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

// --- Desk ---

let deskWorker: DeskWorker | null = null

/**
 * Desk reads Sense but never the other way round, so the controller is handed
 * to Desk through a provider rather than Desk importing this module back.
 */
function getDeskWorker(): DeskWorker {
  if (!deskWorker) {
    desk.setSenseStateProvider(() => {
      const controller = getSenseController()
      return { state: controller.getState(), enabled: controller.getSettings().enabled }
    })
    desk.onDeskChanged(() => broadcastSenseEvent('desk.changed', {}))
    deskWorker = createDeskWorker()
  }
  return deskWorker
}

/**
 * `running` is explicit persisted Desk state: a Desk that was running before a
 * daemon restart starts observing again without anyone asking it to. Observed
 * activity alone still never turns Desk on.
 */
export function startDeskIfRunning(): void {
  try {
    if (getDeskRuntime().running) getDeskWorker().start()
  } catch (error) {
    console.error('[bond] Desk startup failed:', error)
  }
}

export function stopDesk(): void {
  deskWorker?.stop()
}

function broadcastSenseEvent(method: string, params: unknown): void {
  const msg = JSON.stringify(makeNotification(method, params))
  eachOpenClient(client => client.send(msg))
}

// --- RPC handler ---

type RawParams = Record<string, unknown> | unknown[] | undefined

/** Params come off the wire untyped — treat every handler's params as untrusted. */
function raw(params: unknown): RawParams {
  return params as RawParams
}

function getParam(params: RawParams, key: string): unknown {
  if (Array.isArray(params)) return undefined
  return params?.[key]
}

function getStringParam(params: RawParams, key: string): string | undefined {
  const v = getParam(params, key)
  return typeof v === 'string' ? v : undefined
}

function getBoolParam(params: RawParams, key: string): boolean | undefined {
  const v = getParam(params, key)
  return typeof v === 'boolean' ? v : undefined
}

function getNumberParam(params: RawParams, key: string): number | undefined {
  const v = getParam(params, key)
  return typeof v === 'number' ? v : undefined
}

/**
 * Sense capture search: FTS5 over the trigger-maintained sense_fts index.
 * Per-term prefix matching approximates the old LIKE substring recall.
 * Returns null when the query has no indexable tokens or FTS5 rejects the
 * match string — callers fall back to the LIKE scan.
 */
function searchSenseCapturesFts(db: ReturnType<typeof getDb>, query: string, limit: number): Record<string, unknown>[] | null {
  const match = buildMatchQuery(query, { prefix: true })
  if (!match) return null
  try {
    return db.prepare(`
      SELECT c.*, 'see' AS channel
      FROM sense_fts f
      JOIN sense_captures c ON c.rowid = f.rowid
      WHERE sense_fts MATCH ?
      ORDER BY c.captured_at DESC
      LIMIT ?
    `).all(match, limit) as Record<string, unknown>[]
  } catch {
    return null
  }
}

/** LIKE fallback for queries FTS cannot represent (pure punctuation, etc.). */
function searchSenseCapturesLike(db: ReturnType<typeof getDb>, query: string, limit: number): Record<string, unknown>[] {
  return db.prepare(`
    SELECT *, 'see' as channel FROM sense_captures
    WHERE text_content LIKE ? OR app_name LIKE ? OR window_title LIKE ?
    ORDER BY captured_at DESC
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as Record<string, unknown>[]
}

function sourceIdsForMemoryTags(tags: string[]): string[] {
  return tags
    .filter(tag => tag.startsWith('source:'))
    .map(tag => tag.slice('source:'.length).trim())
    .filter(Boolean)
}

interface RpcContext { ws: WebSocket }

type RpcHandler<M extends DispatchableMethod> = (params: RpcParams<M>, ctx: RpcContext) => Promise<RpcResult<M>> | RpcResult<M>

type RpcHandlers = { [M in DispatchableMethod]: RpcHandler<M> }

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message)
  }
}

const handlers: RpcHandlers = {
  // --- Chat ---
  'bond.send': async (input, { ws }) => {
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined
    const images = Array.isArray(input.images) ? input.images as AttachedImage[] : undefined
    if (!text && !images?.length) throw new RpcError(RPC_INVALID_PARAMS, 'text or images required')

    const session = sessionId ? getSession(sessionId) : null
    if (sessionId && !session) throw new RpcError(RPC_INVALID_PARAMS, 'session not found')

    subscribeTo(sessionId, ws)

    return await startBondTurn({
      text,
      sessionId,
      images,
      turnId: typeof input.turnId === 'string' ? input.turnId : undefined,
      userMessageId: typeof input.userMessageId === 'string' ? input.userMessageId : undefined,
      assistantMessageId: typeof input.assistantMessageId === 'string' ? input.assistantMessageId : undefined,
      activityMessageId: typeof input.activityMessageId === 'string' ? input.activityMessageId : undefined,
      editMode: input.editMode ?? session?.editMode,
      model: currentModel,
    })
  },

  'bond.cancel': async (params) => {
    await cancelActiveTurn(getStringParam(raw(params), 'sessionId'))
    return { ok: true }
  },

  'bond.approvalResponse': (params) => {
    const p = raw(params)
    const requestId = getStringParam(p, 'requestId')
    const approved = getBoolParam(p, 'approved')
    if (!requestId) throw new RpcError(RPC_INVALID_PARAMS, 'requestId is required')
    if (approved === undefined) throw new RpcError(RPC_INVALID_PARAMS, 'approved is required')
    resolveApproval(requestId, approved)
    // Let every other live viewer flip its pending approval prompt —
    // otherwise a second client shows a stale prompt until query_end.
    broadcastChunk(undefined, { kind: 'approval_resolved', requestId, approved })
    return { ok: true }
  },

  'bond.questionResponse': (params) => {
    const p = raw(params)
    const questionId = getStringParam(p, 'questionId')
    if (!questionId) throw new RpcError(RPC_INVALID_PARAMS, 'questionId is required')
    let answer
    try {
      answer = parseQuestionAnswer(getParam(p, 'answer'))
    } catch (error) {
      throw new RpcError(RPC_INVALID_PARAMS, error instanceof Error ? error.message : 'invalid answer')
    }
    // An unknown questionId still resolves and broadcasts — same forgiving
    // shape as approvals; the broadcast is what un-sticks a stale card on
    // another device that already saw this question answered.
    resolveQuestion(questionId, answer)
    broadcastChunk(undefined, { kind: 'question_resolved', questionId, answer })
    return { ok: true }
  },

  'question.pending': () => currentPendingQuestion(),

  // --- Remote access (LAN web server) ---
  'remote.status': () => getRemoteStatus(),

  'remote.createPairingCode': () => createPairingCode(),
  'remote.listDevices': () => ({ devices: listDevices() }),
  'remote.revokeDevice': (params) => {
    const id = getStringParam(raw(params), 'id')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    revokeDevice(id)
    return { ok: true as const }
  },
  'remote.revokeAllDevices': () => ({ ok: true as const, revoked: revokeAllDevices() }),

  // Liveness probe — phone browsers use it to detect zombie sockets
  // (iOS kills WebSockets on lock without firing close events).
  'bond.ping': () => ({ ok: true, protocolVersion: PROTOCOL_VERSION }),

  // --- Subscriptions ---
  'bond.subscribe': (params, { ws }) => {
    // Pending approvals need no replay here: clients reconstruct them
    // from persisted activity rows, and a daemon restart voids the
    // resolver anyway — replaying such a prompt would strand the user.
    subscribeTo(getStringParam(raw(params), 'sessionId'), ws)
    return { ok: true }
  },

  'bond.unsubscribe': (params, { ws }) => {
    const sessionId = getStringParam(raw(params), 'sessionId')
    unsubscribeFrom(sessionId, ws)
    return { ok: true }
  },

  // --- Model ---
  'bond.setModel': (params) => {
    const model = getStringParam(raw(params), 'model')
    if (model && (MODEL_IDS as readonly string[]).includes(model)) {
      currentModel = model as ModelId
      saveModelSetting(model as ModelId)
    }
    return { ok: true }
  },

  'bond.getModel': () => currentModel,

  // --- Continuous transcript ---
  'transcript.list': (params) => {
    const p = raw(params)
    const before = getParam(p, 'beforeSeq')
    const limitValue = getParam(p, 'limit')
    const beforeSeq = typeof before === 'number' ? before : undefined
    const limit = typeof limitValue === 'number' ? limitValue : undefined
    return listTranscriptMessages({ beforeSeq, limit })
  },

  'transcript.upsert': (params) => {
    const messages = getParam(raw(params), 'messages')
    if (!Array.isArray(messages)) throw new RpcError(RPC_INVALID_PARAMS, 'messages must be an array')
    upsertTranscriptMessages(messages as TranscriptMessage[])
    return { ok: true }
  },

  'transcript.search': (params) => {
    const p = raw(params)
    const query = getStringParam(p, 'query')
    if (!query) throw new RpcError(RPC_INVALID_PARAMS, 'query is required')
    const limitValue = getParam(p, 'limit')
    return { messages: searchTranscriptMessages(query, { limit: typeof limitValue === 'number' ? limitValue : undefined }) }
  },

  // --- Sessions ---
  'session.list': () => listSessions(),

  'session.create': (params) => {
    const sessionTitle = getStringParam(raw(params), 'title')
    return createSession({ title: sessionTitle || undefined })
  },

  'session.get': (params) => {
    const sid = getStringParam(raw(params), 'id')
    if (!sid) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    return getSession(sid)
  },

  'session.update': (params) => {
    const p = raw(params)
    const sid = getStringParam(p, 'id')
    const updates = getParam(p, 'updates') as Record<string, unknown> | undefined
    if (!sid) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const result = updateSession(sid, updates ?? {})

    // Trigger debrief on archive (regenerates if one already exists from a prior archive)
    if (updates?.archived === true) {
      generateDebrief(sid).catch((err) => {
        console.warn('[bond] debrief generation failed:', err.message)
      })
    }

    return result
  },

  'session.delete': (params) => {
    const sid = getStringParam(raw(params), 'id')
    if (!sid) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    return deleteSession(sid)
  },

  'session.deleteArchived': () => {
    const count = deleteArchivedSessions()
    return { ok: true, count }
  },

  'session.getMessages': (params) => {
    const sid = getStringParam(raw(params), 'sessionId')
    if (!sid) throw new RpcError(RPC_INVALID_PARAMS, 'sessionId is required')
    return getMessages(sid)
  },

  'session.saveMessages': (params) => {
    const p = raw(params)
    const sid = getStringParam(p, 'sessionId')
    const msgs = getParam(p, 'messages') as SessionMessage[] | undefined
    if (!sid) throw new RpcError(RPC_INVALID_PARAMS, 'sessionId is required')
    if (!msgs) throw new RpcError(RPC_INVALID_PARAMS, 'messages is required')
    return saveMessages(sid, msgs)
  },

  // --- Pi setup ---
  'pi.status': async () => await getPiAuthStatus(),

  'pi.startOAuth': async (params) => {
    const provider = getStringParam(raw(params), 'provider')
    if (provider !== 'anthropic' && provider !== 'openai-codex') {
      throw new RpcError(RPC_INVALID_PARAMS, 'A supported OAuth provider is required')
    }
    return await startPiOAuth(provider)
  },

  // --- Settings ---
  'settings.getEditMode': () => parseEditMode(getSetting('edit_mode')),

  'settings.setEditMode': (params) => {
    const rawMode = getParam(raw(params), 'editMode')
    if (!rawMode || typeof rawMode !== 'object' || !('type' in (rawMode as object))) {
      throw new RpcError(RPC_INVALID_PARAMS, 'editMode is required')
    }
    const editMode = parseEditMode(rawMode)
    setSetting('edit_mode', JSON.stringify(editMode))
    // One global mode: every live client (desktop and phone)
    // mirrors the change immediately instead of drifting until reload.
    broadcastChunk(undefined, { kind: 'edit_mode_changed', editMode })
    return { ok: true }
  },

  'settings.getSoul': () => getSoul(),

  'settings.saveSoul': (params) => {
    const content = getStringParam(raw(params), 'content')
    if (content === undefined) throw new RpcError(RPC_INVALID_PARAMS, 'content is required')
    return saveSoul(content)
  },

  'settings.getAccentColor': () => getAccentColor(),

  'settings.saveAccentColor': (params) => {
    const hex = getStringParam(raw(params), 'hex')
    if (!hex) throw new RpcError(RPC_INVALID_PARAMS, 'hex is required')
    return saveAccentColor(hex)
  },

  'settings.getWindowOpacity': () => getWindowOpacity(),

  'settings.saveWindowOpacity': (params) => {
    const opacity = getParam(raw(params), 'opacity')
    if (typeof opacity !== 'number') throw new RpcError(RPC_INVALID_PARAMS, 'opacity is required')
    return saveWindowOpacity(opacity)
  },

  // --- MCP connections ---
  'mcp.list': () => ({ servers: getMcpServers(), presets: MCP_PRESETS }),

  'mcp.add': (params) => {
    const p = raw(params)
    const presetId = getStringParam(p, 'preset')
    const input = presetId
      ? (() => {
          const preset = getPreset(presetId)
          if (!preset) throw new RpcError(RPC_INVALID_PARAMS, `No MCP preset called "${presetId}"`)
          const { description: _description, ...config } = preset
          return { ...config, enabled: true }
        })()
      : getParam(p, 'server')
    try {
      const server = addMcpServer(input)
      broadcastMcpChanged()
      return server
    } catch (error) {
      if (error instanceof McpConfigError) throw new RpcError(RPC_INVALID_PARAMS, error.message)
      throw error
    }
  },

  'mcp.update': (params) => {
    const p = raw(params)
    const id = getStringParam(p, 'id')
    const updates = getParam(p, 'updates')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    if (!updates || typeof updates !== 'object') throw new RpcError(RPC_INVALID_PARAMS, 'updates is required')
    try {
      const server = updateMcpServer(id, updates as Parameters<typeof updateMcpServer>[1])
      if (!server) throw new RpcError(RPC_INVALID_PARAMS, `No MCP server called "${id}"`)
      // The manager reconciles config on its own, but an explicit drop makes a
      // toggle take effect immediately instead of at the next catalog read.
      reconnectMcpServer(id)
      broadcastMcpChanged()
      return server
    } catch (error) {
      if (error instanceof McpConfigError) throw new RpcError(RPC_INVALID_PARAMS, error.message)
      throw error
    }
  },

  'mcp.remove': (params) => {
    const id = getStringParam(raw(params), 'id')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const removed = removeMcpServer(id)
    if (removed) {
      reconnectMcpServer(id)
      broadcastMcpChanged()
    }
    return { ok: removed }
  },

  'mcp.status': () => ({ servers: mcpServerStatuses() }),

  'mcp.listTools': async (params) => {
    const p = raw(params)
    const result = await searchMcpCatalog(getStringParam(p, 'query'), getStringParam(p, 'server'))
    // Join each protocol tool with the human-owned policy the gate actually
    // uses, so the UI never has to reimplement classification.
    // First-segment values are a per-SERVER namespace: context-a8c enumerates
    // its providers on load-provider, and execute-tool routes on the same set
    // without repeating it. Pooling them is what lets the UI offer per-provider
    // rules on the tool that actually does the work.
    const serverOptions = new Map<string, string[]>()
    for (const tool of result.tools) {
      const segments = routeSpecFromSchema(tool.inputSchema)
      if (!segments.length) continue
      const options = firstSegmentOptions(tool.inputSchema, segments[0].name)
      if (options.length) {
        serverOptions.set(tool.server, [...new Set([...(serverOptions.get(tool.server) ?? []), ...options])])
      }
    }

    return {
      tools: result.tools.map((tool) => {
        const policy = mcpPolicyFor(tool.server)
        const segments = routeSpecFromSchema(tool.inputSchema)
        const options = segments.length ? (serverOptions.get(tool.server) ?? []) : []
        return {
          ...tool,
          ...(segments.length ? {
            route: {
              segments: segments.map((segment) => segment.name),
              options,
              classes: Object.fromEntries(options.map((option) => [option, classifyMcpToolClass(policy, tool.name, option)])),
            },
          } : {}),
          toolClass: classifyMcpToolClass(policy, tool.name),
          suggestedClass: suggestMcpToolClass(tool.annotations),
          alwaysAsk: policy.alwaysAsk.includes(tool.name),
          promoted: policy.promoted.includes(tool.name),
        }
      }),
      errors: result.errors,
    }
  },

  'mcp.reconnect': (params) => {
    const id = getStringParam(raw(params), 'id')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    reconnectMcpServer(id)
    broadcastMcpChanged()
    return { ok: true }
  },

  // --- MCP trust policy (the gate every call passes through) ---
  'mcp.setTrust': (params) => {
    const p = raw(params)
    const id = getStringParam(p, 'id')
    const trust = getStringParam(p, 'trust')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    if (trust !== 'ask' && trust !== 'trusted' && trust !== 'disabled') {
      throw new RpcError(RPC_INVALID_PARAMS, 'trust must be ask, trusted, or disabled')
    }
    return requireMcpServer(updateMcpPolicy(id, { trust }), id)
  },

  'mcp.classifyTool': (params) => {
    const p = raw(params)
    const id = getStringParam(p, 'id')
    const tool = getStringParam(p, 'tool')
    const toolClass = getStringParam(p, 'toolClass')
    if (!id || !tool) throw new RpcError(RPC_INVALID_PARAMS, 'id and tool are required')
    if (toolClass !== 'read' && toolClass !== 'write' && toolClass !== 'unknown') {
      throw new RpcError(RPC_INVALID_PARAMS, 'toolClass must be read, write, or unknown')
    }
    return requireMcpServer(classifyMcpTool(id, tool, toolClass), id)
  },

  'mcp.promoteTool': (params) => {
    const p = raw(params)
    const id = getStringParam(p, 'id')
    const tool = getStringParam(p, 'tool')
    const promoted = getBoolParam(p, 'promoted')
    if (!id || !tool) throw new RpcError(RPC_INVALID_PARAMS, 'id and tool are required')
    if (promoted === undefined) throw new RpcError(RPC_INVALID_PARAMS, 'promoted is required')
    return requireMcpServer(promoteMcpTool(id, tool, promoted), id)
  },

  'mcp.setAlwaysAsk': (params) => {
    const p = raw(params)
    const id = getStringParam(p, 'id')
    const tool = getStringParam(p, 'tool')
    const alwaysAsk = getBoolParam(p, 'alwaysAsk')
    if (!id || !tool) throw new RpcError(RPC_INVALID_PARAMS, 'id and tool are required')
    if (alwaysAsk === undefined) throw new RpcError(RPC_INVALID_PARAMS, 'alwaysAsk is required')
    return requireMcpServer(setMcpAlwaysAsk(id, tool, alwaysAsk), id)
  },

  // --- MCP secrets (Keychain; write-only over the wire) ---
  'mcp.setSecret': async (params) => {
    const p = raw(params)
    const ref = getStringParam(p, 'ref')
    const value = getStringParam(p, 'value')
    if (!ref || !value) throw new RpcError(RPC_INVALID_PARAMS, 'ref and value are required')
    try {
      await setMcpSecret(ref, value)
    } catch (error) {
      throw new RpcError(RPC_INVALID_PARAMS, error instanceof Error ? error.message : 'Keychain rejected the secret')
    }
    broadcastMcpChanged()
    return { ok: true, ref }
  },

  'mcp.deleteSecret': async (params) => {
    const ref = getStringParam(raw(params), 'ref')
    if (!ref) throw new RpcError(RPC_INVALID_PARAMS, 'ref is required')
    const ok = await removeMcpSecret(ref)
    if (ok) broadcastMcpChanged()
    return { ok }
  },

  'mcp.listSecrets': async () => ({ refs: await listMcpSecretRefs() }),

  // --- Agents ---
  'agents.list': () => listAgents(),

  'agents.updateSettings': (params) => {
    const name = getStringParam(raw(params), 'name')
    if (!name) throw new RpcError(RPC_INVALID_PARAMS, 'name is required')
    const settings = (raw(params) as { settings?: unknown }).settings
    if (!settings || typeof settings !== 'object') throw new RpcError(RPC_INVALID_PARAMS, 'settings object is required')
    return updateAgentSettings(name, settings)
  },

  'agents.revokeRunner': (params) => {
    const command = getStringParam(raw(params), 'command')
    if (!command) throw new RpcError(RPC_INVALID_PARAMS, 'command is required')
    return revokeAgentRunner(command)
  },

  // --- Skills ---
  'skills.list': () => getCachedSkills(),

  'skills.refresh': () => refreshSkillsCache(),

  'skills.remove': (params) => {
    const name = getStringParam(raw(params), 'name')
    if (!name) throw new RpcError(RPC_INVALID_PARAMS, 'name is required')
    const removed = removeSkill(name)
    if (removed) refreshSkillsCache()
    return { ok: removed }
  },

  // --- Images ---
  'image.list': () => listAllImages(),

  'image.get': (params) => {
    const imageId = getStringParam(raw(params), 'id')
    if (!imageId) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    return getImage(imageId)
  },

  'image.getMultiple': (params) => {
    const ids = getParam(raw(params), 'ids') as string[] | undefined
    if (!ids || !Array.isArray(ids)) throw new RpcError(RPC_INVALID_PARAMS, 'ids is required')
    return getImages(ids)
  },

  'image.import': (params) => {
    const p = raw(params)
    const data = getStringParam(p, 'data')
    const mediaType = getStringParam(p, 'mediaType')
    if (!data || !mediaType) throw new RpcError(RPC_INVALID_PARAMS, 'data and mediaType are required')
    const image = importImage(data, mediaType as any)
    broadcastImageChanged()
    broadcastLibraryChanged()
    return image
  },

  'image.delete': (params) => {
    const imageId = getStringParam(raw(params), 'id')
    if (!imageId) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const deleted = deleteImage(imageId)
    if (deleted) {
      broadcastImageChanged()
      broadcastLibraryChanged()
    }
    return deleted
  },

  // --- Collections ---
  'collection.list': () => listCollections(),

  'collection.listReferences': () => listReferences(),

  'collection.get': (params) => {
    const cid = getStringParam(raw(params), 'id')
    if (!cid) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    return getCollection(cid)
  },

  'collection.create': (params) => {
    const p = raw(params)
    const name = getStringParam(p, 'name')
    if (!name) throw new RpcError(RPC_INVALID_PARAMS, 'name is required')
    const schema = getParam(p, 'schema')
    if (!schema || !Array.isArray(schema)) throw new RpcError(RPC_INVALID_PARAMS, 'schema is required')
    const icon = getStringParam(p, 'icon') ?? ''
    const issuePrefix = getStringParam(p, 'issuePrefix') ?? ''
    const collection = createCollection(name, schema as FieldDefInput[], icon, [], issuePrefix)
    broadcastCollectionsChanged()
    return collection
  },

  'collection.update': (params) => {
    const p = raw(params)
    const cid = getStringParam(p, 'id')
    if (!cid) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const updates = getParam(p, 'updates') as Record<string, unknown> | undefined
    const updated = updateCollection(cid, updates ?? {})
    broadcastCollectionsChanged()
    return updated
  },

  'collection.delete': (params) => {
    const cid = getStringParam(raw(params), 'id')
    if (!cid) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const deleted = deleteCollection(cid)
    broadcastCollectionsChanged()
    return deleted
  },

  'collection.renameField': (params) => {
    const p = raw(params)
    const cid = getStringParam(p, 'id')
    const oldName = getStringParam(p, 'oldName')
    const newName = getStringParam(p, 'newName')
    if (!cid || !oldName || !newName) throw new RpcError(RPC_INVALID_PARAMS, 'id, oldName, and newName are required')
    const renamed = renameField(cid, oldName, newName)
    broadcastCollectionsChanged()
    return renamed
  },

  'collection.listItems': (params) => {
    const collectionId = getStringParam(raw(params), 'collectionId')
    if (!collectionId) throw new RpcError(RPC_INVALID_PARAMS, 'collectionId is required')
    return listItems(collectionId)
  },

  'collection.getItem': (params) => {
    const itemId = getStringParam(raw(params), 'id')
    if (!itemId) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    return getItem(itemId)
  },

  'collection.addItem': (params) => {
    const p = raw(params)
    const collectionId = getStringParam(p, 'collectionId')
    if (!collectionId) throw new RpcError(RPC_INVALID_PARAMS, 'collectionId is required')
    const data = getParam(p, 'data') as Record<string, unknown> | undefined
    if (!data) throw new RpcError(RPC_INVALID_PARAMS, 'data is required')
    const item = addItem(collectionId, data)
    broadcastCollectionsChanged()
    return item
  },

  'collection.updateItem': (params) => {
    const p = raw(params)
    const itemId = getStringParam(p, 'id')
    if (!itemId) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const data = getParam(p, 'data') as Record<string, unknown> | undefined
    if (!data) throw new RpcError(RPC_INVALID_PARAMS, 'data is required')
    const updated = updateItem(itemId, data)
    broadcastCollectionsChanged()
    return updated
  },

  'collection.deleteItem': (params) => {
    const itemId = getStringParam(raw(params), 'id')
    if (!itemId) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const deleted = deleteItem(itemId)
    broadcastCollectionsChanged()
    return deleted
  },

  'collection.reorderItems': (params) => {
    const ids = getParam(raw(params), 'ids') as string[] | undefined
    if (!ids || !Array.isArray(ids)) throw new RpcError(RPC_INVALID_PARAMS, 'ids array is required')
    reorderItems(ids)
    broadcastCollectionsChanged()
    return true
  },

  // --- Collection item comments ---

  'collection.addItemComment': (params) => {
    const p = raw(params)
    const itemId = getStringParam(p, 'itemId')
    const author = getStringParam(p, 'author') as 'user' | 'bond' | undefined
    const body = getStringParam(p, 'body')
    if (!itemId || !author || !body) throw new RpcError(RPC_INVALID_PARAMS, 'itemId, author, and body are required')
    const comment = addItemComment(itemId, author, body)
    broadcastCollectionsChanged()
    return comment
  },

  'collection.deleteItemComment': (params) => {
    const cid = getStringParam(raw(params), 'id')
    if (!cid) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const deleted = deleteItemComment(cid)
    broadcastCollectionsChanged()
    return deleted
  },

  'collection.listItemComments': (params) => {
    const itemId = getStringParam(raw(params), 'itemId')
    if (!itemId) throw new RpcError(RPC_INVALID_PARAMS, 'itemId is required')
    return listItemComments(itemId)
  },

  'collection.searchItems': (params) => {
    const p = raw(params)
    const collectionId = getStringParam(p, 'collectionId')
    const query = getStringParam(p, 'query')
    if (!collectionId || !query) throw new RpcError(RPC_INVALID_PARAMS, 'collectionId and query are required')
    return searchItems(collectionId, query)
  },

  'collection.getByName': (params) => {
    const name = getStringParam(raw(params), 'name')
    if (!name) throw new RpcError(RPC_INVALID_PARAMS, 'name is required')
    return getCollectionByName(name)
  },

  // --- Library ---
  'library.list': (params) => {
    const p = raw(params)
    const kind = getStringParam(p, 'kind') as 'document' | 'media' | undefined
    const query = getStringParam(p, 'query')
    return listAssets({ kind, query })
  },

  'library.get': (params) => {
    const id = getStringParam(raw(params), 'id')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    return getAsset(id)
  },

  'library.addDocument': (params) => {
    const p = raw(params)
    const filename = getStringParam(p, 'filename')
    const mediaType = getStringParam(p, 'mediaType')
    const format = getStringParam(p, 'format')
    const data = getStringParam(p, 'data')
    if (!filename || !mediaType || !format || !data) {
      throw new RpcError(RPC_INVALID_PARAMS, 'filename, mediaType, format, and data are required')
    }
    const asset = addDocument({
      title: getStringParam(p, 'title'),
      filename,
      mediaType,
      format: format as any,
      data,
      sourceUrl: getStringParam(p, 'sourceUrl'),
      sourceSessionId: getStringParam(p, 'sourceSessionId'),
      sourceMessageId: getStringParam(p, 'sourceMessageId'),
    })
    broadcastLibraryChanged()
    return asset
  },

  'library.updateMetadata': (params) => {
    const p = raw(params)
    const id = getStringParam(p, 'id')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const updates = getParam(p, 'updates') as { title?: string; sourceUrl?: string } | undefined
    const updated = updateAssetMetadata(id, updates ?? {})
    broadcastLibraryChanged()
    return updated
  },

  'library.delete': (params) => {
    const id = getStringParam(raw(params), 'id')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const ok = deleteAsset(id)
    if (ok) {
      broadcastLibraryChanged()
      broadcastCollectionsChanged() // any asset_references on this asset just vanished
    }
    return { ok }
  },

  'library.addReference': (params) => {
    const p = raw(params)
    const assetId = getStringParam(p, 'assetId')
    const itemId = getStringParam(p, 'itemId')
    if (!assetId || !itemId) throw new RpcError(RPC_INVALID_PARAMS, 'assetId and itemId are required')
    const ref = addAssetReference(assetId, itemId)
    broadcastLibraryChanged()
    broadcastCollectionsChanged()
    return ref
  },

  'library.removeReference': (params) => {
    const p = raw(params)
    const assetId = getStringParam(p, 'assetId')
    const itemId = getStringParam(p, 'itemId')
    if (!assetId || !itemId) throw new RpcError(RPC_INVALID_PARAMS, 'assetId and itemId are required')
    const ok = removeAssetReference(assetId, itemId)
    if (ok) {
      broadcastLibraryChanged()
      broadcastCollectionsChanged()
    }
    return { ok }
  },

  'library.listReferencesForItem': (params) => {
    const itemId = getStringParam(raw(params), 'itemId')
    if (!itemId) throw new RpcError(RPC_INVALID_PARAMS, 'itemId is required')
    return listReferencesForItem(itemId)
  },

  'library.listBacklinksForAsset': (params) => {
    const assetId = getStringParam(raw(params), 'assetId')
    if (!assetId) throw new RpcError(RPC_INVALID_PARAMS, 'assetId is required')
    return listBacklinksForAsset(assetId)
  },

  // --- Sense ---
  'sense.status': () => {
    const ctrl = getSenseController()
    const stats = getSenseStats()
    return {
      enabled: ctrl.getSettings().enabled,
      state: ctrl.getState(),
      ...stats,
    }
  },

  'sense.enable': () => {
    const ctrl = getSenseController()
    ctrl.enable()
    setSenseSettings(ctrl.getSettings())
    return { ok: true }
  },

  'sense.disable': () => {
    const ctrl = getSenseController()
    ctrl.disable()
    setSenseSettings(ctrl.getSettings())
    return { ok: true }
  },

  'sense.pause': (params) => {
    const ctrl = getSenseController()
    const minutes = getNumberParam(raw(params), 'minutes') ?? 10
    ctrl.pause(minutes)
    return { ok: true, resumeAt: new Date(Date.now() + minutes * 60_000).toISOString() }
  },

  'sense.resume': () => {
    const ctrl = getSenseController()
    ctrl.resume()
    return { ok: true }
  },

  'sense.captureReady': (params) => {
    const p = raw(params)
    const ctrl = getSenseController()
    const captureId = getStringParam(p, 'captureId')
    const imagePath = getStringParam(p, 'imagePath')
    if (!captureId || !imagePath) throw new RpcError(RPC_INVALID_PARAMS, 'captureId and imagePath required')
    ctrl.onCaptureReady(captureId, imagePath)
    return { ok: true }
  },

  'sense.captureFailed': (params) => {
    const p = raw(params)
    const captureId = getStringParam(p, 'captureId')
    if (!captureId) throw new RpcError(RPC_INVALID_PARAMS, 'captureId required')
    getSenseController().onCaptureFailed(captureId, getStringParam(p, 'reason') ?? undefined)
    return { ok: true }
  },

  // --- Web (hidden-browser render round-trip) ---
  'web.renderReady': (params) => {
    const renderId = getStringParam(raw(params), 'renderId')
    if (!renderId) throw new RpcError(RPC_INVALID_PARAMS, 'renderId is required')
    const handled = onRenderReady(params)
    return { ok: handled }
  },

  'sense.now': () => {
    const db = getDb()
    const capture = db.prepare(
      'SELECT * FROM sense_captures ORDER BY captured_at DESC LIMIT 1'
    ).get() as Record<string, unknown> | undefined
    const ctrl = getSenseController()
    return {
      capture: capture ?? null,
      state: ctrl.getState(),
    }
  },

  'sense.today': () => {
    const db = getDb()
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString()
    const sessions = db.prepare(
      "SELECT * FROM sense_sessions WHERE started_at >= ? ORDER BY started_at ASC"
    ).all(todayStart) as Record<string, unknown>[]
    const apps = db.prepare(`
      SELECT app_name, COUNT(*) as capture_count,
        MIN(captured_at) as first_seen, MAX(captured_at) as last_seen
      FROM sense_captures
      WHERE captured_at >= ? AND app_name IS NOT NULL
      GROUP BY app_name
      ORDER BY capture_count DESC
    `).all(todayStart) as Record<string, unknown>[]
    return { sessions, apps }
  },

  'sense.search': (params) => {
    const p = raw(params)
    const searchQuery = getStringParam(p, 'query')
    if (!searchQuery) throw new RpcError(RPC_INVALID_PARAMS, 'query required')
    const limit = getNumberParam(p, 'limit') ?? 20
    const db = getDb()

    // Cross-channel search: screen captures + session debriefs
    const captures = searchSenseCapturesFts(db, searchQuery, limit)
      ?? searchSenseCapturesLike(db, searchQuery, limit)

    const debriefResults = searchDebriefs(searchQuery, limit).map(d => ({
      ...d,
      channel: 'chat' as const,
    }))

    // Unified results sorted by date
    const unified = [
      ...captures.map(c => ({ ...c, _sortDate: c.captured_at as string })),
      ...debriefResults.map(d => ({ ...d, _sortDate: d.createdAt })),
    ].sort((a, b) => b._sortDate.localeCompare(a._sortDate)).slice(0, limit)

    return unified
  },

  'sense.apps': (params) => {
    const range = getStringParam(raw(params), 'range') ?? 'today'
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
    `).all(since) as Record<string, unknown>[]
    return apps
  },

  'sense.timeline': (params) => {
    const p = raw(params)
    const from = getStringParam(p, 'from')
    const to = getStringParam(p, 'to')
    const limit = getNumberParam(p, 'limit') ?? 5000
    const db = getDb()
    let sql = 'SELECT * FROM sense_captures WHERE 1=1'
    const sqlParams: (string | number)[] = []
    if (from) { sql += ' AND captured_at >= ?'; sqlParams.push(from) }
    if (to) { sql += ' AND captured_at <= ?'; sqlParams.push(to) }
    sql += ' ORDER BY captured_at ASC LIMIT ?'
    sqlParams.push(limit)
    return db.prepare(sql).all(...sqlParams) as Record<string, unknown>[]
  },

  'sense.capture': (params) => {
    const captureId = getStringParam(raw(params), 'id')
    if (!captureId) throw new RpcError(RPC_INVALID_PARAMS, 'id required')
    const db = getDb()
    const capture = db.prepare('SELECT * FROM sense_captures WHERE id = ?').get(captureId) as Record<string, unknown> | undefined
    if (!capture) throw new RpcError(RPC_INVALID_PARAMS, 'capture not found')
    let image: string | null = null
    const imgPath = capture.image_path as string | null
    if (imgPath && existsSync(imgPath)) {
      try {
        image = readFileSync(imgPath).toString('base64')
      } catch { /* image unreadable */ }
    }
    return { capture, image }
  },

  'sense.sessions': (params) => {
    const p = raw(params)
    const from = getStringParam(p, 'from')
    const to = getStringParam(p, 'to')
    const db = getDb()
    let sql = 'SELECT * FROM sense_sessions WHERE 1=1'
    const sqlParams: string[] = []
    if (from) { sql += ' AND (ended_at >= ? OR ended_at IS NULL)'; sqlParams.push(from) }
    if (to) { sql += ' AND started_at <= ?'; sqlParams.push(to) }
    sql += ' ORDER BY started_at ASC'
    return db.prepare(sql).all(...sqlParams) as Record<string, unknown>[]
  },

  'sense.settings': () => {
    const ctrl = getSenseController()
    return ctrl.getSettings()
  },

  'sense.updateSettings': (params) => {
    const updates = getParam(raw(params), 'updates') as Partial<SenseSettings> | undefined
    if (!updates) throw new RpcError(RPC_INVALID_PARAMS, 'updates required')
    const ctrl = getSenseController()
    const newSettings = ctrl.updateSettings(updates)
    setSenseSettings(newSettings)
    return newSettings
  },

  'sense.clear': (params) => {
    const range = getParam(raw(params), 'range') as { from?: string; to?: string } | undefined
    const deleted = clearSenseData(range)
    return { deletedCount: deleted }
  },

  'sense.stats': () => getSenseStats(),

  // --- Onboarding ---
  'onboarding.status': () => getFirstRunStatus(),
  'onboarding.begin': () => beginFirstRun(),
  'onboarding.skip': () => skipFirstRun(),

  // --- New-user sandbox ---
  'sandbox.status': () => ({ sandboxed: isSandboxed() }),

  'sandbox.enter': async () => {
    // Sense stays suspended while sandboxed — a fresh install has no Sense.
    await settleForDataSwap()
    try {
      enterSandbox()
    } catch (error) {
      wakeAfterDataSwap()
      throw error
    }
    return { sandboxed: true }
  },

  'sandbox.exit': async () => {
    await settleForDataSwap()
    exitSandbox()
    wakeAfterDataSwap()
    return { sandboxed: false }
  },

  // --- Memory ---
  'memory.core': () => readCoreMemory() as CoreMemory,

  'memory.updateCore': async (params) => {
    const core = getParam(raw(params), 'core') as CoreMemory | undefined
    if (!core) throw new RpcError(RPC_INVALID_PARAMS, 'core is required')
    return await withCoreMemoryLock(() => writeCoreMemoryAtomic({ ...core, updatedAt: new Date().toISOString() }))
  },

  'memory.working': () => readWorkingMemoryState(),

  'memory.updateWorking': (params) => {
    const working = getParam(raw(params), 'working') as WorkingState | undefined
    if (!working) throw new RpcError(RPC_INVALID_PARAMS, 'working is required')
    // The service writer redacts — text pasted into the MemoryView must
    // never persist secrets that then ride along in every future prompt.
    return writeWorkingMemoryState(createWorkingState(working))
  },

  'memory.clearWorking': () => writeWorkingMemoryState(createWorkingState()),

  'memory.search': (params) => {
    const p = raw(params)
    const query = getStringParam(p, 'query') ?? ''
    const limit = getNumberParam(p, 'limit') ?? 20
    const results = query.trim()
      ? searchMemory(query, { limit })
      : listRecentMemory({ limit }).map(item => ({ item, score: 0 }))
    return { results }
  },

  'memory.upsert': (params) => {
    const item = getParam(raw(params), 'item') as MemoryItemInput | undefined
    if (!item || typeof item.text !== 'string') throw new RpcError(RPC_INVALID_PARAMS, 'item.text is required')
    return upsertMemoryItem(item)
  },

  'memory.delete': (params) => {
    const memoryId = getStringParam(raw(params), 'id')
    if (!memoryId) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const current = getMemoryItem(memoryId)
    if (!current) return { ok: false }
    upsertMemoryItem({ ...current, active: false, updatedAt: new Date().toISOString() })
    return { ok: true }
  },

  'memory.sources': (params) => {
    const memoryId = getStringParam(raw(params), 'id')
    if (!memoryId) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const item = getMemoryItem(memoryId)
    const relatedSourceIds = item ? getMemoryItemSourceIds(item.id) : []
    const sourceIds = relatedSourceIds.length > 0 ? relatedSourceIds : (item ? sourceIdsForMemoryTags(item.tags) : [])
    return { sourceIds, messages: getSourceMessages(sourceIds) }
  },

  // --- Sense Debriefs ---
  'sense.memory': (params) => {
    const limit = getNumberParam(raw(params), 'limit') ?? 20
    const debriefs = listDebriefs({ limit })
    return { debriefs }
  },

  'sense.debrief': (params) => {
    const p = raw(params)
    const debriefId = getStringParam(p, 'id')
    const sessionId = getStringParam(p, 'sessionId')
    let debrief = null
    if (debriefId) debrief = getDebrief(debriefId)
    else if (sessionId) debrief = getDebriefBySession(sessionId)
    return debrief
  },

  'sense.deleteDebrief': (params) => {
    const debriefId = getStringParam(raw(params), 'id')
    if (!debriefId) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    const ok = deleteDebrief(debriefId)
    return { ok }
  },

  'sense.systemPromptPreview': (params) => {
    const editMode = getParam(raw(params), 'editMode') as EditMode | undefined
    const prompt = buildSystemPromptPreview({ editMode })
    return { prompt }
  },

  'sense.backfill': (params) => {
    const limit = getNumberParam(raw(params), 'limit') ?? 50
    backfillDebriefs(limit).then(result => {
      console.log(`[bond] backfill complete: ${result.generated} generated, ${result.skipped} skipped, ${result.failed} failed`)
    }).catch(err => {
      console.warn('[bond] backfill failed:', err.message)
    })
    return { ok: true, message: 'Backfill started in background' }
  },

  // --- Desk ---
  'desk.status': () => desk.getStatus(),

  'desk.setRunning': (params) => {
    const running = getBoolParam(raw(params), 'running')
    if (running === undefined) throw new RpcError(RPC_INVALID_PARAMS, 'running is required')
    // Materialize the worker FIRST — that is what registers the Sense state
    // provider, and without it the status returned here reports Sense disabled
    // on the very call that turns Desk on.
    const worker = getDeskWorker()
    if (running) worker.start()
    else worker.stop()
    return desk.setRunning(running)
  },

  'desk.blocks': (params) => {
    const p = raw(params)
    return desk.getBlocks({
      from: getStringParam(p, 'from'),
      to: getStringParam(p, 'to'),
      limit: getNumberParam(p, 'limit'),
    })
  },

  'desk.inFlight': (params) => {
    const p = raw(params)
    return desk.getInFlight({ since: getStringParam(p, 'since'), limit: getNumberParam(p, 'limit') })
  },

  'desk.threads': (params) => desk.getThreads(getBoolParam(raw(params), 'includeArchived') ?? false),

  'desk.createThread': (params) => {
    const name = getStringParam(raw(params), 'name')
    if (!name?.trim()) throw new RpcError(RPC_INVALID_PARAMS, 'name is required')
    return desk.createUserThread(name)
  },

  'desk.renameThread': (params) => {
    const p = raw(params)
    const id = getStringParam(p, 'id')
    const name = getStringParam(p, 'name')
    if (!id || !name?.trim()) throw new RpcError(RPC_INVALID_PARAMS, 'id and name are required')
    return desk.renameThread(id, name)
  },

  'desk.mergeThreads': (params) => {
    const p = raw(params)
    const targetId = getStringParam(p, 'targetId')
    const sourceId = getStringParam(p, 'sourceId')
    if (!targetId || !sourceId) throw new RpcError(RPC_INVALID_PARAMS, 'targetId and sourceId are required')
    return desk.mergeThreads(targetId, sourceId)
  },

  'desk.archiveThread': (params) => {
    const p = raw(params)
    const id = getStringParam(p, 'id')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    return desk.archiveThread(id, getBoolParam(p, 'archived') ?? true)
  },

  'desk.startBlock': (params) => {
    const threadId = getStringParam(raw(params), 'threadId')
    if (!threadId) throw new RpcError(RPC_INVALID_PARAMS, 'threadId is required')
    return desk.startBlock(threadId)
  },

  'desk.reassign': (params) => {
    const p = raw(params)
    const blockId = getStringParam(p, 'blockId')
    const threadId = getStringParam(p, 'threadId')
    if (!blockId || !threadId) throw new RpcError(RPC_INVALID_PARAMS, 'blockId and threadId are required')
    const confirmed = getParam(p, 'confirmedMatcher') as desk.ConfirmedMatcherInput | undefined
    return desk.reassignBlock({ blockId, threadId, confirmedMatcher: confirmed })
  },

  'desk.answer': (params) => {
    const p = raw(params)
    const questionId = getStringParam(p, 'questionId')
    const accepted = getBoolParam(p, 'accepted')
    if (!questionId || accepted === undefined) {
      throw new RpcError(RPC_INVALID_PARAMS, 'questionId and accepted are required')
    }
    return { ok: desk.answerQuestion(questionId, accepted) !== null }
  },

  'desk.updateNote': (params) => {
    const p = raw(params)
    const blockId = getStringParam(p, 'blockId')
    if (!blockId) throw new RpcError(RPC_INVALID_PARAMS, 'blockId is required')
    return desk.updateNote(blockId, getStringParam(p, 'note') ?? '')
  },

  'desk.matchers': (params) => desk.getMatchers(getBoolParam(raw(params), 'confirmedOnly') ?? true),

  'desk.disableMatcher': (params) => {
    const id = getStringParam(raw(params), 'id')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    return desk.disableMatcher(id)
  },

  'desk.deleteMatcher': (params) => {
    const id = getStringParam(raw(params), 'id')
    if (!id) throw new RpcError(RPC_INVALID_PARAMS, 'id is required')
    return { ok: desk.deleteMatcher(id) }
  },

  'desk.ensureToday': () => desk.getToday(),

  'desk.linkTodo': (params) => {
    const p = raw(params)
    const itemId = getStringParam(p, 'itemId')
    const threadId = getStringParam(p, 'threadId')
    if (!itemId || !threadId) throw new RpcError(RPC_INVALID_PARAMS, 'itemId and threadId are required')
    desk.linkTodoToThread(itemId, threadId)
    return { ok: true as const }
  },

  'desk.unlinkTodo': (params) => {
    const itemId = getStringParam(raw(params), 'itemId')
    if (!itemId) throw new RpcError(RPC_INVALID_PARAMS, 'itemId is required')
    return { ok: desk.unlinkTodoFromThread(itemId) }
  },

  'desk.carryTodo': (params) => {
    const itemId = getStringParam(raw(params), 'itemId')
    if (!itemId) throw new RpcError(RPC_INVALID_PARAMS, 'itemId is required')
    return desk.carryTodoForward(itemId)
  },

  'desk.stats': (params) => desk.getStats(getNumberParam(raw(params), 'windowHours')),
}

async function handleRequest(req: JsonRpcRequest, ws: WebSocket): Promise<string> {
  const handler = (handlers as unknown as Record<string, ((p: unknown, c: RpcContext) => unknown) | undefined>)[req.method]
  if (!handler) return JSON.stringify(makeErrorResponse(req.id, RPC_METHOD_NOT_FOUND, `Unknown method: ${req.method}`))
  try {
    const result = await handler(req.params, { ws })
    return JSON.stringify(makeResponse(req.id, result))
  } catch (e) {
    if (e instanceof RpcError) return JSON.stringify(makeErrorResponse(req.id, e.code, e.message, e.data))
    if (e instanceof CollectionValidationError) {
      return JSON.stringify(makeErrorResponse(req.id, RPC_VALIDATION_ERROR, e.message, { errors: e.errors }))
    }
    return JSON.stringify(makeErrorResponse(req.id, RPC_INTERNAL_ERROR, e instanceof Error ? e.message : String(e)))
  }
}

// --- Connection handling ---

/**
 * Wire a WebSocket into the JSON-RPC dispatch. Shared by every listener: the
 * unix-socket server passes the per-start daemon token, the remote LAN server
 * passes the persistent pairing token. Subscriber state is module-level, so
 * clients from any listener join the same broadcast pools.
 */
export function attachConnection(
  ws: WebSocket,
  expectedToken?: string,
  /**
   * Second chance for a token the shared secret doesn't match — the remote
   * listener passes the per-device credential check here, so a paired Home
   * Screen app authenticates without ever seeing `remote.token`.
   */
  acceptToken?: (token: string) => boolean,
): void {
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
        if (token === expectedToken || (typeof token === 'string' && acceptToken?.(token))) {
          authenticatedClients.add(ws)
          // Version rides the handshake so clients can hard-fail on skew
          // instead of dying per-call on Unknown method.
          ws.send(JSON.stringify(makeResponse(msg.id, { ok: true, protocolVersion: PROTOCOL_VERSION })))
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

  // A daemon death mid-turn leaves turns 'running' and their activity rows
  // pulsing "Working…" forever — finish them as cancelled before serving.
  try {
    const reconciled = reconcileInterruptedTurns()
    if (reconciled) console.log(`[bond-daemon] reconciled ${reconciled} interrupted turn(s) from a previous run`)
  } catch (error) {
    console.warn('[bond-daemon] turn reconciliation failed:', error)
  }

  // Eagerly initialize Sense controller so it auto-enables on daemon startup
  getSenseController()

  // The turn runner broadcasts and touches Sense through this seam.
  setTurnTransport({
    broadcastChunk,
    imagesChanged: broadcastImageChanged,
    enableSense: () => {
      const ctrl = getSenseController()
      ctrl.enable()
      setSenseSettings(ctrl.getSettings())
      return { enabled: ctrl.getSettings().enabled, state: ctrl.getState() }
    },
  })

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
      abortActiveTurnForShutdown()
      setTurnTransport(null)
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
