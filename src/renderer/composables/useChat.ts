import { ref } from 'vue'
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
  | { messages?: Message[]; busy?: boolean; sessionId?: string | null }
  | undefined

export function useChat(deps: ChatDeps = window.bond) {
  const messages = ref<Message[]>(_hmr?.messages ?? [])
  const busy = ref(_hmr?.busy ?? false)
  const currentSessionId = ref<string | null>(_hmr?.sessionId ?? null)

  let unsub: (() => void) | undefined
  let thinkingStartedAt = 0

  function addMessage(msg: Message) {
    messages.value.push(msg)
  }

  function finalizeThinking() {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.role === 'meta' && m.kind === 'thinking' && m.streaming) {
        if (!m.text) {
          // No thinking text arrived — remove the placeholder
          messages.value.splice(i, 1)
        } else {
          m.streaming = false
          m.durationSec = thinkingStartedAt
            ? Math.round((Date.now() - thinkingStartedAt) / 1000)
            : undefined
        }
        thinkingStartedAt = 0
        break
      }
    }
  }

  function handleChunk(chunk: TaggedChunk) {
    // Ignore chunks for other sessions
    if (chunk.sessionId !== currentSessionId.value) return

    // Thinking deltas accumulate into the current thinking message
    if (chunk.kind === 'thinking_text') {
      // Find the streaming thinking message (may not be last due to interleaved tool messages)
      for (let i = messages.value.length - 1; i >= 0; i--) {
        const m = messages.value[i]
        if (m.role === 'meta' && m.kind === 'thinking' && m.streaming) {
          if (!m.text && !thinkingStartedAt) thinkingStartedAt = Date.now()
          m.text += chunk.text
          return
        }
      }
      // No streaming thinking message exists — create one (e.g. mid-turn thinking)
      thinkingStartedAt = Date.now()
      addMessage({ id: uid(), role: 'meta', kind: 'thinking', text: chunk.text, streaming: true })
      return
    }

    // Any non-thinking chunk finalizes the thinking message
    finalizeThinking()

    switch (chunk.kind) {
      case 'assistant_text': {
        const last = messages.value[messages.value.length - 1]
        if (last?.role === 'bond' && last.streaming) {
          last.text += chunk.text
        } else {
          messages.value.push({ id: uid(), role: 'bond', text: chunk.text, streaming: true })
        }
        break
      }

      case 'assistant_tool':
        addMessage({ id: uid(), role: 'meta', kind: 'tool', name: chunk.name, summary: chunk.summary })
        break

      case 'tool_approval':
        addMessage({
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
          addMessage({ id: uid(), role: 'meta', kind: 'error', text: chunk.errors.join('; ') })
        }
        {
          const last = messages.value[messages.value.length - 1]
          if (last?.role === 'bond' && last.streaming) {
            last.streaming = false
          } else if (chunk.result && (!last || last.role !== 'bond')) {
            // Fallback: if no streaming message was created, use the result text
            addMessage({ id: uid(), role: 'bond', text: chunk.result, streaming: false })
          }
        }
        // Auto-save after each completed turn
        persistMessages()
        break

      case 'raw_error':
        addMessage({ id: uid(), role: 'meta', kind: 'error', text: chunk.message })
        break

      case 'system':
        addMessage({ id: uid(), role: 'meta', kind: 'system', text: chunk.text ?? chunk.subtype })
        break
    }
  }

  function endStreaming() {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'bond' && last.streaming) {
      last.streaming = false
    }
  }

  async function persistMessages() {
    if (currentSessionId.value) {
      await deps.saveMessages(currentSessionId.value, toSessionMessages(messages.value))
    }
  }

  async function loadSession(sessionId: string) {
    // Save current session before switching
    await persistMessages()
    currentSessionId.value = sessionId
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
    if ((!trimmed && !images?.length) || busy.value) return

    addMessage({ id: uid(), role: 'user', text: trimmed, images: images?.length ? images : undefined })

    // Detect skill invocation: /skill-name [args]
    const skillMatch = trimmed.match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/s)
    if (skillMatch) {
      addMessage({ id: uid(), role: 'meta', kind: 'skill', name: skillMatch[1], args: skillMatch[2] })
    }
    busy.value = true
    thinkingStartedAt = Date.now()
    addMessage({ id: uid(), role: 'meta', kind: 'thinking', text: '', streaming: true })

    // Persist user message in background — don't block the send
    persistMessages()

    try {
      const res = await deps.send(trimmed, currentSessionId.value ?? undefined, images)
      if (res.ok && res.imageIds?.length) {
        // Swap inline base64 for image IDs on the user message we just added
        for (let i = messages.value.length - 1; i >= 0; i--) {
          const m = messages.value[i]
          if (m.role === 'user' && m.images?.length) {
            m.imageIds = res.imageIds
            break
          }
        }
      }
      if (!res.ok && res.error) {
        addMessage({ id: uid(), role: 'meta', kind: 'error', text: res.error })
      }
    } finally {
      busy.value = false
      finalizeThinking()
      endStreaming()
      await persistMessages()
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
    deps.cancel(currentSessionId.value ?? undefined)
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
      data.busy = busy.value
      data.sessionId = currentSessionId.value
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
    persistMessages
  }
}
