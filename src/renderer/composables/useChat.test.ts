import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, nextTick, watch } from 'vue'
import { useChat, type ChatDeps } from './useChat'
import type { TaggedChunk } from '../../shared/stream'

function mockDeps(): ChatDeps {
  return {
    send: vi.fn().mockResolvedValue({ ok: true, queued: false, turnId: 't', epochId: 'e' }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    onChunk: vi.fn().mockReturnValue(vi.fn()),
    respondToApproval: vi.fn().mockResolvedValue({ ok: true }),
    answerQuestion: vi.fn().mockResolvedValue({ ok: true }),
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

  it('drops late chunks after Stop while retaining turn ownership through query_end', async () => {
    // Stop must keep ownership until the daemon's terminal chunk arrives;
    // otherwise query_end itself becomes a straggler and the queue cannot
    // drain safely. Late output from the stopped turn is still ignored.
    await chat.submit('do something slow')
    const sentTurnId = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0].turnId as string
    const stopping = chat.cancel()
    const countAfterCancel = chat.messages.value.length

    handler({ kind: 'assistant_text', text: 'too late', turnId: sentTurnId })
    handler({ kind: 'thinking_text', text: 'straggler', turnId: sentTurnId })
    expect(chat.messages.value).toHaveLength(countAfterCancel)
    expect(chat.busy.value).toBe(true)

    handler({ kind: 'query_end', succeeded: false, turnId: sentTurnId })
    await stopping
    expect(chat.busy.value).toBe(false)
  })

  it('accepts chunks for a turn mirrored from another client via turn_start', () => {
    handler({ kind: 'turn_start', turnId: 'turn-remote', userMessageId: 'u-r', assistantMessageId: 'a-r', activityMessageId: 'm-r', text: 'from the phone' })
    handler({ kind: 'assistant_text', text: 'streamed here too', turnId: 'turn-remote', assistantMessageId: 'a-r' })

    const assistant = chat.messages.value.find(m => m.id === 'a-r')
    expect(assistant && 'text' in assistant ? assistant.text : '').toContain('streamed here too')
  })

  it('ignores a thread turn_start — useChat is the main conversation only', () => {
    // Regression: currentSessionId is null for continuous Bond, which made
    // the old sessionId-only filter a no-op — a thread's turn_start would
    // otherwise inject a fake user message straight into the main transcript.
    handler({
      kind: 'turn_start',
      turnId: 'thread-turn',
      userMessageId: 'u-thread',
      assistantMessageId: 'a-thread',
      activityMessageId: 'm-thread',
      text: 'a thread message',
      scope: { type: 'thread', threadId: 'thread-1' },
    })

    expect(chat.messages.value.some(m => m.id === 'u-thread')).toBe(false)
    expect(chat.messages.value.some(m => m.id === 'a-thread')).toBe(false)
  })

  it('still processes untagged chunks (legacy compatibility)', async () => {
    await chat.submit('hello')
    handler({ kind: 'assistant_text', text: 'no tags on me' })

    const bond = chat.messages.value.find(m => m.role === 'bond')
    expect(bond && 'text' in bond ? bond.text : '').toContain('no tags on me')
  })

  it('mirrors edit_mode_changed into composer state and applies it to the next send', async () => {
    // Regression: the web client persisted the mode but the composable kept
    // sending its own stale 'full' ref — a permissions UI that did nothing.
    handler({ kind: 'edit_mode_changed', editMode: { type: 'readonly' } })
    expect(chat.editMode.value).toEqual({ type: 'readonly' })

    await chat.submit('careful now')
    const input = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(input.editMode).toEqual({ type: 'readonly' })
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
    let resolveSend!: (value: { ok: true; queued: boolean; turnId: string; epochId: string }) => void
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

    resolveSend({ ok: true, queued: false, turnId: 't', epochId: 'e' })
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

  it('creates a pending question from a user_question chunk and resolves it via the option API', async () => {
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-1', question: 'Which approach?',
      options: [
        { id: 'q-1:0', number: 1, label: 'Balanced', description: 'Middle ground' },
        { id: 'q-1:1', number: 2, label: 'Aggressive', description: 'Faster but riskier' },
      ],
    })

    expect(chat.pendingQuestion.value).toMatchObject({ questionId: 'q-1', question: 'Which approach?' })
    const activityBefore = chat.messages.value.find(m => m.role === 'meta' && m.kind === 'activity')
    expect(activityBefore).toMatchObject({ data: expect.objectContaining({ status: 'awaiting_question' }) })

    await chat.answerQuestion('q-1', { kind: 'option', optionId: 'q-1:0', label: 'Balanced', number: 1 })

    expect(deps.answerQuestion).toHaveBeenCalledWith('q-1', { kind: 'option', optionId: 'q-1:0', label: 'Balanced', number: 1 })
    expect(chat.pendingQuestion.value).toBeNull()
  })

  it('flips a pending question when another client (or the CLI) resolves it', async () => {
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-2', question: 'Which?',
      options: [{ id: 'q-2:0', number: 1, label: 'A', description: 'a' }, { id: 'q-2:1', number: 2, label: 'B', description: 'b' }],
    })
    expect(chat.pendingQuestion.value).not.toBeNull()

    handler({ kind: 'question_resolved', questionId: 'q-2', answer: { kind: 'custom', text: 'do something else' } })

    expect(chat.pendingQuestion.value).toBeNull()
    expect(deps.answerQuestion).not.toHaveBeenCalled()
    const activity = chat.messages.value.find(m => m.role === 'meta' && m.kind === 'activity')
    expect(activity && activity.role === 'meta' && activity.kind === 'activity' ? activity.data.events.at(-1) : undefined)
      .toMatchObject({ type: 'question', status: 'answered', answer: { kind: 'custom', text: 'do something else' } })
  })

  it('a composer submit while a question is pending resolves it as a custom answer — no new turn, no queue', async () => {
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-3', question: 'Which?',
      options: [{ id: 'q-3:0', number: 1, label: 'A', description: 'a' }, { id: 'q-3:1', number: 2, label: 'B', description: 'b' }],
    })
    const sendCallsBefore = (deps.send as ReturnType<typeof vi.fn>).mock.calls.length

    await chat.submit('actually, do X instead')

    expect(deps.answerQuestion).toHaveBeenCalledWith('q-3', { kind: 'custom', text: 'actually, do X instead' })
    expect((deps.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCallsBefore)
    expect(chat.currentQueue.value).toHaveLength(0)
  })

  it('a turn error cancels a pending question', async () => {
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-4', question: 'Which?',
      options: [{ id: 'q-4:0', number: 1, label: 'A', description: 'a' }, { id: 'q-4:1', number: 2, label: 'B', description: 'b' }],
    })
    expect(chat.pendingQuestion.value).not.toBeNull()

    handler({ kind: 'raw_error', message: 'boom' })

    expect(chat.pendingQuestion.value).toBeNull()
    const activity = chat.messages.value.find(m => m.role === 'meta' && m.kind === 'activity')
    const questionEvent = activity && activity.role === 'meta' && activity.kind === 'activity'
      ? activity.data.events.find(e => e.type === 'question')
      : undefined
    expect(questionEvent).toMatchObject({ status: 'cancelled' })
  })

  it('shows a picked option as a normal message in the transcript flow', async () => {
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-6', question: 'Which?',
      options: [{ id: 'q-6:0', number: 1, label: 'Balanced', description: 'Middle ground' }],
    })

    await chat.answerQuestion('q-6', { kind: 'option', optionId: 'q-6:0', label: 'Balanced', number: 1 })

    const bubble = chat.messages.value.find(m => m.role === 'user' && m.text === 'Balanced')
    expect(bubble).toBeTruthy()
  })

  it('shows a typed custom answer as a normal message too', async () => {
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-7', question: 'Which?',
      options: [{ id: 'q-7:0', number: 1, label: 'A', description: 'a' }],
    })

    await chat.submit('do X instead')

    const bubble = chat.messages.value.find(m => m.role === 'user' && m.text === 'do X instead')
    expect(bubble).toBeTruthy()
  })

  it('mirrors the answer as a message when another client resolves the question', async () => {
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-8', question: 'Which?',
      options: [{ id: 'q-8:0', number: 1, label: 'A', description: 'a' }],
    })

    handler({ kind: 'question_resolved', questionId: 'q-8', answer: { kind: 'custom', text: 'do Y' } })

    const bubble = chat.messages.value.find(m => m.role === 'user' && m.text === 'do Y')
    expect(bubble).toBeTruthy()
  })

  it('appends exactly one answer bubble when the daemon echoes question_resolved back to the answerer', async () => {
    // The daemon broadcasts to every subscriber including the sender, and
    // that notification beats the RPC ack down the socket — this used to
    // append twice here (and once more per other connected client).
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-10', question: 'Which?',
      options: [{ id: 'q-10:0', number: 1, label: 'Balanced', description: 'Middle ground' }],
    })

    const answering = chat.answerQuestion('q-10', { kind: 'option', optionId: 'q-10:0', label: 'Balanced', number: 1 })
    handler({ kind: 'question_resolved', questionId: 'q-10', answer: { kind: 'option', optionId: 'q-10:0', label: 'Balanced', number: 1 } })
    await answering

    expect(chat.messages.value.filter(m => m.role === 'user' && m.text === 'Balanced')).toHaveLength(1)
  })

  it('derives the answer bubble id from the questionId so every client writes one row', async () => {
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-11', question: 'Which?',
      options: [{ id: 'q-11:0', number: 1, label: 'A', description: 'a' }],
    })

    handler({ kind: 'question_resolved', questionId: 'q-11', answer: { kind: 'custom', text: 'do Y' } })
    handler({ kind: 'question_resolved', questionId: 'q-11', answer: { kind: 'custom', text: 'do Y' } })

    const bubbles = chat.messages.value.filter(m => m.role === 'user' && m.text === 'do Y')
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].id).toBe('answer-q-11')
  })

  it('continues a live turn in a fresh activity row below the answer bubble', async () => {
    // The answer bubble appends at the end of the transcript, so the original
    // activity row would be stranded above it and the still-working turn read
    // as dead. The turn continues in a new row under the same turnId.
    await chat.submit('need a decision')
    const turnId = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0].turnId as string
    handler({
      kind: 'user_question', questionId: 'q-12', question: 'Which?', turnId,
      options: [{ id: 'q-12:0', number: 1, label: 'Balanced', description: 'Middle ground' }],
    })

    await chat.answerQuestion('q-12', { kind: 'option', optionId: 'q-12:0', label: 'Balanced', number: 1 })
    handler({ kind: 'thinking_text', text: 'back to work', turnId })

    const activities = chat.messages.value.filter(m => m.role === 'meta' && m.kind === 'activity')
    expect(activities).toHaveLength(2)
    expect(activities[0]).toMatchObject({ data: expect.objectContaining({ status: 'done' }) })
    expect(activities[1]).toMatchObject({ data: expect.objectContaining({ status: 'working', turnId }) })
    // …and the live row is the last thing in the transcript, below the answer.
    expect(chat.messages.value.at(-1)?.id).toBe(activities[1].id)
    expect(chat.messages.value.at(-2)?.id).toBe('answer-q-12')
  })

  it('does not split the activity row when the question is dismissed or the turn is over', async () => {
    await chat.submit('need a decision')
    const turnId = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0].turnId as string
    handler({
      kind: 'user_question', questionId: 'q-13', question: 'Which?', turnId,
      options: [{ id: 'q-13:0', number: 1, label: 'A', description: 'a' }],
    })

    await chat.answerQuestion('q-13', { kind: 'cancelled' })
    handler({ kind: 'thinking_text', text: 'proceeding anyway', turnId })

    expect(chat.messages.value.filter(m => m.role === 'meta' && m.kind === 'activity')).toHaveLength(1)
  })

  it('does not add a visible message when the question is dismissed', async () => {
    await chat.submit('need a decision')
    handler({
      kind: 'user_question', questionId: 'q-9', question: 'Which?',
      options: [{ id: 'q-9:0', number: 1, label: 'A', description: 'a' }],
    })
    const before = chat.messages.value.length

    await chat.answerQuestion('q-9', { kind: 'cancelled' })

    expect(chat.messages.value.length).toBe(before)
  })

  it('drops a user_question chunk from a turn this client does not own', async () => {
    await chat.submit('need a decision')

    handler({
      kind: 'user_question', questionId: 'q-5', question: 'Which?', turnId: 'someone-elses-turn',
      options: [{ id: 'q-5:0', number: 1, label: 'A', description: 'a' }, { id: 'q-5:1', number: 2, label: 'B', description: 'b' }],
    })

    expect(chat.pendingQuestion.value).toBeNull()
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

  // The daemon never returns an error field on a bond.send result — failures
  // arrive as thrown JSON-RPC errors, and the catch path must fail the turn.
  it('marks the turn failed when send rejects', async () => {
    ;(deps.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('daemon exploded'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await chat.submit('boom')
    } finally {
      errSpy.mockRestore()
    }

    expect(chat.busy.value).toBe(false)
    const activity = chat.messages.value.find(m => m.role === 'meta' && m.kind === 'activity')
    if (!activity || activity.role !== 'meta' || activity.kind !== 'activity') throw new Error('no activity row')
    expect(activity.data).toMatchObject({ status: 'failed', expanded: true })
    expect(activity.data.events.at(-1)).toMatchObject({ type: 'error', text: 'daemon exploded' })
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

  it('preserves and drains queued messages after Stop settles without a live query_end', async () => {
    await chat.submit('first')
    await chat.submit('second')
    await chat.submit('third')
    const firstTurnId = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0].turnId as string
    ;(deps.listTranscript as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ id: 'activity-1', role: 'meta', kind: 'activity', data: { turnId: firstTurnId, status: 'cancelled', startedAt: 1, endedAt: 2, events: [] } }],
      nextBeforeSeq: null,
    })

    await chat.cancel()

    expect(chat.currentQueue.value).toMatchObject([{ text: 'third' }])
    expect(deps.send).toHaveBeenCalledTimes(2)
    expect((deps.send as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({ text: 'second' })
    expect(chat.busy.value).toBe(true)
  })

  it('reconnect while idle reloads from the store instead of upserting stale state', async () => {
    // Regression: onConnectionRestored blind-upserted the renderer's whole
    // in-memory transcript, regressing a daemon-finished activity row back to
    // "working" and wiping the final reply text.
    ;(deps.listTranscript as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        { id: 'a1', role: 'meta', kind: 'activity', data: { turnId: 'turn-1', status: 'done', startedAt: 1, endedAt: 2, events: [] } },
        { id: 'b1', role: 'bond', text: 'finished reply from daemon' },
      ],
      nextBeforeSeq: null,
    })

    await chat.reconcileOnReconnect()

    expect(deps.upsertTranscript).not.toHaveBeenCalled()
    expect(deps.listTranscript).toHaveBeenCalled()
    expect(chat.messages.value).toMatchObject([
      { role: 'meta', kind: 'activity', data: { status: 'done' } },
      { role: 'bond', text: 'finished reply from daemon' },
    ])
  })

  it('adopts a live turn from a loaded transcript so a reloaded window still gets its completion', async () => {
    // Regression: a mid-turn full reload (design-system:generate rewrites
    // src/renderer generated files) came back with activeTurnId=null, so the
    // straggler guard dropped the running turn's chunks — including
    // query_end — freezing the activity row while the phone rendered fine.
    ;(deps.listTranscript as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        { id: 'u1', role: 'user', text: 'long task' },
        { id: 'a1', role: 'meta', kind: 'activity', data: { turnId: 'turn-live', status: 'working', startedAt: 1, events: [] } },
      ],
      nextBeforeSeq: null,
    })
    await chat.loadTranscript()
    expect(chat.busy.value).toBe(true)

    handler({ kind: 'query_end', succeeded: true, turnId: 'turn-live' })
    await nextTick()

    expect(chat.busy.value).toBe(false)
    const row = chat.messages.value.find(m => m.role === 'meta' && m.kind === 'activity')
    expect(row && row.role === 'meta' && row.kind === 'activity' ? row.data.status : null).toBe('done')
  })

  it('does not adopt a finished turn from a loaded transcript', async () => {
    ;(deps.listTranscript as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        { id: 'a1', role: 'meta', kind: 'activity', data: { turnId: 'turn-old', status: 'done', startedAt: 1, endedAt: 2, events: [] } },
      ],
      nextBeforeSeq: null,
    })
    await chat.loadTranscript()
    expect(chat.busy.value).toBe(false)
  })

  it('reconnect during an owned turn the store has not finalized repersists', async () => {
    await chat.submit('long running work')
    expect(chat.busy.value).toBe(true)
    ;(deps.upsertTranscript as ReturnType<typeof vi.fn>).mockClear()

    await chat.reconcileOnReconnect()

    expect(deps.upsertTranscript).toHaveBeenCalled()
    expect(chat.busy.value).toBe(true)
  })

  it('reconnect after the daemon finalized our owned turn reloads and drops zombie ownership', async () => {
    // Regression: a window that adopted (or kept) ownership of a turn the
    // daemon had already finished would blind-repersist its stale copy on
    // every reconnect — re-freezing the activity row and wiping the reply.
    await chat.submit('long running work')
    const sentTurnId = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0].turnId as string
    expect(chat.busy.value).toBe(true)
    ;(deps.upsertTranscript as ReturnType<typeof vi.fn>).mockClear()
    ;(deps.listTranscript as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        { id: 'a1', role: 'meta', kind: 'activity', data: { turnId: sentTurnId, status: 'done', startedAt: 1, endedAt: 2, events: [] } },
        { id: 'b1', role: 'bond', text: 'reply the window never saw' },
      ],
      nextBeforeSeq: null,
    })

    await chat.reconcileOnReconnect()

    expect(deps.upsertTranscript).not.toHaveBeenCalled()
    expect(chat.busy.value).toBe(false)
    expect(chat.messages.value).toMatchObject([
      { role: 'meta', kind: 'activity', data: { status: 'done' } },
      { role: 'bond', text: 'reply the window never saw' },
    ])
  })

  it('persists only rows this window changed, never loaded store rows', async () => {
    // Regression: persistMessages used to bulk-push the entire in-memory
    // transcript, so any staleness anywhere became corruption everywhere.
    ;(deps.listTranscript as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        { id: 'store-1', role: 'user', text: 'from store' },
        { id: 'store-2', role: 'bond', text: 'stored reply' },
      ],
      nextBeforeSeq: null,
    })
    await chat.loadTranscript()
    ;(deps.upsertTranscript as ReturnType<typeof vi.fn>).mockClear()

    await chat.persistMessages()
    expect(deps.upsertTranscript).not.toHaveBeenCalled()

    await chat.submit('fresh message')
    await chat.persistMessages()
    const calls = (deps.upsertTranscript as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      const ids = (call[0] as Array<{ id: string }>).map(m => m.id)
      expect(ids).not.toContain('store-1')
      expect(ids).not.toContain('store-2')
      expect(ids.length).toBeGreaterThan(0)
    }
  })

  it('sends IPC-cloneable payloads instead of Vue reactive proxies', async () => {
    ;(deps.send as ReturnType<typeof vi.fn>).mockImplementation(async input => {
      expect(() => structuredClone(input)).not.toThrow()
      return { ok: true, queued: false, turnId: 't', epochId: 'e' }
    })
    chat.setEditMode({ type: 'scoped', allowedPaths: ['/tmp/project'] })
    await chat.submit('scoped work', [{ data: 'abc', mediaType: 'image/png' }])

    expect((deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      editMode: { type: 'scoped', allowedPaths: ['/tmp/project'] },
      images: [{ data: 'abc', mediaType: 'image/png' }],
    })
  })
})
