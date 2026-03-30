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
    it('adds a user message and calls send', async () => {
      await chat.submit('hello')

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0]).toMatchObject({ role: 'user', text: 'hello' })
      expect(deps.send).toHaveBeenCalledWith('hello', undefined, undefined)
    })

    it('sets busy during send and resets after', async () => {
      expect(chat.busy.value).toBe(false)

      const promise = chat.submit('hello')
      // busy is true while awaiting
      expect(chat.busy.value).toBe(true)

      await promise
      expect(chat.busy.value).toBe(false)
    })

    it('sets thinking during send and resets after', async () => {
      const promise = chat.submit('hello')
      expect(chat.thinking.value).toBe(true)

      await promise
      expect(chat.thinking.value).toBe(false)
    })

    it('adds error message when send fails', async () => {
      ;(deps.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'boom' })

      await chat.submit('hello')

      expect(chat.messages.value).toHaveLength(2)
      expect(chat.messages.value[1]).toMatchObject({ role: 'meta', kind: 'error', text: 'boom' })
    })

    it('ignores empty text', async () => {
      await chat.submit('')
      await chat.submit('   ')

      expect(chat.messages.value).toHaveLength(0)
      expect(deps.send).not.toHaveBeenCalled()
    })

    it('ignores submit while busy', async () => {
      const promise = chat.submit('first')
      await chat.submit('second')

      expect(deps.send).toHaveBeenCalledTimes(1)
      await promise
    })

    it('swaps images for imageIds after send returns', async () => {
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

    it('clears thinking on any chunk', () => {
      const handler = getChunkHandler()
      chat.thinking.value = true
      handler({ kind: 'assistant_text', text: 'hi' })
      expect(chat.thinking.value).toBe(false)
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
    it('calls deps.cancel', () => {
      chat.cancel()
      expect(deps.cancel).toHaveBeenCalledTimes(1)
    })
  })
})
