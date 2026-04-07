/// <reference types="vite/client" />
import { ref, computed } from 'vue'
import type { BondStreamChunk, TaggedChunk } from '../../shared/stream'
import type { SessionMessage, AttachedImage } from '../../shared/session'
import type { Message } from '../types/message'

export interface ActivityEvent {
  type: 'thinking' | 'tool' | 'responding'
  label: string
  ts: number
  durationSec?: number
  toolName?: string
  input?: Record<string, unknown>
  output?: string
}

export type ActivityState =
  | { type: 'idle' }
  | { type: 'working'; startedAt: number; events: ActivityEvent[] }
  | { type: 'thinking'; snippet: string; startedAt: number; events: ActivityEvent[] }
  | { type: 'tool'; name: string; detail?: string; startedAt: number; events: ActivityEvent[] }
  | { type: 'responding'; startedAt: number; events: ActivityEvent[] }
  | { type: 'done'; startedAt: number; endedAt: number; events: ActivityEvent[] }

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
    if (m.kind === 'error') return { id: m.id, role: 'meta', kind: 'error', text: m.text ?? '' }
    return { id: m.id, role: 'meta', kind: 'system', text: m.text ?? '' }
  }).filter((m): m is Message => m !== null)
}

// Preserve chat state across HMR reloads so in-flight streaming
// isn't lost when Vite hot-updates a module during a response.
const _hmr = import.meta.hot?.data as
  | { messages?: Message[]; busySessions?: string[]; sessionId?: string | null; backgroundMessages?: [string, Message[]][]; activityMap?: [string, ActivityState][]; thinkingBufs?: [string, string][]; eventsMap?: [string, ActivityEvent[]][]; queuedMessages?: QueuedMessage[] }
  | undefined
const _hmrNeedsPersist = !!(_hmr?.messages?.length || _hmr?.backgroundMessages?.length)

