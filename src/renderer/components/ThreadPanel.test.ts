import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, defineComponent } from 'vue'
import { shallowMount } from '@vue/test-utils'
import ThreadPanel from './ThreadPanel.vue'
import { resetThreadsForTest } from '../composables/useThreads'
import { resetIssueReferencesForTest } from '../composables/useIssueReferences'
import type { ChatThread } from '../../shared/threads'

// A minimal stand-in exposing exactly what ThreadPanel calls on its
// ChatInput ref — the real component's own exposed methods aren't present on
// an auto-stub, and ThreadPanel calls focus()/getText()/setText() on mount.
const ChatInputStub = defineComponent({
  props: ['busy', 'model', 'editMode', 'contextUsage', 'placeholder'],
  emits: ['submit', 'cancel', 'update:model', 'update:editMode'],
  setup(_props, { expose }) {
    expose({ focus: () => {}, getText: () => '', setText: () => {} })
    return () => null
  },
})

function makeThread(over: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    anchorMessageId: 'anchor-1',
    contextSnapshot: {
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      anchorMessageId: 'anchor-1',
      anchorSeq: 2,
      messages: [
        { id: 'u1', seq: 1, role: 'user', text: 'what is bond?' },
        { id: 'anchor-1', seq: 2, role: 'bond', text: 'bond is a chat app' },
      ],
    },
    status: 'draft',
    replyCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function mockBond(overrides: Record<string, unknown> = {}) {
  return {
    getThread: vi.fn().mockResolvedValue(makeThread()),
    listThreadMessages: vi.fn().mockResolvedValue({ messages: [], nextBeforeSeq: null }),
    onChunk: vi.fn().mockReturnValue(vi.fn()),
    subscribe: vi.fn().mockResolvedValue({ ok: true }),
    unsubscribe: vi.fn().mockResolvedValue({ ok: true }),
    getImages: vi.fn().mockResolvedValue([]),
    upsertTranscript: vi.fn().mockResolvedValue({ ok: true }),
    send: vi.fn().mockResolvedValue({ ok: true, queued: false, turnId: 't', epochId: 'e' }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    respondToApproval: vi.fn().mockResolvedValue({ ok: true }),
    answerQuestion: vi.fn().mockResolvedValue({ ok: true }),
    setEditMode: vi.fn().mockResolvedValue(true),
    listRecentThreads: vi.fn().mockResolvedValue({ threads: [] }),
    getThreadForAnchor: vi.fn().mockResolvedValue(null),
    onThreadChanged: vi.fn().mockReturnValue(vi.fn()),
    listCollectionReferences: vi.fn().mockResolvedValue([]),
    onCollectionsChanged: vi.fn().mockReturnValue(vi.fn()),
    summarizeThread: vi.fn().mockResolvedValue({ summary: 'a bounded summary' }),
    sendThreadSummaryToMain: vi.fn().mockResolvedValue({ ok: true, messageId: 'm1' }),
    ...overrides,
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('ThreadPanel', () => {
  let bond: ReturnType<typeof mockBond>

  beforeEach(() => {
    resetThreadsForTest()
    resetIssueReferencesForTest()
    localStorage.clear()
    bond = mockBond()
    ;(window as unknown as { bond: unknown }).bond = bond
  })

  afterEach(() => {
    resetThreadsForTest()
    resetIssueReferencesForTest()
    delete (window as unknown as { bond?: unknown }).bond
    localStorage.clear()
  })

  function mountPanel(props: Partial<{ threadId: string; model: string; autoFocus: boolean; drawer: boolean }> = {}) {
    return shallowMount(ThreadPanel, {
      props: { threadId: 'thread-1', model: 'balanced', ...props } as any,
      // ViewShell owns the actual DOM structure (slots for header/content/footer)
      // ThreadPanel's own template content lives inside — shallow-stubbing it
      // like every other child would render nothing at all to assert on.
      // BondButton is a plain <button> — real, so aria-label/click work normally.
      global: { stubs: { Teleport: true, ViewShell: false, BondButton: false, BondText: false, BondTextarea: false, BondFlyoutMenu: false, BondToolbar: false, ChatInput: ChatInputStub } },
    })
  }

  it("renders the root card from the thread's frozen snapshot, not a live main lookup", async () => {
    const wrapper = mountPanel()
    await flush()

    expect(bond.getThread).toHaveBeenCalledWith('thread-1')
    expect(wrapper.text()).toContain('From the main conversation')
    expect(wrapper.text()).toContain('context as of')
  })

  it('subscribes and loads the thread-scoped transcript on mount', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(bond.listThreadMessages).toHaveBeenCalledWith('thread-1', expect.anything()))
    wrapper.unmount()
  })

  // plans/chat-threads.md Failure behavior: "If the anchor was deleted or
  // cannot be loaded, show 'This response is no longer available'..."
  it('shows "no longer available" and skips subscribing when the thread record is gone (anchor deleted)', async () => {
    bond.getThread.mockResolvedValue(null)
    const wrapper = mountPanel()
    await flush()

    expect(wrapper.text()).toContain('This response is no longer available')
    expect(bond.subscribe).not.toHaveBeenCalled()
    // The header close button (a different slot) still works independent of the fallback.
    expect(wrapper.find('[aria-label="Close thread"]').exists()).toBe(true)
    // The fallback offers its own close action too, and it emits close like the header one does.
    const fallbackClose = wrapper.findAll('button').find(b => b.text() === 'Close')
    expect(fallbackClose).toBeTruthy()
    await fallbackClose!.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('also shows the fallback when getThread rejects outright, rather than leaving a silently broken panel', async () => {
    bond.getThread.mockRejectedValue(new Error('socket closed'))
    const wrapper = mountPanel()
    await flush()

    expect(wrapper.text()).toContain('This response is no longer available')
  })

  it('emits close when the close button is clicked', async () => {
    const wrapper = mountPanel()
    await flush()

    const closeButton = wrapper.find('[aria-label="Close thread"]')
    expect(closeButton.exists()).toBe(true)
    await closeButton.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('uses "Back to conversation" as the close label in drawer mode', async () => {
    const wrapper = mountPanel({ drawer: true })
    await flush()
    expect(wrapper.find('[aria-label="Back to conversation"]').exists()).toBe(true)
  })

  it('fetches a summary and shows the confirmation sheet when "Send summary to main" is chosen', async () => {
    const wrapper = mountPanel()
    await flush()

    await (wrapper.vm as any).startSendSummary()
    await flush()

    expect(bond.summarizeThread).toHaveBeenCalledWith('thread-1')
    expect(wrapper.text()).toContain('Send summary to main')
    // The fetched summary lands in the textarea's VALUE, not textContent —
    // check the reactive state a real textarea would be bound to instead.
    expect((wrapper.vm as any).summarySheet.text).toBe('a bounded summary')
  })

  it('confirming the sheet sends the (possibly edited) summary and emits summarySent', async () => {
    const wrapper = mountPanel()
    await flush()
    await (wrapper.vm as any).startSendSummary()
    await flush()

    ;(wrapper.vm as any).summarySheet.text = 'an edited summary'
    await (wrapper.vm as any).confirmSendSummary()
    await flush()

    expect(bond.sendThreadSummaryToMain).toHaveBeenCalledWith('thread-1', 'an edited summary')
    expect(wrapper.emitted('summarySent')).toBeTruthy()
    expect((wrapper.vm as any).summarySheet).toBeNull()
  })

  it('cancelling the sheet never calls sendThreadSummaryToMain', async () => {
    const wrapper = mountPanel()
    await flush()
    await (wrapper.vm as any).startSendSummary()
    await flush()

    ;(wrapper.vm as any).cancelSummarySheet()
    expect((wrapper.vm as any).summarySheet).toBeNull()
    expect(bond.sendThreadSummaryToMain).not.toHaveBeenCalled()
  })

  it('Escape cancels a busy thread turn instead of closing', async () => {
    bond.send.mockImplementation(() => new Promise(() => {}))
    const wrapper = mountPanel()
    await flush()
    ;(wrapper.vm as any).threadChat.busy.value = true
    await nextTick()

    await wrapper.find('.view-shell').trigger('keydown', { key: 'Escape' })
    expect(bond.cancel).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('Escape closes the panel when idle', async () => {
    const wrapper = mountPanel()
    await flush()

    await wrapper.find('.view-shell').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  // plans/chat-threads.md test plan — "Thread and main drafts survive
  // switching" / "Empty drafts clean up; non-empty threads persist."
  describe('composer draft persistence (per-thread, via localStorage)', () => {
    it('closing the panel saves a non-empty in-progress draft, keyed to this thread', async () => {
      const DraftStub = defineComponent({
        props: ['busy', 'model', 'editMode', 'contextUsage', 'placeholder'],
        emits: ['submit', 'cancel', 'update:model', 'update:editMode'],
        setup(_props, { expose }) {
          expose({ focus: () => {}, getText: () => 'a draft in progress', setText: () => {} })
          return () => null
        },
      })
      const wrapper = shallowMount(ThreadPanel, {
        props: { threadId: 'thread-1', model: 'balanced' } as any,
        global: { stubs: { Teleport: true, ViewShell: false, BondButton: false, BondText: false, BondTextarea: false, BondFlyoutMenu: false, BondToolbar: false, ChatInput: DraftStub } },
      })
      await flush()

      await wrapper.find('[aria-label="Close thread"]').trigger('click')
      expect(localStorage.getItem('bond:thread-draft:thread-1')).toBe('a draft in progress')
    })

    it('mounting restores a previously saved draft into the composer', async () => {
      localStorage.setItem('bond:thread-draft:thread-1', 'saved earlier')
      const setTextSpy = vi.fn()
      const RestoreStub = defineComponent({
        props: ['busy', 'model', 'editMode', 'contextUsage', 'placeholder'],
        emits: ['submit', 'cancel', 'update:model', 'update:editMode'],
        setup(_props, { expose }) {
          expose({ focus: () => {}, getText: () => '', setText: setTextSpy })
          return () => null
        },
      })
      shallowMount(ThreadPanel, {
        props: { threadId: 'thread-1', model: 'balanced' } as any,
        global: { stubs: { Teleport: true, ViewShell: false, BondButton: false, BondText: false, BondTextarea: false, BondFlyoutMenu: false, BondToolbar: false, ChatInput: RestoreStub } },
      })

      await vi.waitFor(() => expect(setTextSpy).toHaveBeenCalledWith('saved earlier'))
    })

    it('sending the draft clears its localStorage entry rather than leaving a stale draft behind', async () => {
      localStorage.setItem('bond:thread-draft:thread-1', 'about to send')
      const wrapper = mountPanel()
      await flush()

      await (wrapper.vm as any).handleSubmit('about to send', [])
      expect(localStorage.getItem('bond:thread-draft:thread-1')).toBeNull()
    })
  })
})
