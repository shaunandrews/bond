import { ref, computed } from 'vue'
import type { BondStreamChunk, TaggedChunk } from '../../shared/stream'
import type { SessionMessage, AttachedImage } from '../../shared/session'
import type { Message } from '../types/message'

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
  return msgs.map((m) => {
    if (m.role === 'user') return { id: m.id, role: 'user' as const, text: m.text ?? '', images: m.images, imageIds: m.imageIds }
    if (m.role === 'bond') return { id: m.id, role: 'bond' as const, text: m.text ?? '', streaming: false }
    if (m.kind === 'tool') return { id: m.id, role: 'meta' as const, kind: 'tool' as const, name: m.name ?? '', summary: m.summary }
    if (m.kind === 'skill') return { id: m.id, role: 'meta' as const, kind: 'skill' as const, name: m.name ?? '', args: m.summary }
    if (m.kind === 'thinking') return { id: m.id, role: 'meta' as const, kind: 'thinking' as const, text: m.text ?? '', durationSec: m.summary ? parseInt(m.summary, 10) : undefined, streaming: false }
    if (m.kind === 'approval') return { id: m.id, role: 'meta' as const, kind: 'approval' as const, requestId: '', toolName: m.name ?? '', input: {}, description: m.summary, status: (m.status as 'approved' | 'denied') ?? 'denied' }
    if (m.kind === 'error') return { id: m.id, role: 'meta' as const, kind: 'error' as const, text: m.text ?? '' }
    return { id: m.id, role: 'meta' as const, kind: 'system' as const, text: m.text ?? '' }
  })
}

// Preserve chat state across HMR reloads so in-flight streaming
// isn't lost when Vite hot-updates a module during a response.
const _hmr = import.meta.hot?.data as
  | { messages?: Message[]; busySessions?: string[]; sessionId?: string | null; backgroundMessages?: [string, Message[]][] }
  | undefined

export function useChat(deps: ChatDeps = window.bond) {
  /** Messages for the current session (reactive, rendered by template) */
  const messages = ref<Message[]>(_hmr?.messages ?? [])
  const busySessions = ref<Set<string>>(new Set(_hmr?.busySessions ?? []))
  const currentSessionId = ref<string | null>(_hmr?.sessionId ?? null)

  /** Messages for non-current sessions that are still receiving chunks */
  const backgroundMessages = new Map<string, Message[]>(_hmr?.backgroundMessages ?? [])

  const busy = computed(() => {
    const sid = currentSessionId.value
    return sid ? busySessions.value.has(sid) : false
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
  const thinkingStartTimes = new Map<string, number>()
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const queryEndCallbacks: Array<(sessionId: string) => void> = []

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

  function flushPersistFor(sessionId: string) {
    const timer = persistTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      persistTimers.delete(sessionId)
    }
    persistMessagesFor(sessionId)
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
      return
    }
    if (chunk.kind === 'query_end') {
      markIdle(chunk.sessionId)
      queryEndCallbacks.forEach(fn => fn(chunk.sessionId))
      const msgs = getMessagesFor(chunk.sessionId)
      finalizeThinkingOn(msgs, chunk.sessionId)
      endStreamingOn(msgs)
      flushPersistFor(chunk.sessionId)
      // Clean up background buffer after persisting — DB has the final state
      if (chunk.sessionId !== currentSessionId.value) {
        backgroundMessages.delete(chunk.sessionId)
      }
      return
    }

    // Route to the correct session's message array
    const sid = chunk.sessionId
    const msgs = getMessagesFor(sid)

    // Thinking deltas accumulate into the current thinking message
    if (chunk.kind === 'thinking_text') {
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

    // Any non-thinking chunk finalizes the thinking message
    finalizeThinkingOn(msgs, sid)

    switch (chunk.kind) {
      case 'assistant_text': {
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
        addMessageTo(msgs, { id: uid(), role: 'meta', kind: 'tool', name: chunk.name, summary: chunk.summary })
        schedulePersistFor(sid)
        break

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
    if (msgs) {
      await deps.saveMessages(sessionId, toSessionMessages(msgs))
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
      flushPersistFor(oldSid)
      // Stash current messages if the old session is still busy (receiving chunks)
      if (busySessions.value.has(oldSid)) {
        backgroundMessages.set(oldSid, [...messages.value])
      }
    }

    currentSessionId.value = sessionId

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
  }

  async function submit(text: string, images?: AttachedImage[]) {
    const trimmed = text.trim()
    const sid = currentSessionId.value
    if ((!trimmed && !images?.length) || !sid || busySessions.value.has(sid)) return

    addMessageTo(messages.value, { id: uid(), role: 'user', text: trimmed, images: images?.length ? images : undefined })

    // Detect skill invocation: /skill-name [args]
    const skillMatch = trimmed.match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/s)
    if (skillMatch) {
      addMessageTo(messages.value, { id: uid(), role: 'meta', kind: 'skill', name: skillMatch[1], args: skillMatch[2] })
    }
    markBusy(sid)
    thinkingStartTimes.set(sid, Date.now())
    addMessageTo(messages.value, { id: uid(), role: 'meta', kind: 'thinking', text: '', streaming: true })

    // Persist user message in background — don't block the send
    persistMessagesFor(sid)

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
        finalizeThinkingOn(msgs, sid)
        endStreamingOn(msgs)
        await persistMessagesFor(sid)
      }
    } catch {
      const msgs = getMessagesFor(sid)
      markIdle(sid)
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

  function cancel() {
    const sid = currentSessionId.value
    if (sid) markIdle(sid)
    deps.cancel(sid ?? undefined).catch(() => {})
    if (sid) {
      finalizeThinkingOn(messages.value, sid)
      endStreamingOn(messages.value)
      flushPersistFor(sid)
    }
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
      data.messages = messages.value
      data.busySessions = [...busySessions.value]
      data.sessionId = currentSessionId.value
      data.backgroundMessages = [...backgroundMessages.entries()]
    })
  }

  return {
    messages,
    busy,
    currentSessionId,
    submit,
    cancel,
    respondToApproval,
    subscribe,
    unsubscribe,
    loadSession,
    clearMessages,
    persistMessages,
    onQueryEnd
  }
}
