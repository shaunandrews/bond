import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MemoryView from './MemoryView.vue'
import { useMemory } from '../composables/useMemory'
import type { CoreMemory, MemoryItem, WorkingState } from '../../shared/memory'

const core: CoreMemory = {
  version: 1,
  facts: ['Shaun likes concise answers'],
  preferences: ['Use tests'],
  decisions: ['Continuous transcript is canonical'],
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const working: WorkingState = {
  sessionId: null,
  projectId: null,
  goal: 'Clean up session UI',
  facts: ['Renderer owns composer state'],
  preferences: [],
  decisions: [],
  openThreads: ['Remove dead tests'],
  artifacts: [],
  activeSkill: null,
  checkpoint: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'm1',
    kind: 'fact',
    text: 'Bond has one continuous transcript',
    source: 'user',
    projectId: null,
    tags: ['source:msg1'],
    confidence: 0.9,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function setupBond() {
  const item = makeItem()
  const bondMock = {
    memoryCore: vi.fn().mockResolvedValue(core),
    memoryWorking: vi.fn().mockResolvedValue(working),
    memorySearch: vi.fn().mockResolvedValue({ results: [{ item, score: 0.9 }] }),
    memoryUpdateCore: vi.fn().mockResolvedValue(core),
    memoryUpdateWorking: vi.fn().mockResolvedValue(working),
    memoryClearWorking: vi.fn().mockResolvedValue({ ...working, goal: '', facts: [], preferences: [], decisions: [], openThreads: [] }),
    memoryUpsert: vi.fn().mockImplementation(async (input) => ({ ...item, ...input })),
    memoryDelete: vi.fn().mockResolvedValue({ ok: true }),
    memorySources: vi.fn().mockResolvedValue({ sourceIds: ['msg1'], messages: [{ id: 'msg1', seq: 7, role: 'user', text: 'Original note' }] }),
  }
  ;(window as any).bond = bondMock
  return { bondMock, item }
}

async function switchTab(wrapper: ReturnType<typeof mount>, label: string) {
  await wrapper.findAll('button').find(b => b.text() === label)!.trigger('click')
  await flushPromises()
}

describe('MemoryView', () => {
  beforeEach(() => {
    setupBond()
    const mem = useMemory()
    mem.core.value = { version: 1, facts: [], preferences: [], decisions: [], updatedAt: '2026-01-01T00:00:00.000Z' }
    mem.working.value = { sessionId: null, projectId: null, goal: '', facts: [], preferences: [], decisions: [], openThreads: [], artifacts: [], activeSkill: null, checkpoint: null, updatedAt: '2026-01-01T00:00:00.000Z' }
    mem.results.value = []
    mem.sources.value = { sourceIds: [], messages: [] }
    mem.loading.value = false
    mem.saving.value = false
    mem.error.value = null
  })

  it('loads and renders core memory', async () => {
    const { bondMock } = setupBond()
    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(bondMock.memoryCore).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Stable details Bond should keep across work')
    expect(wrapper.text()).toContain('Facts')
  })

  it('saves edited core memory', async () => {
    const { bondMock } = setupBond()
    const wrapper = mount(MemoryView)
    await flushPromises()

    const textarea = wrapper.find('textarea')
    await textarea.setValue('A durable fact')
    await wrapper.findAll('button').find(b => b.text() === 'Save core')!.trigger('click')
    await flushPromises()

    expect(bondMock.memoryUpdateCore).toHaveBeenCalledWith(expect.objectContaining({ facts: ['A durable fact'] }))
  })

  it('renders working memory tab', async () => {
    const wrapper = mount(MemoryView)
    await flushPromises()
    await switchTab(wrapper, 'Working')

    expect(wrapper.text()).toContain('Current scratchpad')
    expect(wrapper.find('input').element.value).toBe('Clean up session UI')
  })

  it('searches and renders memory results', async () => {
    const { bondMock } = setupBond()
    const wrapper = mount(MemoryView)
    await flushPromises()
    await switchTab(wrapper, 'Search')

    await wrapper.find('.search-row input').setValue('continuous')
    await wrapper.find('.search-row button').trigger('click')
    await flushPromises()

    expect(bondMock.memorySearch).toHaveBeenLastCalledWith('continuous', 20)
    expect(wrapper.text()).toContain('Bond has one continuous transcript')
  })

  it('shows source messages for a memory item', async () => {
    const { bondMock } = setupBond()
    const wrapper = mount(MemoryView)
    await flushPromises()
    await switchTab(wrapper, 'Search')

    await wrapper.find('.card-actions button').trigger('click')
    await flushPromises()

    expect(bondMock.memorySources).toHaveBeenCalledWith('m1')
    expect(wrapper.text()).toContain('Original messages attached to the selected memory item')
    expect(wrapper.text()).toContain('Original note')
  })

  it('deletes a memory result', async () => {
    const { bondMock } = setupBond()
    const wrapper = mount(MemoryView)
    await flushPromises()
    await switchTab(wrapper, 'Search')

    await wrapper.findAll('.card-actions button')[1].trigger('click')
    await flushPromises()

    expect(bondMock.memoryDelete).toHaveBeenCalledWith('m1')
  })
})
