/// <reference types="vite/client" />
import { ref, computed } from 'vue'
import type { BondSendInput, TaggedChunk } from '../../shared/stream'
import type { BondSendResult } from '../../shared/rpc-schema'
import type { AttachedImage, EditMode, SessionMessage } from '../../shared/session'
import type { TranscriptMessage, TranscriptPage } from '../../shared/transcript'
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
  cancel: (sessionId?: string) => Promise<{ ok: boolean }>
  onChunk: (fn: (chunk: TaggedChunk) => void) => () => void
  respondToApproval: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>
  getImages: (ids: string[]) => Promise<(AttachedImage | null)[]>
  listTranscript: (options?: { beforeSeq?: number; limit?: number }) => Promise<TranscriptPage>
  upsertTranscript: (messages: TranscriptMessage[]) => Promise<{ ok: boolean }>
  createSession?: (options?: { title?: string }) => Promise<{ id: string }>
  subscribe?: (sessionId?: string) => Promise<{ ok: boolean }>
  unsubscribe?: (sessionId?: string) => Promise<{ ok: boolean }>
  // Legacy deps retained so older component tests can supply partial window.bond mocks.
  getMessages?: (sessionId: string) => Promise<SessionMessage[]>
  saveMessages?: (sessionId: string, messages: SessionMessage[]) => Promise<boolean>
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

