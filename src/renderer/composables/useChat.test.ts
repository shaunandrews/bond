import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, nextTick } from 'vue'
import { useChat, type ChatDeps } from './useChat'
import type { TaggedChunk } from '../../shared/stream'

function mockDeps(): ChatDeps {
  return {
    send: vi.fn().mockResolvedValue({ ok: true }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    onChunk: vi.fn().mockReturnValue(vi.fn()),
    respondToApproval: vi.fn().mockResolvedValue({ ok: true }),
    getImages: vi.fn().mockResolvedValue([]),
    listTranscript: vi.fn().mockResolvedValue({ messages: [], nextBeforeSeq: null }),
    upsertTranscript: vi.fn().mockResolvedValue({ ok: true }),
    createSession: vi.fn().mockResolvedValue({ id: 'transport-1' }),
    subscribe: vi.fn().mockResolvedValue({ ok: true }),
    unsubscribe: vi.fn().mockResolvedValue({ ok: true }),
  }
}

type UseChatReturn = ReturnType<typeof useChat>

function withSetup(deps: ChatDeps): UseChatReturn {
  let result!: UseChatReturn
  const app = createApp(defineComponent({ setup() { result = useChat(deps); return () => null } }))
  app.mount(document.createElement('div'))
  return result
}

describe('useChat continuous transcript', () => {
  let deps: ChatDeps
  let chat: UseChatReturn
  let handler: (chunk: TaggedChunk) => void

  beforeEach(() => {
    localStorage.clear()
    deps = mockDeps()
    chat = withSetup(deps)
    chat.subscribe()
    handler = (deps.onChunk as ReturnType<typeof vi.fn>).mock.calls[0][0]
  })

  it('loads the global transcript page and resolves image IDs', async () => {
    ;(deps.listTranscript as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: 'u1', role: 'user', text: 'hello', imageIds: ['img-1'], seq: 1 }],
      nextBeforeSeq: null,
    })
    ;(deps.getImages as ReturnType<typeof vi.fn>).mockResolvedValue([{ data: 'abc', mediaType: 'image/png' }])

    await chat.loadTranscript()

    expect(deps.listTranscript).toHaveBeenCalledWith({ beforeSeq: undefined, limit: 80 })
    expect(deps.getImages).toHaveBeenCalledWith(['img-1'])
    expect(chat.messages.value[0]).toMatchObject({ id: 'u1', role: 'user', text: 'hello' })
  })

  it('lets the daemon insert canonical turn rows before renderer upserts', async () => {
    let resolveSend!: (value: { ok: boolean }) => void
    ;(deps.send as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(resolve => { resolveSend = resolve }))

    const submitting = chat.submit('hello')
    await vi.waitFor(() => expect(deps.send).toHaveBeenCalledTimes(1))

    expect(deps.createSession).not.toHaveBeenCalled()
    expect(deps.subscribe).toHaveBeenCalledWith()
    expect(deps.upsertTranscript).not.toHaveBeenCalled()
    const input = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(input).toMatchObject({ text: 'hello', editMode: { type: 'full' } })
    expect(input.turnId).toEqual(expect.any(String))
    expect(input.userMessageId).toEqual(chat.messages.value[0].id)
    expect(input.activityMessageId).toEqual(chat.messages.value[1].id)

    resolveSend({ ok: true })
    await submitting
  })

  it('streams assistant text into the stable assistant message ID', async () => {
    await chat.submit('hello')
    const input = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0]

    handler({ kind: 'assistant_text', text: 'hi', assistantMessageId: input.assistantMessageId })
    handler({ kind: 'assistant_text', text: ' there', assistantMessageId: input.assistantMessageId })
    handler({ kind: 'query_end', succeeded: true })

    const assistant = chat.messages.value.find(m => m.role === 'bond')
    expect(assistant).toMatchObject({ id: input.assistantMessageId, text: 'hi there', streaming: false })
    const activity = chat.messages.value.find(m => m.role === 'meta' && m.kind === 'activity')
    expect(activity).toMatchObject({ data: expect.objectContaining({ status: 'done' }) })
  })

  it('preserves TurnActivity approvals and responds through the approval API', async () => {
    await chat.submit('needs tool')
    handler({ kind: 'tool_approval', requestId: 'req-1', toolName: 'Bash', input: { command: 'pwd' } })

    expect(chat.pendingApprovals.value).toMatchObject([{ requestId: 'req-1', toolName: 'Bash' }])
    await chat.respondToApproval('req-1', true)

    expect(deps.respondToApproval).toHaveBeenCalledWith('req-1', true)
    expect(chat.pendingApprovals.value).toHaveLength(0)
  })

  it('queues while busy and auto-sends the next message after query_end', async () => {
    await chat.submit('first')
    await chat.submit('second')

    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(chat.currentQueue.value).toMatchObject([{ text: 'second' }])

    handler({ kind: 'query_end', succeeded: true })
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(deps.send).toHaveBeenCalledTimes(2)
    expect((deps.send as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({ text: 'second' })
  })

  it('sends the selected edit mode with continuous turns', async () => {
    chat.setEditMode({ type: 'readonly' })
    await chat.submit('read only')

    expect((deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ editMode: { type: 'readonly' } })
  })
})
