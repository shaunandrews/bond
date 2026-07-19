import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, nextTick, watch } from 'vue'
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

  it('dispatches show_panel chunks as a window event, not transcript content', () => {
    const seen: string[] = []
    const listener = (event: Event) => seen.push((event as CustomEvent<string>).detail)
    window.addEventListener('bond:show-panel', listener)

    handler({ kind: 'show_panel', panel: 'memory' })

    window.removeEventListener('bond:show-panel', listener)
    expect(seen).toEqual(['memory'])
    expect(chat.messages.value).toHaveLength(0)
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

  // Regression: the activity label for codex_generate_image was the raw tool
  // name plus a 240-char JSON input summary, wrapping the compact working
  // indicator across several garbled lines.
  it('labels image generation activity with a friendly verb, not the prompt JSON', async () => {
    await chat.submit('draw me something')
    handler({
      kind: 'assistant_tool',
      name: 'codex_generate_image',
      summary: '{"prompt":"A very long painterly prompt that goes on and on"}',
      input: { prompt: 'A very long painterly prompt that goes on and on' },
      toolUseId: 'call-1',
    })

    const activity = chat.messages.value.find(m => m.role === 'meta' && m.kind === 'activity')
    expect(activity && activity.role === 'meta' && activity.kind === 'activity' ? activity.data.events.at(-1) : undefined)
      .toMatchObject({ type: 'tool', label: 'Generating image' })
  })

  it('turns generated_image chunks into transcript image messages with resolved data', async () => {
    ;(deps.getImages as ReturnType<typeof vi.fn>).mockResolvedValue([{ data: 'abc', mediaType: 'image/png' }])

    handler({ kind: 'generated_image', imageIds: ['gen-1'], alt: 'A watercolor fox' })

    expect(chat.messages.value.at(-1)).toMatchObject({ role: 'meta', kind: 'image', imageIds: ['gen-1'], alt: 'A watercolor fox' })
    await vi.waitFor(() => expect(deps.getImages).toHaveBeenCalledWith(['gen-1']))
    await vi.waitFor(() => {
      const msg = chat.messages.value.at(-1)
      expect(msg && 'images' in msg ? msg.images : undefined).toEqual([{ data: 'abc', mediaType: 'image/png' }])
    })

    // Persists as imageIds + alt — never base64 — so the files stay canonical.
    await chat.persistMessages()
    const payload = (deps.upsertTranscript as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(payload.at(-1)).toMatchObject({ role: 'meta', kind: 'image', imageIds: ['gen-1'], data: { alt: 'A watercolor fox' } })
    expect(payload.at(-1).images).toBeUndefined()
  })

  // Regression: the handler resolved base64 onto the raw message object, not
  // the reactive proxy in messages — the data arrived but no effect ever
  // triggered, so the bubble showed "Loading image…" forever.
  it('resolves generated image data through the reactive proxy so the bubble re-renders', async () => {
    ;(deps.getImages as ReturnType<typeof vi.fn>).mockResolvedValue([{ data: 'abc', mediaType: 'image/png' }])

    handler({ kind: 'generated_image', imageIds: ['gen-1'] })

    const msg = chat.messages.value.at(-1)!
    let triggered = false
    const stop = watch(() => (msg as { images?: unknown }).images, () => { triggered = true })
    await vi.waitFor(() => expect(triggered).toBe(true))
    stop()
  })

  it('restores generated image messages from the transcript with resolved images', async () => {
    ;(deps.listTranscript as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: 'g1', role: 'meta', kind: 'image', imageIds: ['img-9'], data: { alt: 'Poster' }, seq: 1 }],
      nextBeforeSeq: null,
    })
    ;(deps.getImages as ReturnType<typeof vi.fn>).mockResolvedValue([{ data: 'xyz', mediaType: 'image/webp' }])

    await chat.loadTranscript()

    expect(deps.getImages).toHaveBeenCalledWith(['img-9'])
    expect(chat.messages.value[0]).toMatchObject({
      role: 'meta',
      kind: 'image',
      imageIds: ['img-9'],
      alt: 'Poster',
      images: [{ data: 'xyz', mediaType: 'image/webp' }],
    })
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

  // Live sync: a turn started on another client (e.g. the phone browser)
  // must appear here with the sender's ids — same transcript rows, no dupes.
  it('mirrors a turn started on another client, user bubble included', async () => {
    ;(deps.getImages as ReturnType<typeof vi.fn>).mockResolvedValue([{ data: 'abc', mediaType: 'image/png' }])

    handler({ kind: 'turn_start', turnId: 't1', userMessageId: 'u1', assistantMessageId: 'a1', activityMessageId: 'act1', text: 'from phone', imageIds: ['img-1'] })

    expect(chat.busy.value).toBe(true)
    expect(chat.messages.value[0]).toMatchObject({ id: 'u1', role: 'user', text: 'from phone', imageIds: ['img-1'] })
    expect(chat.messages.value[1]).toMatchObject({ id: 'act1', role: 'meta', kind: 'activity', data: expect.objectContaining({ turnId: 't1', userMessageId: 'u1', assistantMessageId: 'a1' }) })
    await vi.waitFor(() => expect(deps.getImages).toHaveBeenCalledWith(['img-1']))

    handler({ kind: 'assistant_text', text: 'streamed everywhere', assistantMessageId: 'a1' })
    expect(chat.messages.value.find(m => m.role === 'bond')).toMatchObject({ id: 'a1', text: 'streamed everywhere' })
    // The activity row reused the sender's id — no duplicate was minted.
    expect(chat.messages.value.filter(m => m.role === 'meta' && m.kind === 'activity')).toHaveLength(1)
  })

  it('ignores the turn_start echo for its own turn', async () => {
    await chat.submit('hello')
    const input = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const before = chat.messages.value.length

    handler({ kind: 'turn_start', turnId: input.turnId, userMessageId: input.userMessageId, assistantMessageId: input.assistantMessageId, activityMessageId: input.activityMessageId, text: 'hello' })

    expect(chat.messages.value).toHaveLength(before)
  })

  it('flips a pending approval when another client resolves it', async () => {
    await chat.submit('needs tool')
    handler({ kind: 'tool_approval', requestId: 'req-9', toolName: 'Bash', input: { command: 'pwd' } })
    expect(chat.pendingApprovals.value).toHaveLength(1)

    handler({ kind: 'approval_resolved', requestId: 'req-9', approved: false })

    expect(chat.pendingApprovals.value).toHaveLength(0)
    expect(deps.respondToApproval).not.toHaveBeenCalled()
    const activity = chat.messages.value.find(m => m.role === 'meta' && m.kind === 'activity')
    expect(activity && activity.role === 'meta' && activity.kind === 'activity' ? activity.data.events.at(-1) : undefined)
      .toMatchObject({ type: 'approval', status: 'denied' })
  })

  // Regression: crypto.randomUUID only exists in secure contexts. The remote
  // web client runs on plain http (LAN IP), where it's undefined — submit()
  // threw before rendering anything: type, hit return, nothing happens.
  it('submits without crypto.randomUUID (insecure-context LAN origin)', async () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      await chat.submit('from the phone')

      expect(chat.messages.value[0]).toMatchObject({ role: 'user', text: 'from the phone' })
      expect(deps.send).toHaveBeenCalledTimes(1)
      const input = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      for (const id of [input.turnId, input.userMessageId, input.assistantMessageId, input.activityMessageId]) {
        expect(id).toMatch(V4)
      }
    } finally {
      delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID
    }
  })

  // Regression: submit awaited the global subscription before rendering the
  // user message, so a dead transport (phone with a zombie socket) swallowed
  // messages with zero feedback. The daemon subscribes senders itself.
  it('still renders and sends the message when the subscription call fails', async () => {
    ;(deps.subscribe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not connected'))

    await chat.submit('hello?')

    expect(chat.messages.value[0]).toMatchObject({ role: 'user', text: 'hello?' })
    expect(deps.send).toHaveBeenCalledTimes(1)
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

  it('sends IPC-cloneable payloads instead of Vue reactive proxies', async () => {
    ;(deps.send as ReturnType<typeof vi.fn>).mockImplementation(async input => {
      expect(() => structuredClone(input)).not.toThrow()
      return { ok: true }
    })
    chat.setEditMode({ type: 'scoped', allowedPaths: ['/tmp/project'] })
    await chat.submit('scoped work', [{ data: 'abc', mediaType: 'image/png' }])

    expect((deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      editMode: { type: 'scoped', allowedPaths: ['/tmp/project'] },
      images: [{ data: 'abc', mediaType: 'image/png' }],
    })
  })
})
