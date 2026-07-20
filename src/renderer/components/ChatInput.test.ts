import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ChatInput from './ChatInput.vue'
import { resetIssueReferencesForTest } from '../composables/useIssueReferences'

describe('ChatInput', () => {
  function createWrapper(busy = false) {
    return mount(ChatInput, {
      props: { busy, model: 'balanced' as const, editMode: { type: 'full' as const } },
      global: { stubs: { Teleport: true } },
    })
  }

  it('uses the default placeholder unless one is provided', () => {
    const wrapper = createWrapper()
    expect(wrapper.find('textarea').attributes('placeholder')).toBe('Ask Bond something…')
  })

  it('renders a contextual placeholder when provided', () => {
    const wrapper = mount(ChatInput, {
      props: { busy: false, model: 'balanced' as const, editMode: { type: 'full' as const }, placeholder: 'Your name…' },
      global: { stubs: { Teleport: true } },
    })
    expect(wrapper.find('textarea').attributes('placeholder')).toBe('Your name…')
  })

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

  it('combines reasoning and permissions in a single menu', async () => {
    const wrapper = createWrapper()

    expect(wrapper.findAll('.bond-select')).toHaveLength(0)
    await wrapper.find('[data-action="composer-settings"]').trigger('click')

    expect(wrapper.text()).toContain('Reasoning')
    expect(wrapper.text()).toContain('Permissions')
    expect(wrapper.find('[data-model="balanced"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.find('[data-edit-mode="full"]').attributes('aria-checked')).toBe('true')
  })

  it('updates reasoning from the composer menu', async () => {
    const wrapper = createWrapper()
    await wrapper.find('[data-action="composer-settings"]').trigger('click')
    await wrapper.find('[data-model="high"]').trigger('click')

    expect(wrapper.emitted('update:model')).toEqual([['high']])
  })

  it('updates permissions from the composer menu', async () => {
    const wrapper = createWrapper()
    await wrapper.find('[data-action="composer-settings"]').trigger('click')
    await wrapper.find('[data-edit-mode="readonly"]').trigger('click')

    expect(wrapper.emitted('update:editMode')).toEqual([[{ type: 'readonly' }]])
  })

  it('places composer settings before stop and send actions', () => {
    const wrapper = createWrapper(true)
    const actions = wrapper.find('[data-action="composer-settings"]').element.parentElement!
    const children = Array.from(actions.children)
    const settingsIndex = children.indexOf(wrapper.find('[data-action="composer-settings"]').element)
    const stopButton = wrapper.findAll('button').find(button => button.text().includes('Esc to stop'))!
    const stopIndex = children.indexOf(stopButton.element)
    const sendIndex = children.indexOf(wrapper.find('[data-action="send"]').element)

    expect(settingsIndex).toBeLessThan(stopIndex)
    expect(settingsIndex).toBeLessThan(sendIndex)
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

describe('ChatInput issue references', () => {
  beforeEach(() => {
    resetIssueReferencesForTest()
    ;(window as unknown as { bond: unknown }).bond = {
      listSkills: vi.fn().mockResolvedValue([]),
      listCollectionReferences: vi.fn().mockResolvedValue([
        { key: 'BOND-3', title: 'Redesign composer', collectionId: 'c1', itemId: 'i3', prefix: 'BOND', displayNumber: 3 },
        { key: 'BOND-30', title: 'Other thing', collectionId: 'c1', itemId: 'i30', prefix: 'BOND', displayNumber: 30 },
        { key: 'WP-1', title: 'Two-letter tracker', collectionId: 'c2', itemId: 'i9', prefix: 'WP', displayNumber: 1 },
      ]),
      onCollectionsChanged: () => () => {},
    }
  })

  afterEach(() => {
    resetIssueReferencesForTest()
    delete (window as unknown as { bond?: unknown }).bond
  })

  async function typeText(wrapper: ReturnType<typeof mount<typeof ChatInput>>, text: string) {
    const textarea = wrapper.find('textarea')
    const el = textarea.element as HTMLTextAreaElement
    el.value = text
    el.selectionStart = el.selectionEnd = text.length
    await textarea.trigger('input')
    await nextTick()
  }

  function createReferenceWrapper() {
    return mount(ChatInput, {
      props: { busy: false, model: 'balanced' as const, editMode: { type: 'full' as const } },
      global: { stubs: { Teleport: true } },
    })
  }

  it('opens the suggestion menu for a known prefix, including non-4-letter ones', async () => {
    const wrapper = createReferenceWrapper()
    await Promise.resolve()
    await nextTick()

    await typeText(wrapper, 'related to WP')
    expect(wrapper.find('.issue-menu').exists()).toBe(true)
    expect(wrapper.find('.issue-menu').text()).toContain('WP-1')
  })

  it('stays quiet for unknown uppercase words', async () => {
    const wrapper = createReferenceWrapper()
    await Promise.resolve()
    await nextTick()

    await typeText(wrapper, 'uses HTTP')
    expect(wrapper.find('.issue-menu').exists()).toBe(false)
  })

  it('narrows by number once a dash is typed', async () => {
    const wrapper = createReferenceWrapper()
    await Promise.resolve()
    await nextTick()

    await typeText(wrapper, 'BOND-30')
    const menu = wrapper.find('.issue-menu')
    expect(menu.text()).toContain('BOND-30')
    expect(menu.text()).not.toContain('Redesign composer')
  })

  it('shows a token strip only for known keys present in the text', async () => {
    const wrapper = createReferenceWrapper()
    await Promise.resolve()
    await nextTick()

    await typeText(wrapper, 'see BOND-3 vs UTF-8 and BOND-99 ')
    const strip = wrapper.find('.issue-token-strip')
    expect(strip.exists()).toBe(true)
    expect(strip.text()).toContain('BOND-3')
    expect(strip.text()).not.toContain('UTF-8')
    expect(strip.text()).not.toContain('BOND-99')
  })

  it('highlights known keys as tokens in the preview overlay only', async () => {
    const wrapper = createReferenceWrapper()
    await Promise.resolve()
    await nextTick()

    await typeText(wrapper, 'BOND-3 and UTF-8 ')
    const highlight = wrapper.find('.chat-highlight').html()
    expect(highlight).toContain('<span class="issue-token">BOND-3</span>')
    expect(highlight).not.toContain('<span class="issue-token">UTF-8</span>')
  })
})
