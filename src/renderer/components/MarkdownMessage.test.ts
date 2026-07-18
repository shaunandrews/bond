import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import type { ComponentPublicInstance } from 'vue'
import MarkdownMessage from './MarkdownMessage.vue'

// VTU's mount return type collapses SFC prop types to built-ins under this
// toolchain, so setProps() loses `text`/`streaming`. Mount through a typed
// helper that pins the instance type, keeping setProps() type-safe.
type MdProps = { text: string; streaming: boolean }
type MdWrapper = VueWrapper<unknown, ComponentPublicInstance<MdProps>>

function mountMd(props: MdProps): MdWrapper {
  return mount(MarkdownMessage, { props }) as unknown as MdWrapper
}

describe('MarkdownMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders markdown immediately when not streaming', () => {
    const wrapper = mountMd({ text: '**bold text**', streaming: false })
    expect(wrapper.html()).toContain('<strong>bold text</strong>')
  })

  it('renders markdown during streaming after timer tick', async () => {
    const wrapper = mountMd({ text: 'Hello', streaming: true })

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
    const wrapper = mountMd({ text: 'partial', streaming: true })

    vi.advanceTimersByTime(20)

    // Streaming ends
    await wrapper.setProps({ text: '**complete**', streaming: false })
    await wrapper.vm.$nextTick()
    expect(wrapper.html()).toContain('<strong>complete</strong>')
  })

  it('renders code blocks with syntax highlighting', () => {
    const code = '```js\nconst x = 1\n```'
    const wrapper = mountMd({ text: code, streaming: false })
    expect(wrapper.find('.code-block').exists()).toBe(true)
    expect(wrapper.find('.code-block-lang').text()).toBe('js')
    expect(wrapper.find('.code-block-copy').exists()).toBe(true)
  })
})
