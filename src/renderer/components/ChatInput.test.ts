import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatInput from './ChatInput.vue'

describe('ChatInput', () => {
  function createWrapper(busy = false) {
    return mount(ChatInput, { props: { busy, model: 'sonnet' as const } })
  }

  it('emits submit with text on Enter', async () => {
    const wrapper = createWrapper()
    const textarea = wrapper.find('textarea')

    ;(textarea.element as HTMLTextAreaElement).value = 'hello'
    await textarea.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('submit')![0]).toEqual(['hello'])
  })

  it('does not emit submit on Shift+Enter', async () => {
    const wrapper = createWrapper()
    const textarea = wrapper.find('textarea')

    ;(textarea.element as HTMLTextAreaElement).value = 'hello'
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })

    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('does not emit submit when textarea is empty', async () => {
    const wrapper = createWrapper()
    const textarea = wrapper.find('textarea')

    ;(textarea.element as HTMLTextAreaElement).value = ''
    await textarea.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('clears textarea after submit', async () => {
    const wrapper = createWrapper()
    const textarea = wrapper.find('textarea')

    ;(textarea.element as HTMLTextAreaElement).value = 'hello'
    await textarea.trigger('keydown', { key: 'Enter' })

    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })

  it('emits submit on Send button click', async () => {
    const wrapper = createWrapper()
    const textarea = wrapper.find('textarea')
    ;(textarea.element as HTMLTextAreaElement).value = 'hello'

    const sendButton = wrapper.findAll('button').find((b) => b.text() === 'Send')!
    await sendButton.trigger('click')

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('submit')![0]).toEqual(['hello'])
  })

  it('emits cancel on Stop button click', async () => {
    const wrapper = createWrapper(true)

    const stopButton = wrapper.findAll('button').find((b) => b.text() === 'Stop')!
    await stopButton.trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('disables textarea and Send when busy', () => {
    const wrapper = createWrapper(true)
    const textarea = wrapper.find('textarea')
    const sendButton = wrapper.findAll('button').find((b) => b.text() === 'Send')!
    const stopButton = wrapper.findAll('button').find((b) => b.text() === 'Stop')!

    expect(textarea.attributes('disabled')).toBeDefined()
    expect(sendButton.attributes('disabled')).toBeDefined()
    expect(stopButton.attributes('disabled')).toBeUndefined()
  })

  it('disables Stop when not busy', () => {
    const wrapper = createWrapper(false)
    const stopButton = wrapper.findAll('button').find((b) => b.text() === 'Stop')!
    const sendButton = wrapper.findAll('button').find((b) => b.text() === 'Send')!

    expect(stopButton.attributes('disabled')).toBeDefined()
    expect(sendButton.attributes('disabled')).toBeUndefined()
  })
})
