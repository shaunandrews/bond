/// <reference types="vite/client" />
import { ref, computed } from 'vue'
import type { BondSendInput, TaggedChunk } from '../../shared/stream'
import type { BondSendResult } from '../../shared/rpc-schema'
import type { AttachedImage, EditMode, SessionMessage } from '../../shared/session'
import type { QuestionAnswer } from '../../shared/questions'
import type { TranscriptMessage, TranscriptPage } from '../../shared/transcript'
import { MAIN_SCOPE, scopesEqual, scopeToThreadId, threadScope, type ConversationScope } from '../../shared/threads'
import type { Message } from '../types/message'
import type { TurnActivityData, TurnActivityEvent } from '../types/activity'
import { formatToolLabel } from '../lib/format'

const TRANSCRIPT_PAGE_SIZE = 80
const TRANSCRIPT_BACKUP_KEY = 'bond:transcript-tail-backup'
const TRANSCRIPT_BACKUP_LIMIT = 100

export interface QueuedMessage {
  id: string
  text: string
  images?: AttachedImage[]
}

export interface ChatDeps {
  send: ((input: BondSendInput) => Promise<BondSendResult>) & ((text: string, sessionId?: string, images?: AttachedImage[]) => Promise<BondSendResult>)
  cancel: (sessionId?: string, scope?: ConversationScope) => Promise<{ ok: boolean }>
  onChunk: (fn: (chunk: TaggedChunk) => void) => () => void
  respondToApproval: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>
  answerQuestion: (questionId: string, answer: QuestionAnswer) => Promise<{ ok: boolean }>
  getImages: (ids: string[]) => Promise<(AttachedImage | null)[]>
  listTranscript: (options?: { beforeSeq?: number; limit?: number }) => Promise<TranscriptPage>
  upsertTranscript: (messages: TranscriptMessage[]) => Promise<{ ok: boolean }>
  createSession?: (options?: { title?: string }) => Promise<{ id: string }>
  subscribe?: (sessionId?: string, scope?: ConversationScope) => Promise<{ ok: boolean }>
  unsubscribe?: (sessionId?: string, scope?: ConversationScope) => Promise<{ ok: boolean }>
  /** Desktop-only: reveal the Desk notch panel. The web shim no-ops. */
  openDesk?: (opts?: { queued?: boolean }) => Promise<{ opened: boolean; reason?: string }>
  // Legacy deps retained so older component tests can supply partial window.bond mocks.
  getMessages?: (sessionId: string) => Promise<SessionMessage[]>
  saveMessages?: (sessionId: string, messages: SessionMessage[]) => Promise<boolean>
}

export interface UseChatOptions {
  /** Omitted means the main conversation. A thread instance passes its own scope. */
  scope?: ConversationScope
  /**
   * Namespaces HMR state and the localStorage recovery stash so two live
   * instances (main + an open thread) never clobber each other's. Omitted
   * (main) keeps the exact existing keys — changing them would orphan
   * everyone's current backup.
   */
  namespace?: string
}

