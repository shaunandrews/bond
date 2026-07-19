import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import QuickChat from './QuickChat.vue'
import ChatInput from './ChatInput.vue'

describe('QuickChat', () => {
  beforeEach(() => {
    // Mock window.bond with all methods used by QuickChat
    const mockBond = {
      send: vi.fn().mockResolvedValue({ ok: true }),
      cancel: vi.fn().mockResolvedValue({ ok: true }),
      onChunk: vi.fn().mockReturnValue(() => {}),
      respondToApproval: vi.fn().mockResolvedValue({ ok: true }),
      getMessages: vi.fn().mockResolvedValue([]),
      saveMessages: vi.fn().mockResolvedValue(true),
      getImages: vi.fn().mockResolvedValue([]),
      listTranscript: vi.fn().mockResolvedValue({ messages: [], nextBeforeSeq: null }),
      upsertTranscript: vi.fn().mockResolvedValue({ ok: true }),
      createSession: vi.fn().mockResolvedValue({ id: 'transport-1' }),
      getModel: vi.fn().mockResolvedValue('balanced'),
      setModel: vi.fn().mockResolvedValue({ ok: true }),
      getEditMode: vi.fn().mockResolvedValue({ type: 'full' }),
      setEditMode: vi.fn().mockResolvedValue({ ok: true }),
      subscribe: vi.fn().mockResolvedValue({ ok: true }),
      unsubscribe: vi.fn().mockResolvedValue({ ok: true }),
      onQuickChatInit: vi.fn().mockReturnValue(() => {}),
      onQuickChatDismiss: vi.fn().mockReturnValue(() => {}),
      quickChatDismissed: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockResolvedValue([]),
    }
    ;(window as any).bond = mockBond
  })

  it('renders the quick-chat root element', () => {
    const wrapper = shallowMount(QuickChat)
    expect(wrapper.find('.quick-chat').exists()).toBe(true)
  })

  it('does not show content before init', () => {
    const wrapper = shallowMount(QuickChat)
    // No context-bar or messages visible before ready
    expect(wrapper.find('.context-bar').exists()).toBe(false)
    expect(wrapper.find('.messages').exists()).toBe(false)
  })

  it('registers onQuickChatInit listener on mount', () => {
    shallowMount(QuickChat)
    expect(window.bond.onQuickChatInit).toHaveBeenCalled()
  })

  it('registers onQuickChatDismiss listener on mount', () => {
    shallowMount(QuickChat)
    expect(window.bond.onQuickChatDismiss).toHaveBeenCalled()
  })

  it('shows context bar after init with sense apps', async () => {
    let initCallback: Function | undefined
    ;(window as any).bond.onQuickChatInit = vi.fn((fn: Function) => {
      initCallback = fn
      return () => {}
    })

    const wrapper = shallowMount(QuickChat)

    // Simulate init from main process
    await initCallback?.({ senseApps: ['VS Code', 'Figma'] })
    // Allow multiple ticks for async loadSession + nextTick + requestAnimationFrame
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    await new Promise(r => setTimeout(r, 50))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.context-bar').exists()).toBe(true)
    expect(wrapper.text()).toContain('VS Code')
    expect(wrapper.text()).toContain('Figma')
  })

  it('sends attached images through and passes no phantom trim-bottom attr', async () => {
    // Regression: handleSend ignored ChatInput's images payload, silently
    // discarding pasted images, and passed a trim-bottom prop that ChatInput
    // never declared.
    let initCallback: Function | undefined
    ;(window as any).bond.onQuickChatInit = vi.fn((fn: Function) => {
      initCallback = fn
      return () => {}
    })

    const wrapper = shallowMount(QuickChat)
    await initCallback?.({ senseApps: [] })
    await wrapper.vm.$nextTick()
    await new Promise(r => setTimeout(r, 50))
    await wrapper.vm.$nextTick()

    const input = wrapper.findComponent(ChatInput)
    expect(input.exists()).toBe(true)
    expect(input.attributes('trim-bottom')).toBeUndefined()

    const image = { data: 'abc', mediaType: 'image/png' }
    input.vm.$emit('submit', 'look at this', [image])

    await vi.waitFor(() => {
      expect(window.bond.send).toHaveBeenCalledWith(expect.objectContaining({
        text: 'look at this',
        images: [image],
      }))
    })
  })

  it('does not show context bar when no sense apps', async () => {
    let initCallback: Function | undefined
    ;(window as any).bond.onQuickChatInit = vi.fn((fn: Function) => {
      initCallback = fn
      return () => {}
    })

    const wrapper = shallowMount(QuickChat)

    await initCallback?.({ senseApps: [] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    await new Promise(r => setTimeout(r, 50))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.context-bar').exists()).toBe(false)
  })
})
