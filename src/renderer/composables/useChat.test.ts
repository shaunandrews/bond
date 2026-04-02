import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, nextTick } from 'vue'
import { useChat, type ChatDeps } from './useChat'

function mockDeps(): ChatDeps {
  return {
    send: vi.fn().mockResolvedValue({ ok: true }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    onChunk: vi.fn().mockReturnValue(vi.fn()),
    respondToApproval: vi.fn().mockResolvedValue({ ok: true }),
    getMessages: vi.fn().mockResolvedValue([]),
    saveMessages: vi.fn().mockResolvedValue(true),
    getImages: vi.fn().mockResolvedValue([]),
  }
}

type UseChatReturn = ReturnType<typeof useChat>

function withSetup(deps: ChatDeps): UseChatReturn {
  let result!: UseChatReturn
  const app = createApp(
    defineComponent({
      setup() {
        result = useChat(deps)
        return () => null
      },
    })
  )
  app.mount(document.createElement('div'))
  return result
}

describe('useChat', () => {
  let deps: ChatDeps
  let chat: UseChatReturn

  beforeEach(() => {
    deps = mockDeps()
    chat = withSetup(deps)
  })

  describe('submit', () => {
    it('adds a user message and thinking placeholder, then calls send', async () => {
      chat.currentSessionId.value = 'sess-1'
      await chat.submit('hello')

      expect(chat.messages.value[0]).toMatchObject({ role: 'user', text: 'hello' })
      expect(deps.send).toHaveBeenCalledWith('hello', 'sess-1', undefined)
    })

    it('sets busy on submit and clears on query_end chunk', async () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]

      expect(chat.busy.value).toBe(false)

      await chat.submit('hello')
      expect(chat.busy.value).toBe(true)

      handler({ kind: 'query_end', succeeded: true, sessionId: 'sess-1' })
      expect(chat.busy.value).toBe(false)
    })

    it('adds thinking message during send and removes empty one on query_end', async () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]

      await chat.submit('hello')
      expect(chat.messages.value).toHaveLength(2)
      expect(chat.messages.value[1]).toMatchObject({ role: 'meta', kind: 'thinking', streaming: true })

      handler({ kind: 'query_end', succeeded: true, sessionId: 'sess-1' })
      expect(chat.messages.value.find(m => m.role === 'meta' && 'kind' in m && m.kind === 'thinking')).toBeUndefined()
    })

    it('adds error message when send fails', async () => {
      chat.currentSessionId.value = 'sess-1'
      ;(deps.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'boom' })

      await chat.submit('hello')

      expect(chat.messages.value.find(m => m.role === 'meta' && 'kind' in m && m.kind === 'error')).toMatchObject({ text: 'boom' })
    })

    it('ignores empty text', async () => {
      chat.currentSessionId.value = 'sess-1'
      await chat.submit('')
      await chat.submit('   ')

      expect(chat.messages.value).toHaveLength(0)
      expect(deps.send).not.toHaveBeenCalled()
    })

    it('ignores submit while session is busy', async () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()

      await chat.submit('first')
      await chat.submit('second')

      expect(deps.send).toHaveBeenCalledTimes(1)
    })

    it('ignores submit without a session', async () => {
      await chat.submit('hello')

      expect(chat.messages.value).toHaveLength(0)
      expect(deps.send).not.toHaveBeenCalled()
    })

    it('swaps images for imageIds after send returns', async () => {
      chat.currentSessionId.value = 'sess-1'
      const images = [{ data: 'abc123', mediaType: 'image/png' as const }]
      ;(deps.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, imageIds: ['img-1'] })

      await chat.submit('look at this', images)

      const userMsg = chat.messages.value[0]
      expect(userMsg.role).toBe('user')
      if (userMsg.role === 'user') {
        expect(userMsg.imageIds).toEqual(['img-1'])
      }
    })
  })

  describe('concurrent sessions', () => {
    it('tracks busy state per session', async () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]

      await chat.submit('hello')
      expect(chat.busy.value).toBe(true)

      // Switch to a different session
      chat.currentSessionId.value = 'sess-2'
      await nextTick()
      expect(chat.busy.value).toBe(false)

      // Switch back — sess-1 is still busy
      chat.currentSessionId.value = 'sess-1'
      await nextTick()
      expect(chat.busy.value).toBe(true)

      handler({ kind: 'query_end', succeeded: true, sessionId: 'sess-1' })
      expect(chat.busy.value).toBe(false)
    })

    it('query_end for non-current session still clears its busy state', async () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]

      await chat.submit('hello')
      expect(chat.busy.value).toBe(true)

      chat.currentSessionId.value = 'sess-2'
      await nextTick()

      handler({ kind: 'query_end', succeeded: true, sessionId: 'sess-1' })

      chat.currentSessionId.value = 'sess-1'
      await nextTick()
      expect(chat.busy.value).toBe(false)
    })

    it('query_start chunk marks session busy', () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]

      expect(chat.busy.value).toBe(false)
      handler({ kind: 'query_start', sessionId: 'sess-1' })
      expect(chat.busy.value).toBe(true)
    })

    it('buffers chunks for non-current sessions in background', async () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]

      // Submit in sess-1 and switch away
      await chat.submit('hello')

      // Switch to sess-2 — stashes sess-1 messages in background
      await chat.loadSession('sess-2')
      expect(chat.messages.value).toHaveLength(0) // new session, empty

      // Chunks arrive for sess-1 in background
      handler({ kind: 'assistant_text', text: 'response from sess-1', sessionId: 'sess-1' })
      handler({ kind: 'result', subtype: 'success', sessionId: 'sess-1' })
      handler({ kind: 'query_end', succeeded: true, sessionId: 'sess-1' })

      // sess-2 messages unchanged (still empty)
      expect(chat.messages.value).toHaveLength(0)

      // Verify sess-1 response was persisted — check the LAST save call for sess-1
      const sess1Calls = (deps.saveMessages as ReturnType<typeof vi.fn>).mock.calls
        .filter((call: unknown[]) => call[0] === 'sess-1')
      const lastSave = sess1Calls[sess1Calls.length - 1]
      expect(lastSave).toBeTruthy()
      const savedMsgs = lastSave![1] as Array<{ role: string; text?: string }>
      expect(savedMsgs.some(m => m.role === 'bond' && m.text === 'response from sess-1')).toBe(true)
    })

    it('restores background messages when switching back to a busy session', async () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]

      // Submit in sess-1
      await chat.submit('hello')

      // Switch to sess-2
      await chat.loadSession('sess-2')

      // Partial response arrives for sess-1
      handler({ kind: 'assistant_text', text: 'partial...', sessionId: 'sess-1' })

      // Switch back to sess-1 — should restore from background with partial response
      await chat.loadSession('sess-1')
      const bondMsg = chat.messages.value.find(m => m.role === 'bond')
      expect(bondMsg).toMatchObject({ text: 'partial...', streaming: true })
    })
  })

  describe('onQueryEnd', () => {
    it('fires callback with sessionId when query ends', () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const cb = vi.fn()
      chat.onQueryEnd(cb)

      handler({ kind: 'query_end', succeeded: true, sessionId: 'sess-1' })
      expect(cb).toHaveBeenCalledWith('sess-1')
    })

    it('fires callback even for non-current session', () => {
      chat.currentSessionId.value = 'sess-2'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const cb = vi.fn()
      chat.onQueryEnd(cb)

      handler({ kind: 'query_end', succeeded: false, sessionId: 'sess-1' })
      expect(cb).toHaveBeenCalledWith('sess-1')
    })
  })

  describe('handleChunk (via subscribe)', () => {
    const TEST_SESSION = 'test-session-1'

    function getChunkHandler() {
      chat.currentSessionId.value = TEST_SESSION
      chat.subscribe()
      const rawHandler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]
      return (chunk: Record<string, unknown>) => rawHandler({ ...chunk, sessionId: TEST_SESSION })
    }

    it('creates a bond message on assistant_text', () => {
      const handler = getChunkHandler()
      handler({ kind: 'assistant_text', text: 'hi' })

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0]).toMatchObject({ role: 'bond', text: 'hi', streaming: true })
    })

    it('appends to existing streaming bond message', () => {
      const handler = getChunkHandler()
      handler({ kind: 'assistant_text', text: 'hello' })
      handler({ kind: 'assistant_text', text: ' world' })

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0]).toMatchObject({ role: 'bond', text: 'hello world' })
    })

    it('adds tool meta message', () => {
      const handler = getChunkHandler()
      handler({ kind: 'assistant_tool', name: 'Read', summary: 'file.ts' })

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0]).toMatchObject({ role: 'meta', kind: 'tool', name: 'Read' })
    })

    it('adds error on result with errors', () => {
      const handler = getChunkHandler()
      handler({ kind: 'result', subtype: 'done', errors: ['bad', 'worse'] })

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0]).toMatchObject({ role: 'meta', kind: 'error', text: 'bad; worse' })
    })

    it('marks streaming done on result', () => {
      const handler = getChunkHandler()
      handler({ kind: 'assistant_text', text: 'hi' })
      expect(chat.messages.value[0]).toMatchObject({ streaming: true })

      handler({ kind: 'result', subtype: 'done' })
      expect(chat.messages.value[0]).toMatchObject({ streaming: false })
    })

    it('adds error on raw_error', () => {
      const handler = getChunkHandler()
      handler({ kind: 'raw_error', message: 'oops' })

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0]).toMatchObject({ role: 'meta', kind: 'error', text: 'oops' })
    })

    it('adds system message', () => {
      const handler = getChunkHandler()
      handler({ kind: 'system', subtype: 'init', text: 'started' })

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0]).toMatchObject({ role: 'meta', kind: 'system', text: 'started' })
    })

    it('uses subtype when text is missing on system chunk', () => {
      const handler = getChunkHandler()
      handler({ kind: 'system', subtype: 'init' })

      expect(chat.messages.value[0]).toMatchObject({ text: 'init' })
    })

    it('removes empty thinking placeholder on non-thinking chunk', () => {
      const handler = getChunkHandler()
      chat.messages.value.push({ id: '1', role: 'meta', kind: 'thinking', text: '', streaming: true } as any)
      handler({ kind: 'assistant_text', text: 'hi' })

      expect(chat.messages.value.find(m => m.role === 'meta' && 'kind' in m && m.kind === 'thinking')).toBeUndefined()
      expect(chat.messages.value[chat.messages.value.length - 1]).toMatchObject({ role: 'bond', text: 'hi' })
    })

    it('accumulates thinking text into a thinking message', () => {
      const handler = getChunkHandler()
      chat.messages.value.push({ id: '1', role: 'meta', kind: 'thinking', text: '', streaming: true } as any)
      handler({ kind: 'thinking_text', text: 'Let me ' })
      handler({ kind: 'thinking_text', text: 'think...' })

      const thinking = chat.messages.value[chat.messages.value.length - 1]
      expect(thinking).toMatchObject({
        role: 'meta', kind: 'thinking', text: 'Let me think...', streaming: true
      })
    })

    it('finalizes thinking message when assistant text arrives', () => {
      const handler = getChunkHandler()
      chat.messages.value.push({ id: '1', role: 'meta', kind: 'thinking', text: '', streaming: true } as any)
      handler({ kind: 'thinking_text', text: 'reasoning' })
      handler({ kind: 'assistant_text', text: 'hi' })

      const thinking = chat.messages.value.find(m => m.role === 'meta' && 'kind' in m && m.kind === 'thinking')
      expect(thinking).toMatchObject({ role: 'meta', kind: 'thinking', streaming: false, text: 'reasoning' })
      expect(chat.messages.value[chat.messages.value.length - 1]).toMatchObject({ role: 'bond', text: 'hi' })
    })
  })

  describe('session persistence', () => {
    it('loadSession loads messages from deps', async () => {
      ;(deps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: '1', role: 'user', text: 'hi' },
        { id: '2', role: 'bond', text: 'hello', streaming: false },
      ])

      await chat.loadSession('sess-1')

      expect(deps.getMessages).toHaveBeenCalledWith('sess-1')
      expect(chat.messages.value).toHaveLength(2)
      expect(chat.currentSessionId.value).toBe('sess-1')
    })

    it('loadSession resolves imageIds to images', async () => {
      const img = { data: 'abc123', mediaType: 'image/png' as const }
      ;(deps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: '1', role: 'user', text: 'hi', imageIds: ['img-1'] },
      ])
      ;(deps.getImages as ReturnType<typeof vi.fn>).mockResolvedValue([img])

      await chat.loadSession('sess-1')

      expect(deps.getImages).toHaveBeenCalledWith(['img-1'])
      const userMsg = chat.messages.value[0]
      expect(userMsg.role).toBe('user')
      if (userMsg.role === 'user') {
        expect(userMsg.images).toEqual([img])
        expect(userMsg.imageIds).toEqual(['img-1'])
      }
    })

    it('submit persists messages', async () => {
      chat.currentSessionId.value = 'sess-1'
      await chat.submit('hello')

      expect(deps.saveMessages).toHaveBeenCalled()
      const [sessionId] = (deps.saveMessages as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(sessionId).toBe('sess-1')
    })

    it('clearMessages resets state', () => {
      chat.messages.value = [{ id: '1', role: 'user', text: 'hi' }] as any
      chat.currentSessionId.value = 'sess-1'

      chat.clearMessages()

      expect(chat.messages.value).toHaveLength(0)
      expect(chat.currentSessionId.value).toBeNull()
    })
  })

  describe('subscribe / unsubscribe', () => {
    it('calls onChunk on subscribe', () => {
      chat.subscribe()
      expect(deps.onChunk).toHaveBeenCalledTimes(1)
    })

    it('calls unsub on unsubscribe', () => {
      const unsub = vi.fn()
      ;(deps.onChunk as ReturnType<typeof vi.fn>).mockReturnValue(unsub)

      chat.subscribe()
      chat.unsubscribe()
      expect(unsub).toHaveBeenCalledTimes(1)
    })
  })

  describe('cancel', () => {
    it('calls deps.cancel and clears busy', () => {
      chat.currentSessionId.value = 'sess-1'
      chat.subscribe()
      const handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]

      handler({ kind: 'query_start', sessionId: 'sess-1' })
      expect(chat.busy.value).toBe(true)

      chat.cancel()
      expect(deps.cancel).toHaveBeenCalledWith('sess-1')
      expect(chat.busy.value).toBe(false)
    })
  })
})
