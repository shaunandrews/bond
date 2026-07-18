/// <reference types="vite/client" />
import { ref, computed } from 'vue'
import type { BondStreamChunk, TaggedChunk } from '../../shared/stream'
import type { SessionMessage, AttachedImage } from '../../shared/session'
import type { Message } from '../types/message'
import type { TurnActivityData, TurnActivityEvent } from '../types/activity'

export interface QueuedMessage {
  id: string
  sessionId: string
  text: string
  images?: AttachedImage[]
}

export interface ChatDeps {
  send: (text: string, sessionId?: string, images?: AttachedImage[]) => Promise<{ ok: boolean; error?: string; imageIds?: string[] }>
  cancel: (sessionId?: string) => Promise<{ ok: boolean }>
  onChunk: (fn: (chunk: TaggedChunk) => void) => () => void
  respondToApproval: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>
  getMessages: (sessionId: string) => Promise<SessionMessage[]>
  saveMessages: (sessionId: string, messages: SessionMessage[]) => Promise<boolean>
  getImages: (ids: string[]) => Promise<(AttachedImage | null)[]>
  subscribe?: (sessionId: string) => Promise<{ ok: boolean }>
  unsubscribe?: (sessionId: string) => Promise<{ ok: boolean }>
}

function uid(): string {
  return crypto.randomUUID()
}

function toSessionMessages(msgs: Message[]): SessionMessage[] {
  return msgs.map((m) => {
    if (m.role === 'user') {
      const sm: SessionMessage = { id: m.id, role: 'user', text: m.text }
      if (m.imageIds?.length) sm.imageIds = m.imageIds
      else if (m.images?.length) sm.images = m.images.map(i => ({ data: i.data, mediaType: i.mediaType }))
      return sm
    }
    if (m.role === 'bond') return { id: m.id, role: 'bond', text: m.text, streaming: false }
    if (m.kind === 'tool') return { id: m.id, role: 'meta', kind: 'tool', name: m.name, summary: m.summary }
    if (m.kind === 'skill') return { id: m.id, role: 'meta', kind: 'skill', name: m.name, summary: m.args }
    if (m.kind === 'thinking') return { id: m.id, role: 'meta', kind: 'thinking', text: m.text, summary: m.durationSec != null ? String(m.durationSec) : undefined }
    if (m.kind === 'approval') return { id: m.id, role: 'meta', kind: 'approval', name: m.toolName, summary: m.description, status: m.status }
    if (m.kind === 'activity') return { id: m.id, role: 'meta', kind: 'activity', data: m.data as unknown as Record<string, unknown> }
    if (m.kind === 'error') return { id: m.id, role: 'meta', kind: 'error', text: m.text }
    return { id: m.id, role: 'meta', kind: 'system', text: m.text }
  })
}

function fromSessionMessages(msgs: SessionMessage[]): Message[] {
  return msgs.map((m): Message | null => {
    if (m.role === 'user') return { id: m.id, role: 'user', text: m.text ?? '', images: m.images, imageIds: m.imageIds }
    if (m.role === 'bond') return { id: m.id, role: 'bond', text: m.text ?? '', streaming: false }
    if (m.kind === 'tool') return { id: m.id, role: 'meta', kind: 'tool', name: m.name ?? '', summary: m.summary }
    if (m.kind === 'skill') return { id: m.id, role: 'meta', kind: 'skill', name: m.name ?? '', args: m.summary }
    if (m.kind === 'thinking') {
      // Drop empty thinking messages (stale DB records from interrupted queries)
      if (!m.text?.trim()) return null
      return { id: m.id, role: 'meta', kind: 'thinking', text: m.text ?? '', durationSec: m.summary ? parseInt(m.summary, 10) : undefined, streaming: false }
    }
    if (m.kind === 'approval') return { id: m.id, role: 'meta', kind: 'approval', requestId: '', toolName: m.name ?? '', input: {}, description: m.summary, status: (m.status as 'approved' | 'denied') ?? 'denied' }
    if (m.kind === 'activity' && m.data) return { id: m.id, role: 'meta', kind: 'activity', data: m.data as unknown as TurnActivityData }
    if (m.kind === 'error') return { id: m.id, role: 'meta', kind: 'error', text: m.text ?? '' }
    return { id: m.id, role: 'meta', kind: 'system', text: m.text ?? '' }
  }).filter((m): m is Message => m !== null)
}

