import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownMessage from './MarkdownMessage.vue'

describe('MarkdownMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders markdown immediately when not streaming', () => {
    const wrapper = mount(MarkdownMessage, {
      props: { text: '**bold text**', streaming: false },
    })
    expect(wrapper.html()).toContain('<strong>bold text</strong>')
  })

  it('renders markdown during streaming after timer tick', async () => {
    const wrapper = mount(MarkdownMessage, {
      props: { text: 'Hello', streaming: true },
    })

    // Initial render is throttled via rAF (setTimeout 16ms fallback)
    vi.advanceTimersByTime(20)
    await wrapper.vm.$nextTick()
    expect(wrapper.html()).toContain('Hello')

    // Update text (simulating a new delta)
    await wrapper.setProps({ text: 'Hello world' })
    vi.advanceTimersByTime(20)
    await wrapper.vm.$nextTick()
    expect(wrapper.html()).toContain('Hello world')
  })

  it('does a final render when streaming ends', async () => {
    const wrapper = mount(MarkdownMessage, {
      props: { text: 'partial', streaming: true },
    })

    vi.advanceTimersByTime(20)

    // Streaming ends
    await wrapper.setProps({ text: '**complete**', streaming: false })
    await wrapper.vm.$nextTick()
    expect(wrapper.html()).toContain('<strong>complete</strong>')
  })

  it('renders code blocks with syntax highlighting', () => {
    const code = '```js\nconst x = 1\n```'
    const wrapper = mount(MarkdownMessage, {
      props: { text: code, streaming: false },
    })
    expect(wrapper.find('.code-block').exists()).toBe(true)
    expect(wrapper.find('.code-block-lang').text()).toBe('js')
    expect(wrapper.find('.code-block-copy').exists()).toBe(true)
  })
})
