import { ref } from 'vue'
import type { BondStreamChunk } from '../../shared/stream'
import type { SessionMessage } from '../../shared/session'
import type { Message } from '../types/message'

export interface ChatDeps {
  send: (text: string) => Promise<{ ok: boolean; error?: string }>
  cancel: () => Promise<{ ok: boolean }>
  onChunk: (fn: (chunk: BondStreamChunk) => void) => () => void
  getMessages: (sessionId: string) => Promise<SessionMessage[]>
  saveMessages: (sessionId: string, messages: SessionMessage[]) => Promise<boolean>
}

function uid(): string {
  return crypto.randomUUID()
}

function toSessionMessages(msgs: Message[]): SessionMessage[] {
  return msgs.map((m) => {
    if (m.role === 'user') return { id: m.id, role: 'user', text: m.text }
    if (m.role === 'bond') return { id: m.id, role: 'bond', text: m.text, streaming: false }
    if (m.kind === 'tool') return { id: m.id, role: 'meta', kind: 'tool', name: m.name, summary: m.summary }
    if (m.kind === 'error') return { id: m.id, role: 'meta', kind: 'error', text: m.text }
    return { id: m.id, role: 'meta', kind: 'system', text: m.text }
  })
}

function fromSessionMessages(msgs: SessionMessage[]): Message[] {
  return msgs.map((m) => {
    if (m.role === 'user') return { id: m.id, role: 'user' as const, text: m.text ?? '' }
    if (m.role === 'bond') return { id: m.id, role: 'bond' as const, text: m.text ?? '', streaming: false }
    if (m.kind === 'tool') return { id: m.id, role: 'meta' as const, kind: 'tool' as const, name: m.name ?? '', summary: m.summary }
    if (m.kind === 'error') return { id: m.id, role: 'meta' as const, kind: 'error' as const, text: m.text ?? '' }
    return { id: m.id, role: 'meta' as const, kind: 'system' as const, text: m.text ?? '' }
  })
}

export function useChat(deps: ChatDeps = window.bond) {
  const messages = ref<Message[]>([])
  const busy = ref(false)
  const thinking = ref(false)
  const currentSessionId = ref<string | null>(null)

  let unsub: (() => void) | undefined

  function addMessage(msg: Message) {
    messages.value.push(msg)
  }

  function handleChunk(chunk: BondStreamChunk) {
    thinking.value = false

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

      case 'result':
        if (chunk.errors?.length) {
          addMessage({ id: uid(), role: 'meta', kind: 'error', text: chunk.errors.join('; ') })
        }
        {
          const last = messages.value[messages.value.length - 1]
          if (last?.role === 'bond' && last.streaming) {
            last.streaming = false
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
    messages.value = fromSessionMessages(saved)
  }

  function clearMessages() {
    messages.value = []
    currentSessionId.value = null
  }

  async function submit(text: string) {
    if (!text.trim() || busy.value) return

    addMessage({ id: uid(), role: 'user', text: text.trim() })
    busy.value = true
    thinking.value = true

    // Persist user message immediately
    await persistMessages()

    try {
      const res = await deps.send(text.trim())
      if (!res.ok && res.error) {
        addMessage({ id: uid(), role: 'meta', kind: 'error', text: res.error })
      }
    } finally {
      busy.value = false
      thinking.value = false
      endStreaming()
      await persistMessages()
    }
  }

  function cancel() {
    deps.cancel()
  }

  function subscribe() {
    unsub = deps.onChunk(handleChunk)
  }

  function unsubscribe() {
    unsub?.()
  }

  return {
    messages,
    busy,
    thinking,
    currentSessionId,
    submit,
    cancel,
    subscribe,
    unsubscribe,
    loadSession,
    clearMessages,
    persistMessages
  }
}