// Preserve chat state across HMR reloads so in-flight streaming
// isn't lost when Vite hot-updates a module during a response.
const _hmr = import.meta.hot?.data as
  | { messages?: Message[]; busySessions?: string[]; sessionId?: string | null; backgroundMessages?: [string, Message[]][]; queuedMessages?: QueuedMessage[] }
  | undefined
const _hmrNeedsPersist = !!(_hmr?.messages?.length || _hmr?.backgroundMessages?.length)

export function useChat(deps: ChatDeps = window.bond) {
  /** Per-session context usage tracking */
  const _contextUsageMap = new Map<string, { inputTokens: number; contextWindow: number; costUsd: number }>()
  const contextUsage = ref<{ inputTokens: number; contextWindow: number; costUsd: number }>({ inputTokens: 0, contextWindow: 0, costUsd: 0 })

  /** Messages for the current session (reactive, rendered by template) */
  const messages = ref<Message[]>(_hmr?.messages ?? [])
  const busySessions = ref<Set<string>>(new Set(_hmr?.busySessions ?? []))
  const queuedMessages = ref<QueuedMessage[]>(_hmr?.queuedMessages ?? [])
  const currentSessionId = ref<string | null>(_hmr?.sessionId ?? null)

  /** Messages for non-current sessions that are still receiving chunks */
  const backgroundMessages = new Map<string, Message[]>(_hmr?.backgroundMessages ?? [])

  const activeActivityIds = new Map<string, string>()
  const activityRevision = ref(0)

  function _formatToolLabel(name: string, summary?: string): string {
    const filename = summary?.split('/').pop() || summary
    const verbs: Record<string, string> = {
      Read: 'Read', Edit: 'Edited', Write: 'Wrote',
      Bash: 'Ran command', Glob: 'Searched files', Grep: 'Searched code',
      WebSearch: 'Searched the web', WebFetch: 'Fetched page',
    }
    const verb = verbs[name] ?? name
    return filename && !['Bash', 'Glob', 'WebSearch'].includes(name) ? `${verb} ${filename}` : verb
  }

  const busy = computed(() => {
    const sid = currentSessionId.value
    return sid ? busySessions.value.has(sid) : false
  })

  const currentQueue = computed(() =>
    queuedMessages.value.filter(m => m.sessionId === currentSessionId.value)
  )

  const pendingApprovals = computed(() => {
    activityRevision.value
    const found = new Map<string, Extract<TurnActivityEvent, { type: 'approval' }> & { activityMessageId: string; sessionId: string }>()
    const sources: Array<[string, Message[]]> = [
      ...(currentSessionId.value ? [[currentSessionId.value, messages.value] as [string, Message[]]] : []),
      ...backgroundMessages.entries(),
    ]
    for (const [sessionId, sessionMessages] of sources) {
      for (const m of sessionMessages) {
        if (m.role !== 'meta' || m.kind !== 'activity') continue
        for (const evt of m.data.events) {
          if (evt.type === 'approval' && evt.status === 'pending') {
            found.set(evt.requestId, { ...evt, activityMessageId: m.id, sessionId })
          }
        }
      }
    }
    return [...found.values()]
  })

  function markBusy(sessionId: string) {
    busySessions.value = new Set([...busySessions.value, sessionId])
  }

  function markIdle(sessionId: string) {
    const next = new Set(busySessions.value)
    next.delete(sessionId)
    busySessions.value = next
  }

  let unsub: (() => void) | undefined
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const streamingStashTimers = new Map<string, ReturnType<typeof setInterval>>()
  const queryEndCallbacks: Array<(sessionId: string) => void> = []

  /** Tracks the latest persist promise per session so loadSession can await it */
  const lastPersistPromise = new Map<string, Promise<void>>()

  /** Periodically stash messages to localStorage during streaming.
   *  Survives hard renderer crashes (OOM, GPU crash) where beforeunload never fires. */
  function startStreamingStash(sessionId: string) {
    stopStreamingStash(sessionId)
    streamingStashTimers.set(sessionId, setInterval(() => {
      const msgs = backgroundMessages.get(sessionId)
        ?? (sessionId === currentSessionId.value ? messages.value : undefined)
      if (!msgs?.length) return
      try {
        const key = `bond:msg-backup:${sessionId}`
        localStorage.setItem(key, JSON.stringify(toSessionMessages(msgs)))
        localStorage.setItem('bond:msg-backup-ts', String(Date.now()))
      } catch { /* quota — best effort */ }
    }, 15_000))
  }

  function stopStreamingStash(sessionId: string) {
    const timer = streamingStashTimers.get(sessionId)
    if (timer) {
      clearInterval(timer)
      streamingStashTimers.delete(sessionId)
    }
  }

  function onQueryEnd(fn: (sessionId: string) => void) {
    queryEndCallbacks.push(fn)
  }

  /** Get the message array for a session — current session uses the reactive ref, others use the background buffer */
  function getMessagesFor(sessionId: string): Message[] {
    if (sessionId === currentSessionId.value) return messages.value
    let msgs = backgroundMessages.get(sessionId)
    if (!msgs) {
      msgs = []
      backgroundMessages.set(sessionId, msgs)
    }
    return msgs
  }

  // Per-session throttled persist: saves at most every 2s during streaming
  function schedulePersistFor(sessionId: string) {
    if (persistTimers.has(sessionId)) return
    persistTimers.set(sessionId, setTimeout(() => {
      persistTimers.delete(sessionId)
      persistMessagesFor(sessionId)
    }, 2000))
  }

  function flushPersistFor(sessionId: string): Promise<void> {
    const timer = persistTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      persistTimers.delete(sessionId)
    }
    const promise = persistMessagesFor(sessionId)
    lastPersistPromise.set(sessionId, promise)
    return promise
  }

  function addMessageTo(msgs: Message[], msg: Message) {
    if (!msg.ts) msg.ts = Date.now()
    msgs.push(msg)
  }

  function existingActivityFor(sessionId: string, msgs = getMessagesFor(sessionId)): (Message & { role: 'meta'; kind: 'activity' }) | undefined {
    const activeId = activeActivityIds.get(sessionId)
    const byId = activeId ? msgs.find(m => m.id === activeId && m.role === 'meta' && m.kind === 'activity') : undefined
    if (byId && byId.role === 'meta' && byId.kind === 'activity') return byId

    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === 'meta' && m.kind === 'activity' && ['working', 'responding', 'awaiting_approval'].includes(m.data.status)) {
        activeActivityIds.set(sessionId, m.id)
        return m
      }
    }
  }

  function activityFor(sessionId: string, msgs = getMessagesFor(sessionId)): Message & { role: 'meta'; kind: 'activity' } {
    const existing = existingActivityFor(sessionId, msgs)
    if (existing) return existing

    const data: TurnActivityData = { turnId: uid(), status: 'working', startedAt: Date.now(), events: [] }
    const msg: Message & { role: 'meta'; kind: 'activity' } = { id: uid(), role: 'meta', kind: 'activity', data, ts: data.startedAt }
    addMessageTo(msgs, msg)
    activeActivityIds.set(sessionId, msg.id)
    return msg
  }

  function updateActivity(sessionId: string, updater: (data: TurnActivityData) => void) {
    const msg = activityFor(sessionId)
    updater(msg.data)
    activityRevision.value++
  }

  function finalizeOpenActivityEvents(data: TurnActivityData, end = Date.now()) {
    for (const evt of data.events) {
      if ((evt.type === 'thinking' || evt.type === 'tool' || evt.type === 'responding') && evt.endTs == null) evt.endTs = end
    }
  }

  function cancelPendingApprovals(data: TurnActivityData, end = Date.now()) {
    for (const evt of data.events) {
      if (evt.type === 'approval' && evt.status === 'pending') {
        evt.status = 'cancelled'
        evt.endTs = end
      }
    }
  }

  function lastActivityEvent(data: TurnActivityData): TurnActivityEvent | undefined {
    return data.events[data.events.length - 1]
  }

  function endStreamingOn(msgs: Message[]) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.role === 'bond' && msg.streaming) {
        msg.streaming = false
        return
      }
    }
  }

  function handleChunk(chunk: TaggedChunk) {
    // Per-session busy tracking — always processed regardless of active session
    if (chunk.kind === 'query_start') {
      markBusy(chunk.sessionId)
      updateActivity(chunk.sessionId, data => { data.status = 'working'; data.startedAt ||= Date.now() })
      startStreamingStash(chunk.sessionId)
      return
    }
    if (chunk.kind === 'query_end') {
      markIdle(chunk.sessionId)
      stopStreamingStash(chunk.sessionId)
      const endedAt = Date.now()
      const activityMsg = existingActivityFor(chunk.sessionId)
      if (activityMsg) {
        finalizeOpenActivityEvents(activityMsg.data, endedAt)
        cancelPendingApprovals(activityMsg.data, endedAt)
        activityMsg.data.status = !chunk.succeeded || activityMsg.data.status === 'failed' ? 'failed' : 'done'
        activityMsg.data.endedAt = endedAt
        if (activityMsg.data.status === 'failed') activityMsg.data.expanded = true
        activityRevision.value++
      }
      activeActivityIds.delete(chunk.sessionId)
      queryEndCallbacks.forEach(fn => fn(chunk.sessionId))
      const msgs = getMessagesFor(chunk.sessionId)
      endStreamingOn(msgs)
      // Persist then handle queue. The promise is tracked in lastPersistPromise
      // so loadSession can await it before reading from DB.
      // Background buffer is NOT deleted here — loadSession is the sole consumer.
      const endPromise = (async () => {
        await flushPersistFor(chunk.sessionId)
        // Auto-send next queued message for this session
        if (chunk.sessionId === currentSessionId.value) {
          const nextIdx = queuedMessages.value.findIndex(m => m.sessionId === chunk.sessionId)
          if (nextIdx !== -1) {
            const next = queuedMessages.value[nextIdx]
            queuedMessages.value = queuedMessages.value.filter((_, i) => i !== nextIdx)
            submit(next.text, next.images)
          }
        }
      })()
      lastPersistPromise.set(chunk.sessionId, endPromise)
      return
    }

    // Route to the correct session's message array
    const sid = chunk.sessionId
    const msgs = getMessagesFor(sid)

    // Thinking deltas accumulate into the activity timeline, not a separate transcript message.
    if (chunk.kind === 'thinking_text') {
      updateActivity(sid, data => {
        const last = lastActivityEvent(data)
        if (last?.type === 'thinking' && last.endTs == null) {
          last.text += chunk.text
        } else {
          data.events.push({ id: uid(), type: 'thinking', label: 'Thinking', ts: Date.now(), text: chunk.text })
        }
        data.status = 'working'
      })
      return
    }

    switch (chunk.kind) {
      case 'usage_update': {
        const usage = { inputTokens: chunk.inputTokens, contextWindow: chunk.contextWindow, costUsd: chunk.costUsd }
        _contextUsageMap.set(sid, usage)
        if (sid === currentSessionId.value) contextUsage.value = usage
        return
      }

      case 'assistant_text': {
        updateActivity(sid, data => {
          const last = lastActivityEvent(data)
          if (last?.type !== 'responding' || last.endTs != null) {
            finalizeOpenActivityEvents(data)
            data.events.push({ id: uid(), type: 'responding', label: 'Responding', ts: Date.now() })
          }
          data.status = 'responding'
        })
        const last = msgs[msgs.length - 1]
        if (last?.role === 'bond' && last.streaming) {
          last.text += chunk.text
        } else {
          msgs.push({ id: uid(), role: 'bond', text: chunk.text, streaming: true } as Message)
        }
        schedulePersistFor(sid)
        break
      }

      case 'assistant_tool':
        updateActivity(sid, data => {
          finalizeOpenActivityEvents(data)
          data.status = 'working'
          data.events.push({ id: uid(), type: 'tool', label: _formatToolLabel(chunk.name, chunk.summary), ts: Date.now(), toolUseId: chunk.toolUseId, toolName: chunk.name, input: chunk.input })
        })
        schedulePersistFor(sid)
        break

      case 'tool_result': {
        updateActivity(sid, data => {
          const now = Date.now()
          const ev = chunk.toolUseId
            ? [...data.events].reverse().find(evt => evt.type === 'tool' && evt.toolUseId === chunk.toolUseId)
            : [...data.events].reverse().find(evt => evt.type === 'tool' && !evt.output)
          if (ev?.type === 'tool') {
            ev.output = chunk.output
            ev.endTs = now
            ev.failed = chunk.isError
            if (chunk.isError) data.expanded = true
          }
        })
        schedulePersistFor(sid)
        break
      }

      case 'tool_approval':
        updateActivity(sid, data => {
          const existing = data.events.find(evt => evt.type === 'approval' && evt.requestId === chunk.requestId)
          if (existing) return
          finalizeOpenActivityEvents(data)
          data.status = 'awaiting_approval'
          data.expanded = true
          data.events.push({ id: uid(), type: 'approval', label: `Approval requested: ${chunk.toolName}`, ts: Date.now(), requestId: chunk.requestId, toolName: chunk.toolName, input: chunk.input, title: chunk.title, description: chunk.description, status: 'pending' })
        })
        schedulePersistFor(sid)
        break

      case 'result':
        endStreamingOn(msgs)
        if (chunk.errors?.length) {
          const text = chunk.errors.join('; ')
          updateActivity(sid, data => {
            data.status = 'failed'
            data.expanded = true
            data.events.push({ id: uid(), type: 'error', label: 'Error', ts: Date.now(), text })
          })
          addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'error', text })
        }
        {
          const last = msgs[msgs.length - 1]
          if (last?.role === 'bond' && last.streaming) {
            last.streaming = false
          } else if (chunk.result && (!last || last.role !== 'bond')) {
            // Fallback: if no streaming message was created, use the result text
            addMessageTo(msgs, { id: uid(), role: 'bond', text: chunk.result, streaming: false })
          }
        }
        // Auto-save after each completed turn
        flushPersistFor(sid)
        break

      case 'raw_error':
        endStreamingOn(msgs)
        updateActivity(sid, data => {
          data.status = 'failed'
          data.expanded = true
          data.endedAt = Date.now()
          cancelPendingApprovals(data, data.endedAt)
          data.events.push({ id: uid(), type: 'error', label: 'Error', ts: Date.now(), text: chunk.message })
        })
        addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'error', text: chunk.message })
        flushPersistFor(sid)
        break

      case 'system':
        addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'system', text: chunk.text ?? chunk.subtype })
        break
    }
  }

  function persistMessagesFor(sessionId: string): Promise<void> {
    // Check backgroundMessages first — if a session was stashed during a switch,
    // its data lives there even if currentSessionId has already changed.
    const msgs = backgroundMessages.get(sessionId)
      ?? (sessionId === currentSessionId.value ? messages.value : undefined)
    if (!msgs || !msgs.length) return Promise.resolve()

    // Snapshot messages immediately to avoid mutation races with ongoing streaming
    const data = toSessionMessages(msgs.map(m => ({ ...m })))

    const promise = (async () => {
      let saved = false
      try {
        saved = await deps.saveMessages(sessionId, data)
      } catch { /* network/IPC failure */ }

      // Retry once on failure
      if (!saved) {
        try {
          saved = await deps.saveMessages(sessionId, data)
        } catch { /* still failing */ }
      }

      if (!saved) {
        console.warn(`[bond] persistMessagesFor failed for session ${sessionId} — data is in memory only`)
        // Stash to localStorage as a safety net
        try {
          const key = `bond:msg-backup:${sessionId}`
          localStorage.setItem(key, JSON.stringify(data))
          localStorage.setItem('bond:msg-backup-ts', String(Date.now()))
        } catch { /* quota exceeded — best effort */ }
      }
    })()

    lastPersistPromise.set(sessionId, promise)
    return promise
  }

  async function persistMessages() {
    if (currentSessionId.value) {
      await persistMessagesFor(currentSessionId.value)
    }
  }

  // Serialization gate for loadSession — prevents overlapping async calls from
  // racing and losing intermediate session data (e.g. rapid A→B→C clicks).
  let _loadLock: Promise<void> | null = null
  let _pendingLoadId: string | null = null

  async function loadSession(sessionId: string) {
    if (_loadLock) {
      // Another loadSession is in flight. Record what we actually want and wait.
      _pendingLoadId = sessionId
      await _loadLock
      // If something newer came in while we waited, bail — that one will run.
      if (_pendingLoadId !== sessionId) return
    }

    let unlock!: () => void
    _loadLock = new Promise(r => { unlock = r })
    _pendingLoadId = null

    try {
      await _loadSessionCore(sessionId)
    } finally {
      _loadLock = null
      unlock()

      // If a newer session was requested while we ran, load it now.
      if (_pendingLoadId) {
        const next = _pendingLoadId
        _pendingLoadId = null
        loadSession(next)
      }
    }
  }

  async function _loadSessionCore(sessionId: string) {
    const oldSid = currentSessionId.value
    if (oldSid) {
      await flushPersistFor(oldSid)
      // Always stash current messages when switching away — not just for busy sessions.
      // Previously this was gated on busySessions.has(oldSid), but query_end can clear
      // the busy flag during the flushPersistFor await above, causing messages to be
      // silently dropped when messages.value is overwritten with the new session's data.
      // Deep-copy message objects to prevent mutation races with ongoing streaming.
      if (messages.value.length > 0) {
        backgroundMessages.set(oldSid, messages.value.map(m => ({ ...m })))
      }
      // Unsubscribe from the old session if it's no longer busy
      if (!busySessions.value.has(oldSid)) {
        deps.unsubscribe?.(oldSid).catch(() => {})
      }
    }

    currentSessionId.value = sessionId
    deps.subscribe?.(sessionId).catch(() => {})
    contextUsage.value = _contextUsageMap.get(sessionId) ?? { inputTokens: 0, contextWindow: 0, costUsd: 0 }

    // Restore from background buffer if available (preserves in-flight responses)
    const bg = backgroundMessages.get(sessionId)
    if (bg) {
      messages.value = bg
      backgroundMessages.delete(sessionId)
      return
    }

    // Await any pending persist for this session before reading from DB.
    // This prevents the race where query_end's flush hasn't completed yet,
    // causing us to read stale/partial data from the database.
    const pending = lastPersistPromise.get(sessionId)
    if (pending) {
      await pending
      lastPersistPromise.delete(sessionId)
    }

    // Re-check background buffer — it may have been populated while we awaited the persist
    // (e.g. chunks arrived between our first check and the persist completing)
    const bgAfterAwait = backgroundMessages.get(sessionId)
    if (bgAfterAwait) {
      messages.value = bgAfterAwait
      backgroundMessages.delete(sessionId)
      return
    }

    // Load from DB
    const saved = await deps.getMessages(sessionId)
    const msgs = fromSessionMessages(saved)

    // Resolve image IDs to displayable data
    const allIds = saved.flatMap(m => m.imageIds ?? [])
    if (allIds.length) {
      const loaded = await deps.getImages(allIds)
      const map = new Map<string, AttachedImage>()
      allIds.forEach((id, i) => { if (loaded[i]) map.set(id, loaded[i]!) })
      for (const msg of msgs) {
        if (msg.role === 'user' && msg.imageIds?.length) {
          msg.images = msg.imageIds.map(id => map.get(id)!).filter(Boolean)
        }
      }
    }

    messages.value = msgs

    // Clean up stale localStorage backup after successful DB load
    try { localStorage.removeItem(`bond:msg-backup:${sessionId}`) } catch {}
  }

  function clearMessages() {
    messages.value = []
    currentSessionId.value = null
  }

  async function submit(text: string, images?: AttachedImage[]) {
    const trimmed = text.trim()
    const sid = currentSessionId.value
    if ((!trimmed && !images?.length) || !sid) return

    // If busy, queue the message for later
    if (busySessions.value.has(sid)) {
      queuedMessages.value = [...queuedMessages.value, {
        id: uid(),
        sessionId: sid,
        text: trimmed,
        images: images?.length ? images : undefined
      }]
      return
    }

    const userMessageId = uid()
    addMessageTo(messages.value, { id: userMessageId, role: 'user', text: trimmed, images: images?.length ? images : undefined })
    const activityData: TurnActivityData = { turnId: uid(), userMessageId, status: 'working', startedAt: Date.now(), events: [] }
    const activityMsg: Message & { role: 'meta'; kind: 'activity' } = { id: uid(), role: 'meta', kind: 'activity', data: activityData, ts: activityData.startedAt }
    addMessageTo(messages.value, activityMsg)
    activeActivityIds.set(sid, activityMsg.id)

    // Detect skill invocation: /skill-name [args]
    const skillMatch = trimmed.match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/s)
    if (skillMatch) {
      addMessageTo(messages.value, { id: uid(), role: 'meta', kind: 'skill', name: skillMatch[1], args: skillMatch[2] })
    }
    markBusy(sid)

    // Persist user message immediately — ensures it lands in DB before any crash
    await persistMessagesFor(sid)

    // Send returns immediately now (fire-and-forget). Busy state is cleared
    // by the query_end chunk from the daemon, not here.
    try {
      const res = await deps.send(trimmed, sid, images)
      if (res.ok && res.imageIds?.length) {
        // User might have switched sessions during send — target the right array
        const msgs = getMessagesFor(sid)
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          if (m.role === 'user' && m.images?.length) {
            m.imageIds = res.imageIds
            break
          }
        }
      }
      if (!res.ok && res.error) {
        const msgs = getMessagesFor(sid)
        addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'error', text: res.error })
        markIdle(sid)
        updateActivity(sid, data => { data.status = 'failed'; data.expanded = true; data.endedAt = Date.now(); data.events.push({ id: uid(), type: 'error', label: 'Error', ts: Date.now(), text: res.error! }) })
        activeActivityIds.delete(sid)
        endStreamingOn(msgs)
        await persistMessagesFor(sid)
      }
    } catch {
      const msgs = getMessagesFor(sid)
      markIdle(sid)
      updateActivity(sid, data => { data.status = 'failed'; data.expanded = true; data.endedAt = Date.now(); data.events.push({ id: uid(), type: 'error', label: 'Error', ts: Date.now(), text: 'Send failed' }) })
      activeActivityIds.delete(sid)
      endStreamingOn(msgs)
      await persistMessagesFor(sid)
    }
  }

  async function respondToApproval(requestId: string, approved: boolean) {
    let match: { sessionId: string; message: Message & { role: 'meta'; kind: 'activity' }; event: Extract<TurnActivityEvent, { type: 'approval' }> } | undefined
    const sources: Array<[string, Message[]]> = [
      ...(currentSessionId.value ? [[currentSessionId.value, messages.value] as [string, Message[]]] : []),
      ...backgroundMessages.entries(),
    ]
    for (const [sessionId, sessionMessages] of sources) {
      for (const m of sessionMessages) {
        if (m.role !== 'meta' || m.kind !== 'activity') continue
        const evt = m.data.events.find((e): e is Extract<TurnActivityEvent, { type: 'approval' }> => e.type === 'approval' && e.requestId === requestId)
        if (evt) match = { sessionId, message: m, event: evt }
      }
    }
    if (!match) return

    try {
      const result = await deps.respondToApproval(requestId, approved)
      if (!result.ok) return
    } catch {
      return
    }

    match.event.status = approved ? 'approved' : 'denied'
    match.event.endTs = Date.now()
    const stillPending = match.message.data.events.some(e => e.type === 'approval' && e.status === 'pending')
    if (match.message.data.status === 'awaiting_approval' && !stillPending) match.message.data.status = 'working'
    activityRevision.value++
    persistMessagesFor(match.sessionId)
  }

  function removeQueuedMessage(id: string) {
    queuedMessages.value = queuedMessages.value.filter(m => m.id !== id)
  }

  function cancel() {
    const sid = currentSessionId.value
    if (sid) {
      // Clear queued messages for this session
      queuedMessages.value = queuedMessages.value.filter(m => m.sessionId !== sid)
      markIdle(sid)
      updateActivity(sid, data => {
        const endedAt = Date.now()
        finalizeOpenActivityEvents(data, endedAt)
        cancelPendingApprovals(data, endedAt)
        data.status = 'cancelled'
        data.endedAt = endedAt
      })
      activeActivityIds.delete(sid)
    }
    deps.cancel(sid ?? undefined).catch(() => {})
    if (sid) {
      endStreamingOn(messages.value)
      flushPersistFor(sid)
    }
  }

  /** Re-persist all in-memory messages after daemon reconnection.
   *  Covers the gap where streaming data was in memory but couldn't be saved
   *  because the daemon was down. */
  async function repersistAll() {
    if (currentSessionId.value && messages.value.length) {
      await persistMessagesFor(currentSessionId.value).catch(() => {})
    }
    for (const [sessionId, msgs] of backgroundMessages) {
      if (msgs.length) {
        await deps.saveMessages(sessionId, toSessionMessages(msgs)).catch(() => {})
      }
    }
  }

  /** Stash all in-memory messages to localStorage as an emergency backup.
   *  Called on beforeunload and connection loss. */
  function stashToLocalStorage() {
    const ts = String(Date.now())
    // Stash current session
    const sid = currentSessionId.value
    if (sid && messages.value.length) {
      try {
        const key = `bond:msg-backup:${sid}`
        localStorage.setItem(key, JSON.stringify(toSessionMessages(messages.value)))
        localStorage.setItem('bond:msg-backup-ts', ts)
      } catch { /* quota exceeded — best effort */ }
    }
    // Stash background sessions too
    for (const [bgSid, msgs] of backgroundMessages) {
      if (!msgs.length) continue
      try {
        const key = `bond:msg-backup:${bgSid}`
        localStorage.setItem(key, JSON.stringify(toSessionMessages(msgs)))
      } catch { /* quota exceeded — stop trying */ break }
    }
  }

  /** Restore messages from localStorage backup if DB has fewer or less content.
   *  Compares both message count and total text length to catch truncated responses.
   *  Returns true if backup was applied. */
  async function restoreFromBackupIfNeeded(sessionId: string): Promise<boolean> {
    try {
      const key = `bond:msg-backup:${sessionId}`
      const raw = localStorage.getItem(key)
      if (!raw) return false

      const backed: SessionMessage[] = JSON.parse(raw)
      const dbMsgs = await deps.getMessages(sessionId)

      const textLen = (msgs: SessionMessage[]) =>
        msgs.reduce((sum, m) => sum + (m.text?.length ?? 0), 0)

      // Prefer backup if it has more messages OR significantly more text content
      // (catches truncated responses where message count is the same)
      if (backed.length > dbMsgs.length || textLen(backed) > textLen(dbMsgs) + 50) {
        await deps.saveMessages(sessionId, backed)
        localStorage.removeItem(key)
        return true
      }

      localStorage.removeItem(key)
    } catch { /* corrupt backup — ignore */ }
    return false
  }

  function subscribe() {
    unsub = deps.onChunk(handleChunk)
  }

  function unsubscribe() {
    unsub?.()
  }

  // Stash reactive state before HMR disposes this module
  if (import.meta.hot) {
    import.meta.hot.dispose((data) => {
      // Flush all pending throttled persists before stashing state
      for (const [sessionId, timer] of persistTimers) {
        clearTimeout(timer)
        persistMessagesFor(sessionId) // fire-and-forget (dispose is sync)
      }
      persistTimers.clear()

      // Stop all streaming stash intervals
      for (const timer of streamingStashTimers.values()) clearInterval(timer)
      streamingStashTimers.clear()

      // Stash to localStorage as a synchronous safety net — the async persist
      // above may not complete before the module unloads.
      try {
        const sid = currentSessionId.value
        if (sid && messages.value.length) {
          localStorage.setItem(`bond:msg-backup:${sid}`, JSON.stringify(toSessionMessages(messages.value)))
          localStorage.setItem('bond:msg-backup-ts', String(Date.now()))
        }
        for (const [sessionId, msgs] of backgroundMessages) {
          if (msgs.length) {
            localStorage.setItem(`bond:msg-backup:${sessionId}`, JSON.stringify(toSessionMessages(msgs)))
          }
        }
      } catch { /* quota — best effort */ }

      data.messages = messages.value
      data.busySessions = [...busySessions.value]
      data.sessionId = currentSessionId.value
      data.backgroundMessages = [...backgroundMessages.entries()]
      data.queuedMessages = queuedMessages.value
    })
  }

  // After HMR restore, persist all stashed sessions to ensure DB is in sync.
  // These are awaited to ensure the DB is up to date before new operations.
  if (_hmrNeedsPersist) {
    ;(async () => {
      if (currentSessionId.value && messages.value.length) {
        await persistMessagesFor(currentSessionId.value)
      }
      for (const [sessionId, msgs] of backgroundMessages) {
        if (msgs.length) {
          await deps.saveMessages(sessionId, toSessionMessages(msgs))
        }
      }
    })()
  }

  return {
    messages,
    busy,
    busySessionIds: busySessions,
    pendingApprovals,
    contextUsage,
    currentSessionId,
    queuedMessages,
    currentQueue,
    submit,
    cancel,
    removeQueuedMessage,
    respondToApproval,
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
