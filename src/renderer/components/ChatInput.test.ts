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

    const stopBtn = wrapper.findAll('button').find(b => b.text().includes('Esc to stop'))!
    await stopBtn.trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('shows send button when not busy', () => {
    const wrapper = createWrapper(false)

    expect(wrapper.find('[data-action="send"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Esc to stop')
  })

  it('shows both stop and send buttons when busy', () => {
    const wrapper = createWrapper(true)

    expect(wrapper.text()).toContain('Esc to stop')
    expect(wrapper.find('[data-action="send"]').exists()).toBe(true)
  })

  it('keeps textarea enabled when busy for message queuing', () => {
    const wrapper = createWrapper(true)
    const textarea = wrapper.find('textarea')

    expect(textarea.attributes('disabled')).toBeUndefined()
  })

  it('emits submit even when busy (for queuing)', async () => {
    const wrapper = createWrapper(true)
    const textarea = wrapper.find('textarea')

    ;(textarea.element as HTMLTextAreaElement).value = 'queued msg'
    await textarea.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('submit')![0]).toEqual(['queued msg', []])
  })

  it('setText populates textarea via exposed method', async () => {
    const wrapper = createWrapper()
    const textarea = wrapper.find('textarea')

    ;(wrapper.vm as any).setText('edited message')
    expect((textarea.element as HTMLTextAreaElement).value).toBe('edited message')
  })
})