function toTranscriptMessage(m: Message): TranscriptMessage {
  const base = { id: m.id, role: m.role === 'bond' ? 'bond' as const : m.role, createdAt: m.ts ? new Date(m.ts).toISOString() : undefined, updatedAt: nowIso() }
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

const _hmr = import.meta.hot?.data as
  | { messages?: Message[]; busy?: boolean; queuedMessages?: QueuedMessage[]; transportSessionId?: string | null; nextBeforeSeq?: number | null; hasLoaded?: boolean; activeTurnId?: string | null; activeActivityId?: string | null }
  | undefined

/** Chunk kinds owned by a single turn — anything here from a foreign turnId is a straggler. */
const TURN_SCOPED_CHUNKS: ReadonlySet<string> = new Set([
  'query_start', 'query_end', 'assistant_text', 'thinking_text', 'assistant_tool',
  'tool_result', 'tool_approval', 'raw_error', 'result', 'generated_image', 'system',
])

export function useChat(deps: ChatDeps = window.bond) {
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
  let lastPersistPromise: Promise<void> = Promise.resolve()

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

  function addMessage(msg: Message) {
    if (!msg.ts) msg.ts = Date.now()
    messages.value.push(msg)
  }

  function upsertMessage(msg: Message): Promise<void> {
    return upsertMessages([msg])
  }

  function upsertMessages(msgs: Message[]): Promise<void> {
    const payload = msgs.map(m => toTranscriptMessage({ ...m }))
    const promise = (async () => {
      try {
        const res = await deps.upsertTranscript(payload)
        if (!res.ok) throw new Error('transcript.upsert failed')
      } catch (err) {
        console.warn('[bond] transcript upsert failed — data is in renderer memory only', err)
        stashToLocalStorage()
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
    if (!messages.value.length) return
    await upsertMessages(messages.value)
  }

  function existingActivity(): (Message & { role: 'meta'; kind: 'activity' }) | undefined {
    const byId = activeActivityId.value ? messages.value.find(m => m.id === activeActivityId.value && m.role === 'meta' && m.kind === 'activity') : undefined
    if (byId && byId.role === 'meta' && byId.kind === 'activity') return byId
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.role === 'meta' && m.kind === 'activity' && ['working', 'responding', 'awaiting_approval'].includes(m.data.status)) {
        activeActivityId.value = m.id
        return m
      }
    }
  }

  function activityFor(): Message & { role: 'meta'; kind: 'activity' } {
    const existing = existingActivity()
    if (existing) return existing
    const data: TurnActivityData = { turnId: uid(), status: 'working', startedAt: Date.now(), events: [] }
    const msg: Message & { role: 'meta'; kind: 'activity' } = { id: uid(), role: 'meta', kind: 'activity', data, ts: data.startedAt }
    addMessage(msg)
    activeActivityId.value = msg.id
    return msg
  }

  function updateActivity(updater: (data: TurnActivityData) => void) {
    const msg = activityFor()
    updater(msg.data)
    activityRevision.value++
    schedulePersist()
  }

  function finalizeOpenActivityEvents(data: TurnActivityData, end = Date.now()) {
    for (const evt of data.events) if ((evt.type === 'thinking' || evt.type === 'tool' || evt.type === 'responding') && evt.endTs == null) evt.endTs = end
  }

  function cancelPendingApprovals(data: TurnActivityData, end = Date.now()) {
    for (const evt of data.events) if (evt.type === 'approval' && evt.status === 'pending') { evt.status = 'cancelled'; evt.endTs = end }
  }

  function lastActivityEvent(data: TurnActivityData): TurnActivityEvent | undefined {
    return data.events[data.events.length - 1]
  }

  function endStreaming() {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const msg = messages.value[i]
      if (msg.role === 'bond' && msg.streaming) { msg.streaming = false; return }
    }
  }

  function handleChunk(chunk: TaggedChunk) {
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

    if (chunk.kind === 'edit_mode_changed') {
      // One global mode across devices — mirror a change made anywhere.
      editMode.value = chunk.editMode
      return
    }

    // Drop stragglers from a turn we no longer own — an in-flight chunk can
    // race a cancel, and without this guard activityFor() mints an orphan
    // "Working" row for the dead turn that then gets persisted. Untagged
    // chunks pass for back-compat; cross-turn kinds are handled above.
    if (chunk.turnId && chunk.turnId !== activeTurnId.value && TURN_SCOPED_CHUNKS.has(chunk.kind)) return

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
        activityMsg.data.status = !chunk.succeeded || activityMsg.data.status === 'failed' ? 'failed' : 'done'
        activityMsg.data.endedAt = endedAt
        if (activityMsg.data.status === 'failed') activityMsg.data.expanded = true
        activityRevision.value++
      }
      activeActivityId.value = null
      endStreaming()
      const sid = currentSessionId.value || chunk.sessionId || 'continuous'
      const endPromise = (async () => {
        await persistMessages()
        const next = queuedMessages.value[0]
        if (next) {
          queuedMessages.value = queuedMessages.value.slice(1)
          submit(next.text, next.images)
        }
      })()
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
        if (last?.role === 'bond' && last.streaming) last.text += chunk.text
        else addMessage({ id: chunk.assistantMessageId ?? uid(), role: 'bond', text: chunk.text, streaming: true })
        schedulePersist()
        break
      }
      case 'assistant_tool':
        updateActivity(data => { finalizeOpenActivityEvents(data); data.status = 'working'; data.events.push({ id: uid(), type: 'tool', label: formatToolLabel(chunk.name, chunk.summary), ts: Date.now(), toolUseId: chunk.toolUseId, toolName: chunk.name, input: chunk.input }) })
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
        updateActivity(data => { data.status = 'failed'; data.expanded = true; data.endedAt = Date.now(); cancelPendingApprovals(data, data.endedAt); data.events.push({ id: uid(), type: 'error', label: 'Error', ts: Date.now(), text: chunk.message }) })
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
      if (['working', 'responding', 'awaiting_approval'].includes(m.data.status) && m.data.turnId) {
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
    if (!options.append) adoptLiveTurnFromTranscript()
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
    await deps.subscribe?.()
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
      const input: BondSendInput = { text: trimmed, images: plainImages(images), turnId, userMessageId, assistantMessageId, activityMessageId, editMode: plainEditMode(editMode.value) }
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
    upsertMessage(match.message)
  }

  function removeQueuedMessage(id: string) {
    queuedMessages.value = queuedMessages.value.filter(m => m.id !== id)
  }

  function cancel() {
    queuedMessages.value = []
    activeTurnId.value = null
    if (busy.value) {
      busy.value = false
      updateActivity(data => { const endedAt = Date.now(); finalizeOpenActivityEvents(data, endedAt); cancelPendingApprovals(data, endedAt); data.status = 'cancelled'; data.endedAt = endedAt })
      activeActivityId.value = null
      endStreaming()
      persistMessages()
    }
    deps.cancel(currentSessionId.value ?? undefined).catch(() => {})
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
      const tail = messages.value.slice(-TRANSCRIPT_BACKUP_LIMIT).map(toTranscriptMessage)
      localStorage.setItem(TRANSCRIPT_BACKUP_KEY, JSON.stringify(tail))
      localStorage.removeItem('bond:transcript-backup')
      localStorage.setItem('bond:msg-backup-ts', String(Date.now()))
    } catch { /* best effort */ }
  }

  async function restoreFromBackupIfNeeded(): Promise<boolean> {
    try {
      const raw = localStorage.getItem(TRANSCRIPT_BACKUP_KEY) ?? localStorage.getItem('bond:transcript-backup')
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
      localStorage.removeItem(TRANSCRIPT_BACKUP_KEY)
      localStorage.removeItem('bond:transcript-backup')
    }
    return false
  }

  function setEditMode(mode: EditMode) { editMode.value = mode }

  function subscribe() { unsub = deps.onChunk(handleChunk) }
  function unsubscribe() { unsub?.() }

  if (import.meta.hot) {
    import.meta.hot.dispose((data) => {
      if (persistTimer) clearTimeout(persistTimer)
      // No DB write here: state survives HMR via `data` below, the daemon
      // persists every turn's rows itself, and a window holding a stale
      // transcript (dropped chunks) used to blast it over rows the daemon
      // had already finalized — regressing done turns and wiping replies.
      stashToLocalStorage()
      data.messages = messages.value
      data.busy = busy.value
      data.queuedMessages = queuedMessages.value
      data.transportSessionId = currentSessionId.value
      data.nextBeforeSeq = nextBeforeSeq.value
      data.hasLoaded = hasLoadedTranscript.value
      data.activeTurnId = activeTurnId.value
      data.activeActivityId = activeActivityId.value
    })
  }

  return {
    messages,
    busy,
    busySessionIds,
    pendingApprovals,
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
