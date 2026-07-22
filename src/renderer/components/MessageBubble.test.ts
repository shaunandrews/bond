import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { shallowMount } from '@vue/test-utils'
import MessageBubble from './MessageBubble.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import { resetIssueReferencesForTest } from '../composables/useIssueReferences'
import { resetThreadsForTest } from '../composables/useThreads'

describe('MessageBubble issue references', () => {
  beforeEach(() => {
    resetIssueReferencesForTest()
    ;(window as unknown as { bond: unknown }).bond = {
      listCollectionReferences: vi.fn().mockResolvedValue([
        { key: 'BOND-12', title: 'Fix the thing', collectionId: 'c1', itemId: 'i1', prefix: 'BOND', displayNumber: 12 },
      ]),
      onCollectionsChanged: () => () => {},
    }
  })

  afterEach(() => {
    resetIssueReferencesForTest()
    delete (window as unknown as { bond?: unknown }).bond
  })

  it('chips known issue keys but leaves unknown PREFIX-n prose alone', async () => {
    const wrapper = shallowMount(MessageBubble, {
      props: { msg: { id: '1', role: 'user' as const, text: 'BOND-12 breaks UTF-8 output and BOND-99 too' } },
      global: { stubs: { Teleport: true } },
    })
    await Promise.resolve()
    await nextTick()

    const html = wrapper.find('.user-markdown').html()
    expect(html).toContain('data-issue-key="BOND-12"')
    expect(html).not.toContain('data-issue-key="UTF-8"')
    expect(html).not.toContain('data-issue-key="BOND-99"') // not a real item
  })
})

describe('MessageBubble', () => {
  it('renders user message with markdown and alignment', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: '1', role: 'user' as const, text: 'hello there' },
      },
    })

    const bubble = wrapper.find('.user-markdown')
    expect(bubble.exists()).toBe(true)
    expect(bubble.html()).toContain('hello there')
    expect(wrapper.find('.self-end').exists()).toBe(true)
    expect(wrapper.find('.message-bubble--user').exists()).toBe(true)
  })

  it('marks bond messages with a stable role class for mobile-only styling', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: { msg: { id: '2', role: 'bond' as const, text: 'A reply', streaming: false } },
    })

    expect(wrapper.find('.message-bubble--bond').exists()).toBe(true)
  })

  it('renders bond message with MarkdownMessage component', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: '2', role: 'bond' as const, text: '**bold**', streaming: false },
      },
    })

    const md = wrapper.findComponent(MarkdownMessage)
    expect(md.exists()).toBe(true)
    expect(md.props()).toMatchObject({ text: '**bold**', streaming: false })
  })

  it('renders tool call as minimal summary', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: '3', role: 'meta' as const, kind: 'tool' as const, name: 'Read', summary: '/path/to/file.ts' },
      },
    })

    expect(wrapper.text()).toContain('Read file.ts')
    expect(wrapper.find('.activity-summary').exists()).toBe(true)
  })

  it('renders image generation tool calls as a friendly verb without the prompt', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: 'i1', role: 'meta' as const, kind: 'tool' as const, name: 'codex_generate_image', summary: '{"prompt":"A very long prompt"}' },
      },
    })

    expect(wrapper.text()).toContain('Generating image')
    expect(wrapper.text()).not.toContain('prompt')
  })

  it('renders tool call without summary as verb only', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: '4', role: 'meta' as const, kind: 'tool' as const, name: 'Glob' },
      },
    })

    expect(wrapper.text()).toContain('Searched files')
  })

  it('renders a generated image with data URI, alt text, and start alignment', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: {
          id: 'g1',
          role: 'meta' as const,
          kind: 'image' as const,
          imageIds: ['img-1'],
          images: [{ data: 'aGVsbG8=', mediaType: 'image/png' as const }],
          alt: 'A watercolor fox',
        },
      },
    })

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('data:image/png;base64,aGVsbG8=')
    expect(img.attributes('alt')).toBe('A watercolor fox')
    expect(wrapper.find('.self-start').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Loading image')
  })

  it('shows a placeholder for a generated image whose data is still loading', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: 'g2', role: 'meta' as const, kind: 'image' as const, imageIds: ['img-1'] },
      },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('Loading image')
  })

  it('renders error message with error styling', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: '5', role: 'meta' as const, kind: 'error' as const, text: 'something broke' },
      },
    })

    expect(wrapper.text()).toContain('something broke')
    expect(wrapper.find('.text-err').exists()).toBe(true)
  })

  it('renders system message', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: '6', role: 'meta' as const, kind: 'system' as const, text: 'connected' },
      },
    })

    expect(wrapper.text()).toContain('connected')
    expect(wrapper.find('.self-center').exists()).toBe(true)
  })
})

