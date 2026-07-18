import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MemoryView from './MemoryView.vue'
import { useMemory } from '../composables/useMemory'
import type { SessionDebrief } from '../../shared/sense'

function makeDebrief(overrides: Partial<SessionDebrief> = {}): SessionDebrief {
  return {
    id: 'd1',
    sessionId: 's1',
    sessionTitle: 'Session One',
    summary: 'Session summary',
    topics: ['memory'],
    messageCount: 5,
    durationSeconds: 180,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function setupBond(data?: { debriefs?: SessionDebrief[]; prompt?: string }) {
  const bondMock = {
    senseMemory: vi.fn().mockResolvedValue({ debriefs: data?.debriefs ?? [] }),
    senseDeleteDebrief: vi.fn().mockResolvedValue({ ok: true }),
    senseSystemPromptPreview: vi.fn().mockResolvedValue({ prompt: data?.prompt ?? 'SYSTEM PROMPT' }),
  }
  ;(window as any).bond = bondMock
  return bondMock
}

describe('MemoryView', () => {
  beforeEach(() => {
    setupBond()
    const mem = useMemory()
    mem.debriefs.value = []
    mem.loading.value = false
  })

  it('loads and renders session debriefs', async () => {
    setupBond({ debriefs: [makeDebrief()] })

    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(wrapper.text()).toContain('Session Debriefs (1)')
    expect(wrapper.text()).toContain('Session One')
    expect(wrapper.text()).toContain('Session summary')
  })

  it('shows an empty debrief state', async () => {
    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(wrapper.text()).toContain('No debriefs yet')
  })

  it('opens debrief detail with summary topics and session link', async () => {
    setupBond({ debriefs: [makeDebrief()] })
    const wrapper = mount(MemoryView)
    await flushPromises()

    await wrapper.find('.debrief-card').trigger('click')

    expect(wrapper.text()).toContain('Summary')
    expect(wrapper.text()).toContain('Topics')
    expect(wrapper.text()).toContain('Open “Session One”')
  })

  it('emits openSession from detail link', async () => {
    setupBond({ debriefs: [makeDebrief({ sessionId: 's1' })] })
    const wrapper = mount(MemoryView)
    await flushPromises()
    await wrapper.find('.debrief-card').trigger('click')

    await wrapper.find('.session-link').trigger('click')

    expect(wrapper.emitted('openSession')?.[0]).toEqual(['s1'])
  })

  it('deletes selected debriefs', async () => {
    const bondMock = setupBond({ debriefs: [makeDebrief()] })
    const wrapper = mount(MemoryView)
    await flushPromises()
    await wrapper.find('.debrief-card').trigger('click')

    await wrapper.find('.delete-btn').trigger('click')
    await flushPromises()

    expect(bondMock.senseDeleteDebrief).toHaveBeenCalledWith('d1')
    expect(wrapper.text()).toContain('No debriefs yet')
  })

  it('shows exact prompt preview tab', async () => {
    const bondMock = setupBond({ prompt: 'EXACT PROMPT' })
    const wrapper = mount(MemoryView)
    await flushPromises()

    await wrapper.findAll('button').find(b => b.text() === 'Prompt')!.trigger('click')
    await flushPromises()

    expect(bondMock.senseSystemPromptPreview).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Exact full system prompt')
    expect(wrapper.find('.prompt-text').text()).toContain('EXACT PROMPT')
  })
})
