import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemory } from './useMemory'
import type { CoreMemory, MemoryItem, WorkingState } from '../../shared/memory'

function core(): CoreMemory {
  return { version: 1, facts: ['Bond uses Vitest'], preferences: [], decisions: [], updatedAt: '2026-01-01T00:00:00.000Z' }
}

function working(): WorkingState {
  return { sessionId: null, projectId: null, goal: 'Ship memory', facts: [], preferences: [], decisions: [], openThreads: [], artifacts: [], activeSkill: null, checkpoint: null, updatedAt: '2026-01-01T00:00:00.000Z' }
}

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'm1',
    kind: 'fact',
    text: 'Shaun likes restrained UI',
    source: 'user',
    projectId: null,
    tags: [],
    confidence: 1,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function setupBond() {
  const bondMock = {
    memoryCore: vi.fn().mockResolvedValue(core()),
    memoryWorking: vi.fn().mockResolvedValue(working()),
    memorySearch: vi.fn().mockResolvedValue({ results: [{ item: item(), score: 0 }] }),
    memoryUpdateCore: vi.fn().mockImplementation(async (value: CoreMemory) => value),
    memoryUpdateWorking: vi.fn().mockImplementation(async (value: WorkingState) => value),
    memoryClearWorking: vi.fn().mockResolvedValue({ ...working(), goal: '' }),
    memoryUpsert: vi.fn().mockImplementation(async (value: MemoryItem) => ({ ...item(), ...value })),
    memoryDelete: vi.fn().mockResolvedValue({ ok: true }),
    memorySources: vi.fn().mockResolvedValue({ sourceIds: ['u1'], messages: [] }),
  }
  ;(window as any).bond = bondMock
  return bondMock
}

describe('useMemory', () => {
  beforeEach(() => {
    setupBond()
    const mem = useMemory()
    mem.results.value = []
    mem.loading.value = false
    mem.error.value = null
  })

  it('loads core, working, and recent memory', async () => {
    const mem = useMemory()
    await mem.loadMemory()

    expect(mem.core.value.facts).toEqual(['Bond uses Vitest'])
    expect(mem.working.value.goal).toBe('Ship memory')
    expect(mem.results.value[0].item.text).toContain('restrained UI')
  })

  it('saves core memory', async () => {
    const bondMock = setupBond()
    const mem = useMemory()
    await mem.saveCore({ ...core(), facts: ['new fact'] })

    expect(bondMock.memoryUpdateCore).toHaveBeenCalledWith(expect.objectContaining({ facts: ['new fact'] }))
    expect(mem.core.value.facts).toEqual(['new fact'])
  })

  it('deletes an item optimistically', async () => {
    const bondMock = setupBond()
    const mem = useMemory()
    mem.results.value = [{ item: item({ id: 'm1' }), score: 0 }, { item: item({ id: 'm2' }), score: 0 }]

    await mem.remove('m1')

    expect(mem.results.value.map(r => r.item.id)).toEqual(['m2'])
    expect(bondMock.memoryDelete).toHaveBeenCalledWith('m1')
  })
})
