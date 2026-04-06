import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import QuickChat from './QuickChat.vue'

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
      getModel: vi.fn().mockResolvedValue('sonnet'),
      setModel: vi.fn().mockResolvedValue({ ok: true }),
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
    await initCallback?.({ sessionId: 'test-session-1', senseApps: ['VS Code', 'Figma'] })
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

  it('does not show context bar when no sense apps', async () => {
    let initCallback: Function | undefined
    ;(window as any).bond.onQuickChatInit = vi.fn((fn: Function) => {
      initCallback = fn
      return () => {}
    })

    const wrapper = shallowMount(QuickChat)

    await initCallback?.({ sessionId: 'test-session-2', senseApps: [] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    await new Promise(r => setTimeout(r, 50))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.context-bar').exists()).toBe(false)
  })
})
