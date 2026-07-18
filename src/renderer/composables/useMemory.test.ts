import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemory } from './useMemory'
import type { SessionDebrief } from '../../shared/sense'

function makeDebrief(overrides: Partial<SessionDebrief> = {}): SessionDebrief {
  return {
    id: 'd1',
    sessionId: 's1',
    sessionTitle: 'Session One',
    projectId: null,
    summary: 'Did some work',
    topics: ['work'],
    decisions: [],
    openThreads: [],
    keyFacts: [],
    messageCount: 4,
    durationSeconds: 120,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function setupBond() {
  const bondMock = {
    senseMemory: vi.fn().mockResolvedValue({ debriefs: [] }),
    senseDeleteDebrief: vi.fn().mockResolvedValue({ ok: true }),
  }
  ;(window as any).bond = bondMock
  return bondMock
}

describe('useMemory', () => {
  beforeEach(async () => {
    setupBond()
    const mem = useMemory()
    mem.debriefs.value = []
    mem.loading.value = false
  })

  it('loads debriefs', async () => {
    const debriefs = [makeDebrief()]
    const bondMock = setupBond()
    bondMock.senseMemory.mockResolvedValue({ debriefs })

    const mem = useMemory()
    await mem.loadMemory()

    expect(bondMock.senseMemory).toHaveBeenCalled()
    expect(mem.debriefs.value).toEqual(debriefs)
    expect(mem.isEmpty.value).toBe(false)
  })

  it('sets loading while loading', async () => {
    let resolveFn!: (value: { debriefs: SessionDebrief[] }) => void
    const bondMock = setupBond()
    bondMock.senseMemory.mockReturnValue(new Promise(r => { resolveFn = r }))

    const mem = useMemory()
    const promise = mem.loadMemory()
    expect(mem.loading.value).toBe(true)
    resolveFn({ debriefs: [] })
    await promise
    expect(mem.loading.value).toBe(false)
  })

  it('deletes a debrief optimistically', async () => {
    const bondMock = setupBond()
    const mem = useMemory()
    mem.debriefs.value = [makeDebrief({ id: 'd1' }), makeDebrief({ id: 'd2' })]

    await mem.deleteDebrief('d1')

    expect(mem.debriefs.value.map(d => d.id)).toEqual(['d2'])
    expect(bondMock.senseDeleteDebrief).toHaveBeenCalledWith('d1')
  })

  it('restores debriefs if delete fails', async () => {
    const bondMock = setupBond()
    bondMock.senseDeleteDebrief.mockRejectedValue(new Error('fail'))
    const mem = useMemory()
    mem.debriefs.value = [makeDebrief({ id: 'd1' })]

    await mem.deleteDebrief('d1')

    expect(mem.debriefs.value.map(d => d.id)).toEqual(['d1'])
  })
})