describe('MessageBubble thread footer', () => {
  let bond: { getThreadForAnchor: ReturnType<typeof vi.fn>; onThreadChanged: (fn: () => void) => () => void; listRecentThreads: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    resetThreadsForTest()
    bond = {
      getThreadForAnchor: vi.fn().mockResolvedValue(null),
      listRecentThreads: vi.fn().mockResolvedValue({ threads: [] }),
      onThreadChanged: () => () => {},
    }
    ;(window as unknown as { bond: unknown }).bond = bond
  })

  afterEach(() => {
    resetThreadsForTest()
    delete (window as unknown as { bond?: unknown }).bond
  })

  it('hides the footer while the response is still streaming', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: { msg: { id: 'b1', role: 'bond' as const, text: 'typing…', streaming: true } },
    })
    expect(wrapper.find('.thread-footer-action').exists()).toBe(false)
  })

  it('shows Discuss once the response completes, with no thread yet', async () => {
    const wrapper = shallowMount(MessageBubble, {
      props: { msg: { id: 'b2', role: 'bond' as const, text: 'done', streaming: false } },
    })
    await Promise.resolve()
    await nextTick()

    const action = wrapper.find('.thread-footer-action')
    expect(action.exists()).toBe(true)
    expect(action.text()).toBe('Discuss')
    expect(action.attributes('aria-label')).toBe('Start a thread about this response')
  })

  it('shows the reply count once a thread with replies exists for this anchor', async () => {
    bond.getThreadForAnchor.mockResolvedValue({
      id: 't1', anchorMessageId: 'b3', status: 'open', replyCount: 3,
      contextSnapshot: { version: 1, createdAt: '', anchorMessageId: 'b3', anchorSeq: 1, messages: [] },
      createdAt: '', updatedAt: '',
    })
    const wrapper = shallowMount(MessageBubble, {
      props: { msg: { id: 'b3', role: 'bond' as const, text: 'done', streaming: false } },
    })
    await Promise.resolve()
    await nextTick()

    const action = wrapper.find('.thread-footer-action')
    expect(action.text()).toBe('Thread · 3')
    expect(action.attributes('aria-label')).toBe('Open thread with 3 replies')
  })

  it('never shows the footer on the onboarding intro message', async () => {
    const wrapper = shallowMount(MessageBubble, {
      props: { msg: { id: 'onboarding-intro', role: 'bond' as const, text: 'welcome', streaming: false } },
    })
    await Promise.resolve()
    await nextTick()
    expect(wrapper.find('.thread-footer-action').exists()).toBe(false)
  })

  it('never shows the footer when threadsEnabled is false (the remote web client)', async () => {
    const wrapper = shallowMount(MessageBubble, {
      props: { msg: { id: 'b-web', role: 'bond' as const, text: 'done', streaming: false }, threadsEnabled: false },
    })
    await Promise.resolve()
    await nextTick()
    expect(wrapper.find('.thread-footer-action').exists()).toBe(false)
    // Never even looks up whether a thread exists for THIS anchor — nothing to do with the answer.
    expect(bond.getThreadForAnchor).not.toHaveBeenCalledWith('b-web')
  })

  it('emits openThread with the message id when clicked', async () => {
    const wrapper = shallowMount(MessageBubble, {
      props: { msg: { id: 'b4', role: 'bond' as const, text: 'done', streaming: false } },
    })
    await Promise.resolve()
    await nextTick()

    await wrapper.find('.thread-footer-action').trigger('click')
    expect(wrapper.emitted('openThread')).toEqual([['b4']])
  })

  // plans/chat-threads.md Failure behavior: a failed thread.create shows a
  // non-destructive inline error next to Discuss rather than doing nothing.
  it('shows an inline error next to Discuss when this anchor has a recorded create failure', async () => {
    const { useThreads } = await import('../composables/useThreads')
    ;(window as unknown as { bond: any }).bond.createThread = vi.fn().mockRejectedValue(new Error('boom'))
    const { openThread } = useThreads()
    await openThread('b5')

    const wrapper = shallowMount(MessageBubble, {
      props: { msg: { id: 'b5', role: 'bond' as const, text: 'done', streaming: false } },
      global: { stubs: { BondText: false } }, // default auto-stub drops slot content — assert real text
    })
    await Promise.resolve()
    await nextTick()

    expect(wrapper.find('.thread-footer-error').exists()).toBe(true)
    expect(wrapper.text()).toContain('Try again')
  })
})
