import { describe, it, expect } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import MessageBubble from './MessageBubble.vue'
import MarkdownMessage from './MarkdownMessage.vue'

describe('MessageBubble', () => {
  it('renders user message with correct text and alignment', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: '1', role: 'user' as const, text: 'hello there' },
      },
    })

    expect(wrapper.text()).toContain('hello there')
    expect(wrapper.find('.self-end').exists()).toBe(true)
  })

  it('renders bond message with MarkdownMessage component', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: '2', role: 'bond' as const, text: '**bold**', streaming: false },
      },
    })

    const md = wrapper.findComponent(MarkdownMessage)
    expect(md.exists()).toBe(true)
    expect(md.props('text')).toBe('**bold**')
    expect(md.props('streaming')).toBe(false)
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

  it('renders tool call without summary as verb only', () => {
    const wrapper = shallowMount(MessageBubble, {
      props: {
        msg: { id: '4', role: 'meta' as const, kind: 'tool' as const, name: 'Glob' },
      },
    })

    expect(wrapper.text()).toContain('Searched files')
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
