/// <reference types="vite/client" />
import { ref, computed } from 'vue'
import type { BondSendInput, TaggedChunk } from '../../shared/stream'
import type { AttachedImage, EditMode, SessionMessage } from '../../shared/session'
import type { TranscriptMessage, TranscriptPage } from '../../shared/transcript'
import type { Message } from '../types/message'
import type { TurnActivityData, TurnActivityEvent } from '../types/activity'

const TRANSCRIPT_PAGE_SIZE = 80
const TRANSCRIPT_BACKUP_KEY = 'bond:transcript-tail-backup'
const TRANSCRIPT_BACKUP_LIMIT = 100

export interface QueuedMessage {
  id: string
  text: string
  images?: AttachedImage[]
}

export interface ChatDeps {
  send: ((input: BondSendInput) => Promise<{ ok: boolean; queued?: boolean; error?: string; imageIds?: string[] }>) & ((text: string, sessionId?: string, images?: AttachedImage[]) => Promise<{ ok: boolean; queued?: boolean; error?: string; imageIds?: string[] }>)
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
  return crypto.randomUUID()
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
  | { messages?: Message[]; busy?: boolean; queuedMessages?: QueuedMessage[]; transportSessionId?: string | null; nextBeforeSeq?: number | null; hasLoaded?: boolean }
  | undefined

export function useChat(deps: ChatDeps = window.bond) {
  const messages = ref<Message[]>(_hmr?.messages ?? [])
  const busy = ref(!!_hmr?.busy)
  const queuedMessages = ref<QueuedMessage[]>(_hmr?.queuedMessages ?? [])
  const currentSessionId = ref<string | null>(_hmr?.transportSessionId ?? null)
  const nextBeforeSeq = ref<number | null>(_hmr?.nextBeforeSeq ?? null)
  const hasLoadedTranscript = ref(!!_hmr?.hasLoaded)
  const contextUsage = ref<{ inputTokens: number; contextWindow: number; costUsd: number }>({ inputTokens: 0, contextWindow: 0, costUsd: 0 })
  const editMode = ref<EditMode>({ type: 'full' })

  const activeActivityId = ref<string | null>(null)
  const activityRevision = ref(0)
  const currentQueue = computed(() => queuedMessages.value)
  const busySessionIds = computed(() => currentSessionId.value && busy.value ? new Set([currentSessionId.value]) : new Set<string>())
  const queryEndCallbacks: Array<(sessionId: string) => void> = []

  let unsub: (() => void) | undefined
  let globalSubscribed = false
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let lastPersistPromise: Promise<void> = Promise.resolve()

  function _formatToolLabel(name: string, summary?: string): string {
    const filename = summary?.split('/').pop() || summary
    const verbs: Record<string, string> = { Read: 'Read', Edit: 'Edited', Write: 'Wrote', Bash: 'Ran command', Glob: 'Searched files', Grep: 'Searched code', WebSearch: 'Searched the web', WebFetch: 'Fetched page' }
    const verb = verbs[name] ?? name
    return filename && !['Bash', 'Glob', 'WebSearch'].includes(name) ? `${verb} ${filename}` : verb
  }

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

    if (chunk.kind === 'query_start') {
      busy.value = true
      updateActivity(data => { data.status = 'working'; data.startedAt ||= Date.now() })
      return
    }

    if (chunk.kind === 'query_end') {
      busy.value = false
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
        updateActivity(data => { finalizeOpenActivityEvents(data); data.status = 'working'; data.events.push({ id: uid(), type: 'tool', label: _formatToolLabel(chunk.name, chunk.summary), ts: Date.now(), toolUseId: chunk.toolUseId, toolName: chunk.name, input: chunk.input }) })
        break
      case 'tool_result':
        updateActivity(data => {
          const now = Date.now()
          const ev = chunk.toolUseId ? [...data.events].reverse().find(evt => evt.type === 'tool' && evt.toolUseId === chunk.toolUseId) : [...data.events].reverse().find(evt => evt.type === 'tool' && !evt.output)
          if (ev?.type === 'tool') { ev.output = chunk.output; ev.endTs = now; ev.failed = chunk.isError; if (chunk.isError) data.expanded = true }
        })
        break
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
    return page
  }

  async function loadOlder() {
    if (nextBeforeSeq.value == null) return null
    return loadTranscript({ beforeSeq: nextBeforeSeq.value, append: true })
  }

  async function resolveImages(target: Message[]) {
    const allIds = target.flatMap(m => m.role === 'user' ? (m.imageIds ?? []) : [])
    if (!allIds.length) return
    const loaded = await deps.getImages(allIds)
    const map = new Map<string, AttachedImage>()
    allIds.forEach((id, i) => { if (loaded[i]) map.set(id, loaded[i]!) })
    for (const msg of target) if (msg.role === 'user' && msg.imageIds?.length) msg.images = msg.imageIds.map(id => map.get(id)!).filter(Boolean)
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
    await ensureGlobalSubscription()

    if (busy.value) {
      queuedMessages.value = [...queuedMessages.value, { id: uid(), text: trimmed, images: images?.length ? images : undefined }]
      return
    }

    const turnId = uid()
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
      if (!res.ok && res.error) {
        addMessage({ id: uid(), role: 'meta', kind: 'error', text: res.error })
        busy.value = false
        updateActivity(data => { data.status = 'failed'; data.expanded = true; data.endedAt = Date.now(); data.events.push({ id: uid(), type: 'error', label: 'Error', ts: Date.now(), text: res.error! }) })
        activeActivityId.value = null
        endStreaming()
        await persistMessages()
      }
    } catch (error) {
      busy.value = false
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

  async function repersistAll() { await persistMessages() }

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
      persistMessages()
      stashToLocalStorage()
      data.messages = messages.value
      data.busy = busy.value
      data.queuedMessages = queuedMessages.value
      data.transportSessionId = currentSessionId.value
      data.nextBeforeSeq = nextBeforeSeq.value
      data.hasLoaded = hasLoadedTranscript.value
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
    repersistAll,
    stashToLocalStorage,
    restoreFromBackupIfNeeded,
    onQueryEnd
  }
}