function uid(): string {
  // crypto.randomUUID only exists in secure contexts — the remote web client
  // is served over plain http on a LAN IP, where calling it throws and killed
  // submit() before the message rendered. getRandomValues works everywhere.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Electron IPC cannot clone Vue reactive proxies. Build plain JSON payloads. */
function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function plainImages(images?: AttachedImage[]): AttachedImage[] | undefined {
  return images?.map(image => ({ data: image.data, mediaType: image.mediaType }))
}

function plainEditMode(mode: EditMode): EditMode {
  if (mode.type === 'scoped') return { type: 'scoped', allowedPaths: [...mode.allowedPaths] }
  return { type: mode.type }
}

function toTranscriptMessage(m: Message, threadId?: string | null): TranscriptMessage {
  const base = { id: m.id, role: m.role === 'bond' ? 'bond' as const : m.role, threadId, createdAt: m.ts ? new Date(m.ts).toISOString() : undefined, updatedAt: nowIso() }
  if (m.role === 'user') return { ...base, role: 'user', text: m.text, images: plainImages(m.images), imageIds: m.imageIds ? [...m.imageIds] : undefined }
  if (m.role === 'bond') return { ...base, role: 'bond', text: m.text }
  if (m.kind === 'activity') return { ...base, role: 'meta', kind: 'activity', data: plainJson(m.data) as unknown as Record<string, unknown> }
  if (m.kind === 'image') return { ...base, role: 'meta', kind: 'image', imageIds: [...m.imageIds], data: m.alt ? { alt: m.alt } : undefined }
  if (m.kind === 'tool') return { ...base, role: 'meta', kind: 'tool', text: m.summary ?? null, data: { name: m.name, summary: m.summary } }
  if (m.kind === 'skill') return { ...base, role: 'meta', kind: 'skill', text: m.args ?? null, data: { name: m.name, args: m.args } }
  if (m.kind === 'thinking') return { ...base, role: 'meta', kind: 'thinking', text: m.text, data: { durationSec: m.durationSec } }
  if (m.kind === 'approval') return { ...base, role: 'meta', kind: 'approval', text: m.description ?? null, data: plainJson(m) as unknown as Record<string, unknown> }
  if (m.kind === 'error') return { ...base, role: 'meta', kind: 'error', text: m.text }
  return { ...base, role: 'meta', kind: 'system', text: m.text }
}

function fromTranscriptMessage(m: TranscriptMessage): Message | null {
  const ts = m.createdAt ? Date.parse(m.createdAt) : undefined
  if (m.role === 'user') return { id: m.id, role: 'user', text: m.text ?? '', images: m.images, imageIds: m.imageIds, ts }
  if (m.role === 'bond') return { id: m.id, role: 'bond', text: m.text ?? '', streaming: false, ts }
  if (m.kind === 'activity' && m.data) return { id: m.id, role: 'meta', kind: 'activity', data: m.data as unknown as TurnActivityData, ts }
  if (m.kind === 'image') return { id: m.id, role: 'meta', kind: 'image', imageIds: m.imageIds ?? [], images: m.images, alt: typeof m.data?.alt === 'string' ? m.data.alt : undefined, ts }
  if (m.kind === 'tool') return { id: m.id, role: 'meta', kind: 'tool', name: String(m.data?.name ?? ''), summary: m.text ?? String(m.data?.summary ?? ''), ts }
  if (m.kind === 'skill') return { id: m.id, role: 'meta', kind: 'skill', name: String(m.data?.name ?? ''), args: m.text ?? String(m.data?.args ?? ''), ts }
  if (m.kind === 'thinking') {
    if (!m.text?.trim()) return null
    return { id: m.id, role: 'meta', kind: 'thinking', text: m.text, durationSec: typeof m.data?.durationSec === 'number' ? m.data.durationSec : undefined, streaming: false, ts }
  }
  if (m.kind === 'approval' && m.data) return { ...(m.data as unknown as Extract<Message, { role: 'meta'; kind: 'approval' }>), id: m.id, ts }
  if (m.kind === 'error') return { id: m.id, role: 'meta', kind: 'error', text: m.text ?? '', ts }
  return { id: m.id, role: 'meta', kind: 'system', text: m.text ?? '', ts }
}

type HmrSlot = { messages?: Message[]; busy?: boolean; queuedMessages?: QueuedMessage[]; transportSessionId?: string | null; nextBeforeSeq?: number | null; hasLoaded?: boolean; activeTurnId?: string | null; activeActivityId?: string | null; dirtyIds?: string[] }

/**
 * One conversation instance = one namespaced slot. A flat module-level
 * constant here would let every instance (main + however many open threads)
 * read and overwrite the SAME slot — losing turn ownership across whichever
 * one hot-reloaded last.
 */
function hmrSlot(namespace: string): HmrSlot | undefined {
  if (!import.meta.hot?.data) return undefined
  const data = import.meta.hot.data as Record<string, HmrSlot>
  return (data[`chat:${namespace}`] ??= {})
}

/** Chunk kinds owned by a single turn — anything here from a foreign turnId is a straggler. */
const TURN_SCOPED_CHUNKS: ReadonlySet<string> = new Set([
  'query_start', 'query_end', 'assistant_text', 'thinking_text', 'assistant_tool',
  'tool_result', 'tool_approval', 'user_question', 'raw_error', 'result', 'generated_image', 'system',
])

export function useChat(deps: ChatDeps = window.bond, options: UseChatOptions = {}) {
  const myScope = options.scope ?? MAIN_SCOPE
  const myThreadId = scopeToThreadId(myScope)
  const namespace = options.namespace ?? 'main'
  const backupKey = options.namespace ? `${TRANSCRIPT_BACKUP_KEY}:${options.namespace}` : TRANSCRIPT_BACKUP_KEY
  const _hmr = hmrSlot(namespace)

  const messages = ref<Message[]>(_hmr?.messages ?? [])
  const busy = ref(!!_hmr?.busy)
  const queuedMessages = ref<QueuedMessage[]>(_hmr?.queuedMessages ?? [])
  const currentSessionId = ref<string | null>(_hmr?.transportSessionId ?? null)
  const nextBeforeSeq = ref<number | null>(_hmr?.nextBeforeSeq ?? null)
  const hasLoadedTranscript = ref(!!_hmr?.hasLoaded)
  const contextUsage = ref<{ inputTokens: number; contextWindow: number; costUsd: number }>({ inputTokens: 0, contextWindow: 0, costUsd: 0 })
  const editMode = ref<EditMode>({ type: 'full' })

  // Turn ownership must survive HMR: a turn that edits renderer source
  // hot-reloads this module mid-stream, and losing activeTurnId here made
  // handleChunk drop every remaining chunk of the still-running turn.
  const activeActivityId = ref<string | null>(_hmr?.activeActivityId ?? null)
  const activeTurnId = ref<string | null>(_hmr?.activeTurnId ?? null)
  const activityRevision = ref(0)
  const currentQueue = computed(() => queuedMessages.value)
  const busySessionIds = computed(() => currentSessionId.value && busy.value ? new Set([currentSessionId.value]) : new Set<string>())
  const queryEndCallbacks: Array<(sessionId: string) => void> = []

  let unsub: (() => void) | undefined
  let globalSubscribed = false
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let lastPersistPromise: Promise<unknown> = Promise.resolve()
  let queueDrainPromise: Promise<void> | null = null
  let cancellingTurnId: string | null = null
  // Rows this window actually mutated. Persistence only ever pushes these —
  // bulk-pushing the whole transcript let one stale row anywhere become
  // corruption everywhere.
  const dirtyIds = new Set<string>(_hmr?.dirtyIds ?? [])

  const pendingApprovals = computed(() => {
    activityRevision.value
    const found = new Map<string, Extract<TurnActivityEvent, { type: 'approval' }> & { activityMessageId: string; sessionId: string }>()
    const sid = currentSessionId.value ?? 'continuous'
    for (const m of messages.value) {
      if (m.role !== 'meta' || m.kind !== 'activity') continue
      for (const evt of m.data.events) {
        if (evt.type === 'approval' && evt.status === 'pending') found.set(evt.requestId, { ...evt, activityMessageId: m.id, sessionId: sid })
      }
    }
    return [...found.values()]
  })

  // Singular by design — the ask_user_question tool runs sequentially and
  // Bond asks at most one question at a time. Traversal order (messages,
  // then events, both append-only) means the last match found is the most
  // recent one.
  const pendingQuestion = computed(() => {
    activityRevision.value
    let found: (Extract<TurnActivityEvent, { type: 'question' }> & { activityMessageId: string }) | null = null
    for (const m of messages.value) {
      if (m.role !== 'meta' || m.kind !== 'activity') continue
      for (const evt of m.data.events) {
        if (evt.type === 'question' && evt.status === 'pending') found = { ...evt, activityMessageId: m.id }
      }
    }
    return found
  })

  function addMessage(msg: Message) {
    if (!msg.ts) msg.ts = Date.now()
    messages.value.push(msg)
    dirtyIds.add(msg.id)
  }

  function upsertMessage(msg: Message): Promise<boolean> {
    return upsertMessages([msg])
  }

  function upsertMessages(msgs: Message[]): Promise<boolean> {
    const payload = msgs.map(m => toTranscriptMessage({ ...m }, myThreadId))
    const promise = (async () => {
      try {
        const res = await deps.upsertTranscript(payload)
        if (!res.ok) throw new Error('transcript.upsert failed')
        return true
      } catch (err) {
        console.warn('[bond] transcript upsert failed — data is in renderer memory only', err)
        stashToLocalStorage()
        return false
      }
    })()
    lastPersistPromise = promise
    return promise
  }

  function schedulePersist() {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistMessages()
    }, 2000)
  }

  async function persistMessages() {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (!messages.value.length || dirtyIds.size === 0) return
    const batch = messages.value.filter(m => dirtyIds.has(m.id))
    // Dirt for rows no longer in the window (reload, pagination trim) is
    // unrecoverable — drop it rather than carrying it forever.
    dirtyIds.clear()
    if (!batch.length) return
    const ok = await upsertMessages(batch)
    // Failed pushes stay dirty for the next flush; markers re-added during
    // the await (fresh mutations) are preserved either way.
    if (!ok) for (const m of batch) dirtyIds.add(m.id)
  }

  function existingActivity(): (Message & { role: 'meta'; kind: 'activity' }) | undefined {
    const byId = activeActivityId.value ? messages.value.find(m => m.id === activeActivityId.value && m.role === 'meta' && m.kind === 'activity') : undefined
    if (byId && byId.role === 'meta' && byId.kind === 'activity') return byId
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.role === 'meta' && m.kind === 'activity' && ['working', 'responding', 'awaiting_approval', 'awaiting_question'].includes(m.data.status)) {
        activeActivityId.value = m.id
        return m
      }
    }
  }

  function activityFor(): Message & { role: 'meta'; kind: 'activity' } {
    const existing = existingActivity()
    if (existing) return existing
    // Carry the live turn's id when there is one — a continuation row minted
    // mid-turn (see splitActivityAfterAnswer) must belong to that turn, or
    // query_end and the daemon's finalizer can't find it.
    const data: TurnActivityData = { turnId: activeTurnId.value ?? uid(), status: 'working', startedAt: Date.now(), events: [] }
    const msg: Message & { role: 'meta'; kind: 'activity' } = { id: uid(), role: 'meta', kind: 'activity', data, ts: data.startedAt }
    addMessage(msg)
    activeActivityId.value = msg.id
    return msg
  }

  function updateActivity(updater: (data: TurnActivityData) => void) {
    const msg = activityFor()
    updater(msg.data)
    dirtyIds.add(msg.id)
    activityRevision.value++
    schedulePersist()
  }

  function finalizeOpenActivityEvents(data: TurnActivityData, end = Date.now()) {
    for (const evt of data.events) if ((evt.type === 'thinking' || evt.type === 'tool' || evt.type === 'responding') && evt.endTs == null) evt.endTs = end
  }

  function cancelPendingApprovals(data: TurnActivityData, end = Date.now()) {
    for (const evt of data.events) if (evt.type === 'approval' && evt.status === 'pending') { evt.status = 'cancelled'; evt.endTs = end }
  }

  function cancelPendingQuestions(data: TurnActivityData, end = Date.now()) {
    for (const evt of data.events) if (evt.type === 'question' && evt.status === 'pending') { evt.status = 'cancelled'; evt.endTs = end }
  }

  /**
   * An answered question reads like a message the user sent — the option
   * label or typed text appears as a normal user bubble in the flow of the
   * conversation, not just inside the (often-collapsed) activity row. A
   * dismissal has nothing to show: the question card already reflects it.
   *
   * The row id is DERIVED from the questionId, never minted: the daemon
   * broadcasts question_resolved to every client including the answering one
   * (and that notification beats the RPC ack down the same socket), so the
   * answerer ran this twice and every other client once more — three separate
   * uids, three persisted rows, one answer. A derived id makes each of those
   * paths write the same row.
   */
  function appendAnswerMessage(questionId: string, answer: QuestionAnswer) {
    if (answer.kind === 'cancelled') return
    const id = `answer-${questionId}`
    if (messages.value.some(m => m.id === id)) return
    const msg: Message = { id, role: 'user', text: answer.kind === 'option' ? answer.label : answer.text }
    addMessage(msg)
    upsertMessage(msg)
  }

  /**
   * The answer bubble lands at the END of the transcript, but the turn's
   * activity row was inserted at turn start — leaving the live row stranded
   * above it, so a still-working turn read as dead. Close the row here and
   * let the next chunk mint a continuation row (same turnId) after the
   * answer, keeping the live row last. Order survives reload: rows are
   * ordered by insert seq, which is the order they're written in.
   */
  function splitActivityAfterAnswer(activityMessageId: string, answer: QuestionAnswer) {
    // A dismissal appends no bubble, so the row is still the last thing on
    // screen — nothing to split around.
    if (answer.kind === 'cancelled') return
    if (!busy.value || activeActivityId.value !== activityMessageId) return
    const msg = messages.value.find(m => m.id === activityMessageId)
    if (!msg || msg.role !== 'meta' || msg.kind !== 'activity') return
    const endedAt = Date.now()
    finalizeOpenActivityEvents(msg.data, endedAt)
    msg.data.status = 'done'
    msg.data.endedAt = endedAt
    activeActivityId.value = null
    activityRevision.value++
    dirtyIds.add(msg.id)
    upsertMessage(msg)
  }

  function lastActivityEvent(data: TurnActivityData): TurnActivityEvent | undefined {
    return data.events[data.events.length - 1]
  }

  function endStreaming() {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const msg = messages.value[i]
      if (msg.role === 'bond' && msg.streaming) { msg.streaming = false; dirtyIds.add(msg.id); return }
    }
  }

  function handleChunk(chunk: TaggedChunk) {
    // The global edit mode is a truly unscoped event — every instance (main
    // and every open thread) mirrors it regardless of which scope's turn (if
    // any) changed it, so it must bypass the per-scope gate below entirely.
    if (chunk.kind === 'edit_mode_changed') {
      editMode.value = chunk.editMode
      return
    }

    // The worker inserts completion off-turn before broadcasting this marker.
    // Reloading from the daemon gives every live main-conversation client the
    // same durable card; reconnect follows the same transcript-load path.
    if (chunk.kind === 'agent_run_changed') {
      if (myScope.type === 'main' && chunk.run.completionMessageId) {
        void loadTranscript().catch(error => console.warn('[bond] agent completion reconciliation failed:', error))
      }
      return
    }

    // One useChat instance is exactly one conversation scope (main, or one
    // thread). The old sessionId check below is a no-op whenever
    // currentSessionId is null (the common continuous-Bond case), which
    // would let another scope's turn_start inject a fake user message here.
    // Every conversation-scoped chunk carries `scope` explicitly now; reject
    // anything that isn't this instance's own.
    if (!scopesEqual(chunk.scope ?? MAIN_SCOPE, myScope)) return
    if (currentSessionId.value && chunk.sessionId && chunk.sessionId !== currentSessionId.value) return

    if (chunk.kind === 'turn_start') {
      activeTurnId.value = chunk.turnId
      // A turn started on another client (desktop vs. phone). Mirror its user
      // message and activity row under the sender's ids so both transcripts
      // stay one set of rows; the sender itself already has them — dedupe.
      if (!messages.value.some(m => m.id === chunk.userMessageId)) {
        busy.value = true
        addMessage({ id: chunk.userMessageId, role: 'user', text: chunk.text, ...(chunk.imageIds?.length ? { imageIds: chunk.imageIds } : {}) })
        const data: TurnActivityData = { turnId: chunk.turnId, userMessageId: chunk.userMessageId, assistantMessageId: chunk.assistantMessageId, status: 'working', startedAt: Date.now(), events: [] }
        addMessage({ id: chunk.activityMessageId, role: 'meta', kind: 'activity', data, ts: data.startedAt })
        activeActivityId.value = chunk.activityMessageId
        if (chunk.imageIds?.length) {
          const live = messages.value.find(m => m.id === chunk.userMessageId)
          if (live) void resolveImages([live]).catch(() => {})
        }
      }
      return
    }

    if (chunk.kind === 'approval_resolved') {
      // Answered elsewhere (possibly another client) — flip our pending
      // prompt instead of leaving it stale until query_end.
      for (const m of messages.value) {
        if (m.role !== 'meta' || m.kind !== 'activity') continue
        const evt = m.data.events.find((e): e is Extract<TurnActivityEvent, { type: 'approval' }> => e.type === 'approval' && e.requestId === chunk.requestId)
        if (!evt || evt.status !== 'pending') continue
        evt.status = chunk.approved ? 'approved' : 'denied'
        evt.endTs = Date.now()
        const stillPending = m.data.events.some(e => e.type === 'approval' && e.status === 'pending')
        if (m.data.status === 'awaiting_approval' && !stillPending) m.data.status = 'working'
        activityRevision.value++
      }
      return
    }

    if (chunk.kind === 'question_resolved') {
      // Answered elsewhere (possibly another client or the CLI) — flip our
      // pending card instead of leaving it stale until query_end.
      for (const m of messages.value) {
        if (m.role !== 'meta' || m.kind !== 'activity') continue
        const evt = m.data.events.find((e): e is Extract<TurnActivityEvent, { type: 'question' }> => e.type === 'question' && e.questionId === chunk.questionId)
        if (!evt || evt.status !== 'pending') continue
        evt.status = chunk.answer.kind === 'cancelled' ? 'cancelled' : 'answered'
        evt.answer = chunk.answer
        evt.endTs = Date.now()
        const stillPending = m.data.events.some(e => e.type === 'question' && e.status === 'pending')
        if (m.data.status === 'awaiting_question' && !stillPending) m.data.status = 'working'
        activityRevision.value++
        appendAnswerMessage(chunk.questionId, chunk.answer)
        splitActivityAfterAnswer(m.id, chunk.answer)
      }
      return
    }

    // Drop stragglers from a turn we no longer own — an in-flight chunk can
    // race a cancel, and without this guard activityFor() mints an orphan
    // "Working" row for the dead turn that then gets persisted. Untagged
    // chunks pass for back-compat; cross-turn kinds are handled above.
    if (chunk.turnId && chunk.turnId !== activeTurnId.value && TURN_SCOPED_CHUNKS.has(chunk.kind)) return
    // Keep ownership until query_end so the terminal chunk is accepted, but
    // discard late output from a turn the user has already stopped.
    if (cancellingTurnId && chunk.turnId === cancellingTurnId && chunk.kind !== 'query_end') return

    if (chunk.kind === 'query_start') {
      busy.value = true
      updateActivity(data => { data.status = 'working'; data.startedAt ||= Date.now() })
      return
    }

    if (chunk.kind === 'query_end') {
      busy.value = false
      activeTurnId.value = null
      const endedAt = Date.now()
      const activityMsg = existingActivity()
      if (activityMsg) {
        finalizeOpenActivityEvents(activityMsg.data, endedAt)
        cancelPendingApprovals(activityMsg.data, endedAt)
        cancelPendingQuestions(activityMsg.data, endedAt)
        activityMsg.data.status = cancellingTurnId ? 'cancelled' : (!chunk.succeeded || activityMsg.data.status === 'failed' ? 'failed' : 'done')
        activityMsg.data.endedAt = endedAt
        if (activityMsg.data.status === 'failed') activityMsg.data.expanded = true
        activityRevision.value++
      }
      activeActivityId.value = null
      cancellingTurnId = null
      endStreaming()
      const sid = currentSessionId.value || chunk.sessionId || 'continuous'
      const endPromise = drainNextQueuedMessage()
      lastPersistPromise = endPromise
      queryEndCallbacks.forEach(fn => fn(sid))
      return
    }

    if (chunk.kind === 'thinking_text') {
      updateActivity(data => {
        const last = lastActivityEvent(data)
        if (last?.type === 'thinking' && last.endTs == null) last.text += chunk.text
        else data.events.push({ id: uid(), type: 'thinking', label: 'Thinking', ts: Date.now(), text: chunk.text })
        data.status = 'working'
      })
      return
    }

    switch (chunk.kind) {
      case 'usage_update':
        contextUsage.value = { inputTokens: chunk.inputTokens, contextWindow: chunk.contextWindow, costUsd: chunk.costUsd }
        return
      case 'assistant_text': {
        updateActivity(data => {
          const last = lastActivityEvent(data)
          if (last?.type !== 'responding' || last.endTs != null) {
            finalizeOpenActivityEvents(data)
            data.events.push({ id: uid(), type: 'responding', label: 'Responding', ts: Date.now() })
          }
          data.status = 'responding'
        })
        const last = messages.value[messages.value.length - 1]
        if (last?.role === 'bond' && last.streaming) { last.text += chunk.text; dirtyIds.add(last.id) }
        else addMessage({ id: chunk.assistantMessageId ?? uid(), role: 'bond', text: chunk.text, streaming: true })
        schedulePersist()
        break
      }
      case 'assistant_tool':
        updateActivity(data => { finalizeOpenActivityEvents(data); data.status = 'working'; data.events.push({ id: uid(), type: 'tool', label: formatToolLabel(chunk.name, chunk.summary, chunk.input), ts: Date.now(), toolUseId: chunk.toolUseId, toolName: chunk.name, input: chunk.input }) })
        break
      case 'tool_result':
        updateActivity(data => {
          const now = Date.now()
          const ev = chunk.toolUseId ? [...data.events].reverse().find(evt => evt.type === 'tool' && evt.toolUseId === chunk.toolUseId) : [...data.events].reverse().find(evt => evt.type === 'tool' && !evt.output)
          if (ev?.type === 'tool') { ev.output = chunk.output; ev.endTs = now; ev.failed = chunk.isError; if (chunk.isError) data.expanded = true }
        })
        break
      case 'generated_image': {
        addMessage({ id: uid(), role: 'meta', kind: 'image', imageIds: [...chunk.imageIds], alt: chunk.alt })
        schedulePersist()
        // The daemon already persisted the files; fetch base64 for display.
        // Resolve onto the reactive proxy from the messages array — assigning
        // to the raw object updates silently and the bubble keeps showing the
        // loading placeholder forever.
        const live = messages.value[messages.value.length - 1]
        void resolveImages([live]).catch(() => {})
        break
      }
      case 'tool_approval':
        updateActivity(data => {
          if (data.events.some(evt => evt.type === 'approval' && evt.requestId === chunk.requestId)) return
          finalizeOpenActivityEvents(data)
          data.status = 'awaiting_approval'
          data.expanded = true
          data.events.push({ id: uid(), type: 'approval', label: `Approval requested: ${chunk.toolName}`, ts: Date.now(), requestId: chunk.requestId, toolName: chunk.toolName, input: chunk.input, title: chunk.title, description: chunk.description, status: 'pending' })
        })
        break
      case 'user_question':
        updateActivity(data => {
          if (data.events.some(evt => evt.type === 'question' && evt.questionId === chunk.questionId)) return
          finalizeOpenActivityEvents(data)
          data.status = 'awaiting_question'
          data.expanded = true
          data.events.push({ id: uid(), type: 'question', label: `Question asked`, ts: Date.now(), questionId: chunk.questionId, question: chunk.question, header: chunk.header, options: chunk.options, status: 'pending' })
        })
        break
      case 'result': {
        endStreaming()
        if (chunk.errors?.length) {
          const text = chunk.errors.join('; ')
          updateActivity(data => { data.status = 'failed'; data.expanded = true; data.events.push({ id: uid(), type: 'error', label: 'Error', ts: Date.now(), text }) })
          addMessage({ id: uid(), role: 'meta', kind: 'error', text })
        } else if (chunk.result) {
          const last = messages.value[messages.value.length - 1]
          if (!last || last.role !== 'bond') addMessage({ id: uid(), role: 'bond', text: chunk.result, streaming: false })
        }
        persistMessages()
        break
      }
      case 'raw_error':
        endStreaming()
        updateActivity(data => { data.status = 'failed'; data.expanded = true; data.endedAt = Date.now(); cancelPendingApprovals(data, data.endedAt); cancelPendingQuestions(data, data.endedAt); data.events.push({ id: uid(), type: 'error', label: 'Error', ts: Date.now(), text: chunk.message }) })
        addMessage({ id: uid(), role: 'meta', kind: 'error', text: chunk.message })
        persistMessages()
        break
      case 'system':
        addMessage({ id: uid(), role: 'meta', kind: 'system', text: chunk.text ?? chunk.subtype })
        schedulePersist()
        break
      case 'show_panel':
        // UI side-effect, not transcript content: App opens the panel.
        window.dispatchEvent(new CustomEvent('bond:show-panel', { detail: chunk.panel }))
        break
      case 'open_desk':
        // Desk is a separate non-activating window owned by main, not a side
        // panel — so this dispatches straight through preload rather than
        // through App's panel router. `queued` means back-fill is still
        // catching up; main waits rather than opening an empty panel.
        deps.openDesk?.({ queued: chunk.queued })
        break
    }
  }

  /**
   * A window that (re)loads while a turn is running never saw that turn's
   * turn_start, so the straggler guard in handleChunk would drop its every
   * chunk — including query_end, freezing the activity row forever. The
   * persisted row carries the turnId: adopt it so the stream keeps flowing.
   * If the turn is actually dead (daemon crashed mid-turn), stop/cancel
   * persists the row as cancelled and the next load comes up clean.
   */
  function adoptLiveTurnFromTranscript() {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.role !== 'meta' || m.kind !== 'activity') continue
      if (['working', 'responding', 'awaiting_approval', 'awaiting_question'].includes(m.data.status) && m.data.turnId) {
        activeTurnId.value = m.data.turnId
        activeActivityId.value = m.id
        busy.value = true
      }
      return
    }
  }

  async function loadTranscript(options: { beforeSeq?: number; limit?: number; append?: boolean } = {}) {
    await lastPersistPromise.catch(() => {})
    const page = await deps.listTranscript({ beforeSeq: options.beforeSeq, limit: options.limit ?? TRANSCRIPT_PAGE_SIZE })
    const loaded = page.messages.map(fromTranscriptMessage).filter((m): m is Message => m !== null)
    await resolveImages(loaded)
    messages.value = options.append ? [...loaded, ...messages.value] : loaded
    nextBeforeSeq.value = page.nextBeforeSeq
    hasLoadedTranscript.value = true
    if (!options.append) {
      // Memory now mirrors the store — nothing is dirty anymore.
      dirtyIds.clear()
      adoptLiveTurnFromTranscript()
    }
    return page
  }

  async function loadOlder() {
    if (nextBeforeSeq.value == null) return null
    return loadTranscript({ beforeSeq: nextBeforeSeq.value, append: true })
  }

  function hasResolvableImages(m: Message): m is Message & { imageIds?: string[]; images?: AttachedImage[] } {
    return m.role === 'user' || (m.role === 'meta' && m.kind === 'image')
  }

  async function resolveImages(target: Message[]) {
    const allIds = target.flatMap(m => hasResolvableImages(m) ? (m.imageIds ?? []) : [])
    if (!allIds.length) return
    const loaded = await deps.getImages(allIds)
    const map = new Map<string, AttachedImage>()
    allIds.forEach((id, i) => { if (loaded[i]) map.set(id, loaded[i]!) })
    for (const msg of target) if (hasResolvableImages(msg) && msg.imageIds?.length) msg.images = msg.imageIds.map(id => map.get(id)!).filter(Boolean)
  }

  async function ensureGlobalSubscription() {
    if (globalSubscribed) return
    await deps.subscribe?.(undefined, myScope)
    globalSubscribed = true
  }

  async function init() {
    await ensureGlobalSubscription()
    if (!hasLoadedTranscript.value) await loadTranscript()
  }

  async function loadSession(sessionId: string) {
    currentSessionId.value = sessionId
    deps.subscribe?.(sessionId).catch(() => {})
    if (!hasLoadedTranscript.value) await loadTranscript()
  }

  function clearMessages() {
    messages.value = []
    dirtyIds.clear()
    nextBeforeSeq.value = null
    hasLoadedTranscript.value = false
  }

  async function submit(text: string, images?: AttachedImage[]) {
    const trimmed = text.trim()
    if (!trimmed && !images?.length) return
    // Non-fatal: bond.send subscribes the sender daemon-side anyway, and a
    // transient transport failure here must not silently swallow the message
    // before it even renders — let send() fail visibly instead.
    await ensureGlobalSubscription().catch(() => {})

    // A pending question intercepts plain text as its answer — it never
    // starts a new turn or joins the queue. Images alongside text fall
    // through: an image is not an answer to a multiple-choice question.
    const question = pendingQuestion.value
    if (question && trimmed && !images?.length) {
      await answerQuestion(question.questionId, { kind: 'custom', text: trimmed })
      return
    }

    if (busy.value) {
      queuedMessages.value = [...queuedMessages.value, { id: uid(), text: trimmed, images: images?.length ? images : undefined }]
      return
    }

    const turnId = uid()
    activeTurnId.value = turnId
    const userMessageId = uid()
    const assistantMessageId = uid()
    const activityMessageId = uid()
    addMessage({ id: userMessageId, role: 'user', text: trimmed, images: images?.length ? images : undefined })
    const activityData: TurnActivityData = { turnId, userMessageId, assistantMessageId, status: 'working', startedAt: Date.now(), events: [] }
    const activityMsg: Message & { role: 'meta'; kind: 'activity' } = { id: activityMessageId, role: 'meta', kind: 'activity', data: activityData, ts: activityData.startedAt }
    addMessage(activityMsg)
    activeActivityId.value = activityMsg.id

    const skillMatch = trimmed.match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/s)
    if (skillMatch) addMessage({ id: uid(), role: 'meta', kind: 'skill', name: skillMatch[1], args: skillMatch[2] })
    busy.value = true

    try {
      const input: BondSendInput = { scope: myScope, text: trimmed, images: plainImages(images), turnId, userMessageId, assistantMessageId, activityMessageId, editMode: plainEditMode(editMode.value) }
      const res = await deps.send(input)
      if (res.ok && res.imageIds?.length) {
        for (let i = messages.value.length - 1; i >= 0; i--) {
          const m = messages.value[i]
          if (m.role === 'user' && m.id === userMessageId) { m.imageIds = res.imageIds; break }
        }
        await upsertMessage(messages.value.find(m => m.id === userMessageId)!)
      }
    } catch (error) {
      busy.value = false
      activeTurnId.value = null
      const detail = error instanceof Error ? error.message : String(error)
      console.error('[bond] send failed:', error)
      updateActivity(data => { data.status = 'failed'; data.expanded = true; data.endedAt = Date.now(); data.events.push({ id: uid(), type: 'error', label: 'Error', ts: Date.now(), text: detail || 'Send failed' }) })
      activeActivityId.value = null
      endStreaming()
      await persistMessages()
    }
  }

  async function respondToApproval(requestId: string, approved: boolean) {
    let match: { message: Message & { role: 'meta'; kind: 'activity' }; event: Extract<TurnActivityEvent, { type: 'approval' }> } | undefined
    for (const m of messages.value) {
      if (m.role !== 'meta' || m.kind !== 'activity') continue
      const evt = m.data.events.find((e): e is Extract<TurnActivityEvent, { type: 'approval' }> => e.type === 'approval' && e.requestId === requestId)
      if (evt) match = { message: m, event: evt }
    }
    if (!match) return
    try {
      const result = await deps.respondToApproval(requestId, approved)
      if (!result.ok) return
    } catch { return }
    match.event.status = approved ? 'approved' : 'denied'
    match.event.endTs = Date.now()
    const stillPending = match.message.data.events.some(e => e.type === 'approval' && e.status === 'pending')
    if (match.message.data.status === 'awaiting_approval' && !stillPending) match.message.data.status = 'working'
    activityRevision.value++
    dirtyIds.add(match.message.id)
    upsertMessage(match.message)
  }

  async function answerQuestion(questionId: string, answer: QuestionAnswer) {
    let match: { message: Message & { role: 'meta'; kind: 'activity' }; event: Extract<TurnActivityEvent, { type: 'question' }> } | undefined
    for (const m of messages.value) {
      if (m.role !== 'meta' || m.kind !== 'activity') continue
      const evt = m.data.events.find((e): e is Extract<TurnActivityEvent, { type: 'question' }> => e.type === 'question' && e.questionId === questionId)
      if (evt) match = { message: m, event: evt }
    }
    if (!match) return
    try {
      const result = await deps.answerQuestion(questionId, answer)
      if (!result.ok) return
    } catch { return }
    match.event.status = answer.kind === 'cancelled' ? 'cancelled' : 'answered'
    match.event.answer = answer
    match.event.endTs = Date.now()
    const stillPending = match.message.data.events.some(e => e.type === 'question' && e.status === 'pending')
    if (match.message.data.status === 'awaiting_question' && !stillPending) match.message.data.status = 'working'
    activityRevision.value++
    dirtyIds.add(match.message.id)
    upsertMessage(match.message)
    appendAnswerMessage(questionId, answer)
    splitActivityAfterAnswer(match.message.id, answer)
  }

  function removeQueuedMessage(id: string) {
    queuedMessages.value = queuedMessages.value.filter(m => m.id !== id)
  }

  async function drainNextQueuedMessage(): Promise<void> {
    if (queueDrainPromise || busy.value) return queueDrainPromise ?? Promise.resolve()
    queueDrainPromise = (async () => {
      await persistMessages()
      // A new turn may have started while persistence was settling.
      if (busy.value) return
      const next = queuedMessages.value[0]
      if (!next) return
      queuedMessages.value = queuedMessages.value.slice(1)
      await submit(next.text, next.images)
    })()
    try {
      await queueDrainPromise
    } finally {
      queueDrainPromise = null
    }
  }

  async function cancel() {
    if (!busy.value || cancellingTurnId) return
    // Do not clear local state or the queue here. The daemon's query_end is
    // authoritative and is the normal point at which the next queued turn
    // may start. Clearing ownership early made that terminal chunk a
    // straggler, losing both the final state and queued messages.
    cancellingTurnId = activeTurnId.value
    try {
      const result = await deps.cancel(currentSessionId.value ?? undefined, myScope)
      if (!result.ok) return
      // A sleeping/reconnecting client can miss query_end even though cancel
      // waits for daemon settlement. Reconcile the canonical transcript, then
      // use the same guarded queue drain as the live query_end path.
      await reconcileOnReconnect()
      if (!busy.value) await drainNextQueuedMessage()
    } catch {
      // Keep the queue intact. The user can retry Stop or reconnect; neither
      // should cause queued work to run against an unsettled active turn.
    }
  }

  function onQueryEnd(fn: (sessionId: string) => void) { queryEndCallbacks.push(fn) }

  /**
   * Reconnect reconciliation. Owning a live turn is NOT proof our memory is
   * freshest — the daemon may have finalized that turn while we were deaf
   * (or reloading), leaving us a zombie owner whose blind repersist would
   * regress the finished rows and wipe the reply. Ask the store first: only
   * repersist when our owned turn is still unfinalized there; in every other
   * case the daemon's copy wins and we reload from it.
   */
  async function reconcileOnReconnect() {
    if (busy.value && activeTurnId.value) {
      const ourTurnId = activeTurnId.value
      const page = await deps.listTranscript({ limit: TRANSCRIPT_PAGE_SIZE })
      const dbRow = page.messages.find(m => m.role === 'meta' && m.kind === 'activity' && (m.data as { turnId?: string } | undefined)?.turnId === ourTurnId)
      const dbStatus = String((dbRow?.data as { status?: string } | undefined)?.status ?? '')
      if (!dbRow || !['done', 'failed', 'cancelled'].includes(dbStatus)) {
        await persistMessages()
        return
      }
      // Daemon finalized our turn while we were disconnected — drop ownership
      // so the reload below can't re-adopt a dead turn as busy.
      busy.value = false
      activeTurnId.value = null
      activeActivityId.value = null
      endStreaming()
    }
    await loadTranscript()
  }

  function stashToLocalStorage() {
    if (!messages.value.length) return
    try {
      const tail = messages.value.slice(-TRANSCRIPT_BACKUP_LIMIT).map(m => toTranscriptMessage(m, myThreadId))
      localStorage.setItem(backupKey, JSON.stringify(tail))
      if (!options.namespace) localStorage.removeItem('bond:transcript-backup')
      localStorage.setItem('bond:msg-backup-ts', String(Date.now()))
    } catch { /* best effort */ }
  }

  async function restoreFromBackupIfNeeded(): Promise<boolean> {
    try {
      const raw = localStorage.getItem(backupKey) ?? (options.namespace ? null : localStorage.getItem('bond:transcript-backup'))
      if (!raw) return false
      const backed = (JSON.parse(raw) as TranscriptMessage[]).slice(-TRANSCRIPT_BACKUP_LIMIT)
      const dbPage = await deps.listTranscript({ limit: TRANSCRIPT_PAGE_SIZE })
      // SQLite is canonical. The stash is only emergency recovery for a
      // completely empty store; merging it into non-empty history resurrects
      // deleted or superseded transcript rows.
      if (dbPage.messages.length === 0 && backed.length > 0) {
        await deps.upsertTranscript(backed)
        return true
      }
    } catch { /* corrupt backup — ignore */ }
    finally {
      localStorage.removeItem(backupKey)
      if (!options.namespace) localStorage.removeItem('bond:transcript-backup')
    }
    return false
  }

  function setEditMode(mode: EditMode) { editMode.value = mode }

  function subscribe() { unsub = deps.onChunk(handleChunk) }
  function unsubscribe() { unsub?.() }

  if (import.meta.hot && _hmr) {
    import.meta.hot.dispose(() => {
      if (persistTimer) clearTimeout(persistTimer)
      // No DB write here: state survives HMR via the namespaced slot below,
      // the daemon persists every turn's rows itself, and a window holding a
      // stale transcript (dropped chunks) used to blast it over rows the
      // daemon had already finalized — regressing done turns and wiping replies.
      stashToLocalStorage()
      _hmr.messages = messages.value
      _hmr.busy = busy.value
      _hmr.queuedMessages = queuedMessages.value
      _hmr.transportSessionId = currentSessionId.value
      _hmr.nextBeforeSeq = nextBeforeSeq.value
      _hmr.hasLoaded = hasLoadedTranscript.value
      _hmr.activeTurnId = activeTurnId.value
      _hmr.activeActivityId = activeActivityId.value
      _hmr.dirtyIds = [...dirtyIds]
    })
  }

  return {
    messages,
    busy,
    busySessionIds,
    pendingApprovals,
    pendingQuestion,
    contextUsage,
    editMode,
    currentSessionId,
    queuedMessages,
    currentQueue,
    nextBeforeSeq,
    init,
    loadTranscript,
    loadOlder,
    submit,
    cancel,
    removeQueuedMessage,
    respondToApproval,
    answerQuestion,
    setEditMode,
    subscribe,
    unsubscribe,
    loadSession,
    clearMessages,
    persistMessages,
    reconcileOnReconnect,
    stashToLocalStorage,
    restoreFromBackupIfNeeded,
    onQueryEnd
  }
}

export type UseChatReturn = ReturnType<typeof useChat>

/**
 * A thread's conversation state — same engine as main (activity/approval/
 * question handling, queueing, persistence), scoped to one thread. The only
 * thing that actually differs is which RPC lists its history; useChat itself
 * already attaches `scope` to every send/cancel/subscribe call and filters
 * incoming chunks to match, so nothing else needs a thread-specific branch.
 */
export function useThreadConversation(threadId: string, deps?: ChatDeps): UseChatReturn {
  const threadDeps: ChatDeps = deps ?? {
    ...window.bond,
    listTranscript: (options) => window.bond.listThreadMessages(threadId, options),
  }
  return useChat(threadDeps, { scope: threadScope(threadId), namespace: `thread:${threadId}` })
}