export function useChat(deps: ChatDeps = window.bond) {
  /** Messages for the current session (reactive, rendered by template) */
  const messages = ref<Message[]>(_hmr?.messages ?? [])
  const busySessions = ref<Set<string>>(new Set(_hmr?.busySessions ?? []))
  const queuedMessages = ref<QueuedMessage[]>(_hmr?.queuedMessages ?? [])
  const currentSessionId = ref<string | null>(_hmr?.sessionId ?? null)

  /** Messages for non-current sessions that are still receiving chunks */
  const backgroundMessages = new Map<string, Message[]>(_hmr?.backgroundMessages ?? [])

  /** Per-session activity tracking */
  const _activityMap = new Map<string, ActivityState>(_hmr?.activityMap ?? [])
  const _thinkingBufs = new Map<string, string>(_hmr?.thinkingBufs ?? [])
  const _eventsMap = new Map<string, ActivityEvent[]>(_hmr?.eventsMap ?? [])
  const activity = ref<ActivityState>(
    _hmr?.sessionId ? (_activityMap.get(_hmr.sessionId) ?? { type: 'idle' }) : { type: 'idle' }
  )

  function _getEvents(sid: string): ActivityEvent[] {
    let events = _eventsMap.get(sid)
    if (!events) { events = []; _eventsMap.set(sid, events) }
    return events
  }

  function _getStartedAt(sid: string): number {
    const existing = _activityMap.get(sid)
    return (existing && existing.type !== 'idle') ? existing.startedAt : Date.now()
  }

  type ActivityBase =
    | { type: 'working'; startedAt: number }
    | { type: 'thinking'; snippet: string; startedAt: number }
    | { type: 'tool'; name: string; detail?: string; startedAt: number }
    | { type: 'responding'; startedAt: number }
    | { type: 'done'; startedAt: number; endedAt: number }

  function _setActivity(sid: string, base: ActivityBase) {
    const events = _getEvents(sid)
    const state = { ...base, events } as ActivityState
    _activityMap.set(sid, state)
    if (sid === currentSessionId.value) activity.value = state
    // Persist done states to localStorage so the activity bar survives view/session switches
    if (base.type === 'done') {
      try {
        localStorage.setItem(`bond:activity:${sid}`, JSON.stringify({
          startedAt: base.startedAt,
          endedAt: (base as { endedAt: number }).endedAt,
          events,
        }))
      } catch { /* quota — best effort */ }
    }
  }

  function _clearActivity(sid: string) {
    _activityMap.delete(sid)
    _thinkingBufs.delete(sid)
    _eventsMap.delete(sid)
    try { localStorage.removeItem(`bond:activity:${sid}`) } catch {}
    if (sid === currentSessionId.value) activity.value = { type: 'idle' }
  }

  function _restoreActivity(sid: string): ActivityState | null {
    try {
      const raw = localStorage.getItem(`bond:activity:${sid}`)
      if (!raw) return null
      const data = JSON.parse(raw)
      const events: ActivityEvent[] = data.events ?? []
      // Hydrate the events into the maps so subsequent updates work
      _eventsMap.set(sid, events)
      const state: ActivityState = { type: 'done', startedAt: data.startedAt, endedAt: data.endedAt, events }
      _activityMap.set(sid, state)
      return state
    } catch { return null }
  }

  function _finalizeThinkingEvent(sid: string) {
    const events = _eventsMap.get(sid)
    if (!events) return
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'thinking' && events[i].durationSec == null) {
        events[i].durationSec = Math.max(1, Math.round((Date.now() - events[i].ts) / 1000))
        break
      }
    }
  }

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

  function markBusy(sessionId: string) {
    busySessions.value = new Set([...busySessions.value, sessionId])
  }

  function markIdle(sessionId: string) {
    const next = new Set(busySessions.value)
    next.delete(sessionId)
    busySessions.value = next
  }

  let unsub: (() => void) | undefined
  const thinkingStartTimes = new Map<string, number>()
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const streamingStashTimers = new Map<string, ReturnType<typeof setInterval>>()
  const queryEndCallbacks: Array<(sessionId: string) => void> = []

  /** Periodically stash messages to localStorage during streaming.
   *  Survives hard renderer crashes (OOM, GPU crash) where beforeunload never fires. */
  function startStreamingStash(sessionId: string) {
    stopStreamingStash(sessionId)
    streamingStashTimers.set(sessionId, setInterval(() => {
      const msgs = sessionId === currentSessionId.value
        ? messages.value
        : backgroundMessages.get(sessionId)
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
    return persistMessagesFor(sessionId)
  }

  function addMessageTo(msgs: Message[], msg: Message) {
    if (!msg.ts) msg.ts = Date.now()
    msgs.push(msg)
  }

  function finalizeThinkingOn(msgs: Message[], sessionId: string) {
    const startTime = thinkingStartTimes.get(sessionId) ?? 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === 'meta' && m.kind === 'thinking' && m.streaming) {
        if (!m.text) {
          msgs.splice(i, 1)
        } else {
          m.streaming = false
          m.durationSec = startTime
            ? Math.round((Date.now() - startTime) / 1000)
            : undefined
        }
        thinkingStartTimes.delete(sessionId)
        break
      }
    }
  }

  function endStreamingOn(msgs: Message[]) {
    const last = msgs[msgs.length - 1]
    if (last?.role === 'bond' && last.streaming) {
      last.streaming = false
    }
  }

  function handleChunk(chunk: TaggedChunk) {
    // Per-session busy tracking — always processed regardless of active session
    if (chunk.kind === 'query_start') {
      markBusy(chunk.sessionId)
      _thinkingBufs.delete(chunk.sessionId)
      _eventsMap.set(chunk.sessionId, [])
      _setActivity(chunk.sessionId, { type: 'working', startedAt: Date.now() })
      startStreamingStash(chunk.sessionId)
      return
    }
    if (chunk.kind === 'query_end') {
      markIdle(chunk.sessionId)
      stopStreamingStash(chunk.sessionId)
      _finalizeThinkingEvent(chunk.sessionId)
      const events = _getEvents(chunk.sessionId)
      _setActivity(chunk.sessionId, { type: 'done', startedAt: _getStartedAt(chunk.sessionId), endedAt: Date.now() })
      // Clean up buffers but keep events for the done state
      _thinkingBufs.delete(chunk.sessionId)
      queryEndCallbacks.forEach(fn => fn(chunk.sessionId))
      const msgs = getMessagesFor(chunk.sessionId)
      finalizeThinkingOn(msgs, chunk.sessionId)
      endStreamingOn(msgs)
      // Persist synchronously (within the chunk handler's microtask) then clean up.
      // Using an async IIFE ensures the flush completes before background buffer cleanup,
      // preventing the race where loadSession reads stale DB data.
      ;(async () => {
        await flushPersistFor(chunk.sessionId)
        if (chunk.sessionId !== currentSessionId.value) {
          backgroundMessages.delete(chunk.sessionId)
        }
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
      return
    }

    // Route to the correct session's message array
    const sid = chunk.sessionId
    const msgs = getMessagesFor(sid)

    // Thinking deltas accumulate into the current thinking message
    if (chunk.kind === 'thinking_text') {
      // Push event on first thinking chunk of this round
      const cur = _activityMap.get(sid)
      if (cur?.type !== 'thinking') {
        _getEvents(sid).push({ type: 'thinking', label: 'Thinking', ts: Date.now() })
      }
      // Update activity to thinking with snippet
      let buf = _thinkingBufs.get(sid) ?? ''
      buf += chunk.text
      _thinkingBufs.set(sid, buf)
      const clean = buf.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
      const snippet = clean.length > 120 ? '…' + clean.slice(-120) : clean
      _setActivity(sid, { type: 'thinking', snippet, startedAt: _getStartedAt(sid) })

      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.role === 'meta' && m.kind === 'thinking' && m.streaming) {
          if (!m.text && !thinkingStartTimes.has(sid)) thinkingStartTimes.set(sid, Date.now())
          m.text += chunk.text
          return
        }
      }
      // No streaming thinking message exists — create one (e.g. mid-turn thinking)
      thinkingStartTimes.set(sid, Date.now())
      addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'thinking', text: chunk.text, streaming: true })
      return
    }

    // Any non-thinking chunk finalizes the thinking message and events
    finalizeThinkingOn(msgs, sid)
    _finalizeThinkingEvent(sid)
    _thinkingBufs.delete(sid)

    switch (chunk.kind) {
      case 'assistant_text': {
        const cur = _activityMap.get(sid)
        if (cur?.type !== 'responding') {
          _getEvents(sid).push({ type: 'responding', label: 'Responding', ts: Date.now() })
          _setActivity(sid, { type: 'responding', startedAt: _getStartedAt(sid) })
        }
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
        _getEvents(sid).push({ type: 'tool', label: _formatToolLabel(chunk.name, chunk.summary), ts: Date.now(), toolName: chunk.name, input: chunk.input })
        _setActivity(sid, { type: 'tool', name: chunk.name, detail: chunk.summary, startedAt: _getStartedAt(sid) })
        addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'tool', name: chunk.name, summary: chunk.summary })
        schedulePersistFor(sid)
        break

      case 'tool_result': {
        // Attach output to the most recent tool event
        const evts = _getEvents(sid)
        for (let i = evts.length - 1; i >= 0; i--) {
          if (evts[i].type === 'tool' && !evts[i].output) {
            evts[i].output = chunk.output
            break
          }
        }
        break
      }

      case 'tool_approval':
        addMessageTo(msgs, {
          id: uid(),
          role: 'meta',
          kind: 'approval',
          requestId: chunk.requestId,
          toolName: chunk.toolName,
          input: chunk.input,
          title: chunk.title,
          description: chunk.description,
          status: 'pending'
        })
        break

      case 'result':
        if (chunk.errors?.length) {
          addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'error', text: chunk.errors.join('; ') })
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
        addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'error', text: chunk.message })
        flushPersistFor(sid)
        break

      case 'system':
        addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'system', text: chunk.text ?? chunk.subtype })
        break
    }
  }

  async function persistMessagesFor(sessionId: string) {
    const msgs = sessionId === currentSessionId.value
      ? messages.value
      : backgroundMessages.get(sessionId)
    if (!msgs || !msgs.length) return

    const data = toSessionMessages(msgs)
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
  }

  async function persistMessages() {
    if (currentSessionId.value) {
      await persistMessagesFor(currentSessionId.value)
    }
  }

  async function loadSession(sessionId: string) {
    const oldSid = currentSessionId.value
    if (oldSid) {
      await flushPersistFor(oldSid)
      // Stash current messages if the old session is still busy (receiving chunks)
      if (busySessions.value.has(oldSid)) {
        backgroundMessages.set(oldSid, [...messages.value])
      }
    }

    currentSessionId.value = sessionId
    activity.value = _activityMap.get(sessionId) ?? _restoreActivity(sessionId) ?? { type: 'idle' }

    // Restore from background buffer if available (preserves in-flight responses)
    const bg = backgroundMessages.get(sessionId)
    if (bg) {
      messages.value = bg
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
  }

  function clearMessages() {
    messages.value = []
    currentSessionId.value = null
    activity.value = { type: 'idle' }
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

    addMessageTo(messages.value, { id: uid(), role: 'user', text: trimmed, images: images?.length ? images : undefined })

    // Detect skill invocation: /skill-name [args]
    const skillMatch = trimmed.match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/s)
    if (skillMatch) {
      addMessageTo(messages.value, { id: uid(), role: 'meta', kind: 'skill', name: skillMatch[1], args: skillMatch[2] })
    }
    markBusy(sid)
    thinkingStartTimes.set(sid, Date.now())
    addMessageTo(messages.value, { id: uid(), role: 'meta', kind: 'thinking', text: '', streaming: true })

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
        _clearActivity(sid)
        finalizeThinkingOn(msgs, sid)
        endStreamingOn(msgs)
        await persistMessagesFor(sid)
      }
    } catch {
      const msgs = getMessagesFor(sid)
      markIdle(sid)
      _clearActivity(sid)
      finalizeThinkingOn(msgs, sid)
      endStreamingOn(msgs)
      await persistMessagesFor(sid)
    }
  }

  function respondToApproval(requestId: string, approved: boolean) {
    const msg = messages.value.find(
      (m) => m.role === 'meta' && m.kind === 'approval' && m.requestId === requestId
    )
    if (msg && msg.role === 'meta' && msg.kind === 'approval') {
      msg.status = approved ? 'approved' : 'denied'
    }
    deps.respondToApproval(requestId, approved)
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
      _finalizeThinkingEvent(sid)
      const events = _getEvents(sid)
      if (events.length > 0) {
        _setActivity(sid, { type: 'done', startedAt: _getStartedAt(sid), endedAt: Date.now() })
      } else {
        _clearActivity(sid)
      }
      _thinkingBufs.delete(sid)
    }
    deps.cancel(sid ?? undefined).catch(() => {})
    if (sid) {
      finalizeThinkingOn(messages.value, sid)
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

  /** Restore messages from localStorage backup if DB has fewer.
   *  Returns true if backup was applied. */
  async function restoreFromBackupIfNeeded(sessionId: string): Promise<boolean> {
    try {
      const key = `bond:msg-backup:${sessionId}`
      const raw = localStorage.getItem(key)
      if (!raw) return false

      const backed: SessionMessage[] = JSON.parse(raw)
      const dbMsgs = await deps.getMessages(sessionId)

      if (backed.length > dbMsgs.length) {
        // Backup has more messages — save it to DB
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
      data.activityMap = [..._activityMap.entries()]
      data.thinkingBufs = [..._thinkingBufs.entries()]
      data.eventsMap = [..._eventsMap.entries()]
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
    activity,
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
