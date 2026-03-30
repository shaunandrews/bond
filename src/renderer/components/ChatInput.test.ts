import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatInput from './ChatInput.vue'

describe('ChatInput', () => {
  function createWrapper(busy = false) {
    return mount(ChatInput, { props: { busy, model: 'sonnet' as const, editMode: { type: 'full' as const } } })
  }

  it('emits submit with text on Enter', async () => {
    const wrapper = createWrapper()
    const textarea = wrapper.find('textarea')

    ;(textarea.element as HTMLTextAreaElement).value = 'hello'
    await textarea.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('submit')![0]).toEqual(['hello', []])
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

  it('emits submit on action button click when not busy', async () => {
    const wrapper = createWrapper()
    const textarea = wrapper.find('textarea')
    ;(textarea.element as HTMLTextAreaElement).value = 'hello'

    const actionBtn = wrapper.find('[data-action="send"]')
    await actionBtn.trigger('click')

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('submit')![0]).toEqual(['hello', []])
  })

  it('emits cancel on action button click when busy', async () => {
    const wrapper = createWrapper(true)

    const actionBtn = wrapper.find('[data-action="stop"]')
    await actionBtn.trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('shows send button when not busy', () => {
    const wrapper = createWrapper(false)

    expect(wrapper.find('[data-action="send"]').exists()).toBe(true)
    expect(wrapper.find('[data-action="stop"]').exists()).toBe(false)
  })

  it('shows stop button when busy', () => {
    const wrapper = createWrapper(true)

    expect(wrapper.find('[data-action="stop"]').exists()).toBe(true)
    expect(wrapper.find('[data-action="send"]').exists()).toBe(false)
  })

  it('disables textarea when busy', () => {
    const wrapper = createWrapper(true)
    const textarea = wrapper.find('textarea')

    expect(textarea.attributes('disabled')).toBeDefined()
  })
})
