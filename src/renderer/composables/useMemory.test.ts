import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMemory } from './useMemory'
import type { SenseFact, SessionDebrief, OpenThread, DecisionWithContext } from '../../shared/sense'

function makeFact(overrides: Partial<SenseFact> = {}): SenseFact {
  return {
    id: 'f1', fact: 'Test fact', source: 'user', sourceDebriefId: null,
    projectId: null, active: true, createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

function makeDebrief(overrides: Partial<SessionDebrief> = {}): SessionDebrief {
  return {
    id: 'd1', sessionId: 's1', sessionTitle: 'Test Session', projectId: null,
    summary: 'Summary text', topics: ['topic1'], decisions: ['decision1'],
    openThreads: ['thread1'], keyFacts: ['fact1'], messageCount: 10,
    durationSeconds: 300, createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

function makeThread(overrides: Partial<OpenThread> = {}): OpenThread {
  return {
    thread: 'Open thread text', debriefId: 'd1', sessionId: 's1', sessionTitle: 'Test Session',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

function makeDecision(overrides: Partial<DecisionWithContext> = {}): DecisionWithContext {
  return {
    decision: 'Decided to use TypeScript', debriefId: 'd1', sessionTitle: 'Test Session',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

function setupBondMock() {
  const mock = {
    senseMemory: vi.fn().mockResolvedValue({ debriefs: [], facts: [] }),
    senseThreads: vi.fn().mockResolvedValue([]),
    senseDecisions: vi.fn().mockResolvedValue([]),
    senseForget: vi.fn().mockResolvedValue({ ok: true }),
    senseRemember: vi.fn().mockResolvedValue(makeFact()),
    senseUpdateFact: vi.fn().mockResolvedValue(makeFact({ fact: 'Updated' })),
    senseDeleteDebrief: vi.fn().mockResolvedValue({ ok: true }),
    senseDismissThread: vi.fn().mockResolvedValue({ ok: true }),
    senseRemoveDecision: vi.fn().mockResolvedValue({ ok: true }),
  }
  ;(globalThis as any).window = { bond: mock }
  return mock
}

describe('useMemory', () => {
  let bondMock: ReturnType<typeof setupBondMock>

  beforeEach(() => {
    bondMock = setupBondMock()
    // Reset singleton state
    const mem = useMemory()
    mem.facts.value = []
    mem.threads.value = []
    mem.decisions.value = []
    mem.debriefs.value = []
  })

  describe('loadMemory', () => {
    it('populates all four state arrays', async () => {
      const facts = [makeFact({ id: 'f1' }), makeFact({ id: 'f2' })]
      const debriefs = [makeDebrief({ id: 'd1' })]
      const threads = [makeThread()]
      const decisions = [makeDecision()]

      bondMock.senseMemory.mockResolvedValue({ debriefs, facts })
      bondMock.senseThreads.mockResolvedValue(threads)
      bondMock.senseDecisions.mockResolvedValue(decisions)

      const mem = useMemory()
      await mem.loadMemory()

      expect(mem.facts.value).toHaveLength(2)
      expect(mem.debriefs.value).toHaveLength(1)
      expect(mem.threads.value).toHaveLength(1)
      expect(mem.decisions.value).toHaveLength(1)
    })

    it('sets and clears loading state', async () => {
      const mem = useMemory()
      let resolveFn: (v: any) => void
      bondMock.senseMemory.mockReturnValue(new Promise(r => { resolveFn = r }))

      const promise = mem.loadMemory()
      expect(mem.loading.value).toBe(true)

      resolveFn!({ debriefs: [], facts: [] })
      await promise
      expect(mem.loading.value).toBe(false)
    })
  })

  describe('forgetFact', () => {
    it('removes fact optimistically', async () => {
      const mem = useMemory()
      mem.facts.value = [makeFact({ id: 'f1' }), makeFact({ id: 'f2' })]

      await mem.forgetFact('f1')

      expect(mem.facts.value).toHaveLength(1)
      expect(mem.facts.value[0].id).toBe('f2')
      expect(bondMock.senseForget).toHaveBeenCalledWith('f1')
    })

    it('rolls back on RPC failure', async () => {
      bondMock.senseForget.mockRejectedValue(new Error('fail'))

      const mem = useMemory()
      mem.facts.value = [makeFact({ id: 'f1' }), makeFact({ id: 'f2' })]

      await mem.forgetFact('f1')

      expect(mem.facts.value).toHaveLength(2)
    })
  })

  describe('updateFact', () => {
    it('replaces fact in list after RPC succeeds', async () => {
      const updated = makeFact({ id: 'f1', fact: 'Updated text' })
      bondMock.senseUpdateFact.mockResolvedValue(updated)

      const mem = useMemory()
      mem.facts.value = [makeFact({ id: 'f1', fact: 'Original' })]

      await mem.updateFact('f1', 'Updated text')

      expect(mem.facts.value[0].fact).toBe('Updated text')
      expect(bondMock.senseUpdateFact).toHaveBeenCalledWith('f1', 'Updated text')
    })
  })

  describe('pinFact', () => {
    it('waits for RPC then inserts fact', async () => {
      const created = makeFact({ id: 'new-1', fact: 'New fact' })
      bondMock.senseRemember.mockResolvedValue(created)

      const mem = useMemory()
      await mem.pinFact('New fact')

      expect(mem.facts.value).toHaveLength(1)
      expect(mem.facts.value[0].id).toBe('new-1')
      expect(bondMock.senseRemember).toHaveBeenCalledWith('New fact', undefined)
    })

    it('does not insert on RPC failure', async () => {
      bondMock.senseRemember.mockRejectedValue(new Error('fail'))

      const mem = useMemory()
      await mem.pinFact('New fact')

      expect(mem.facts.value).toHaveLength(0)
    })
  })

  describe('dismissThread', () => {
    it('removes thread optimistically', async () => {
      const mem = useMemory()
      mem.threads.value = [
        makeThread({ debriefId: 'd1', thread: 'Thread A' }),
        makeThread({ debriefId: 'd2', thread: 'Thread B' }),
      ]

      await mem.dismissThread('d1', 'Thread A')

      expect(mem.threads.value).toHaveLength(1)
      expect(mem.threads.value[0].thread).toBe('Thread B')
      expect(bondMock.senseDismissThread).toHaveBeenCalledWith('d1', 'Thread A')
    })

    it('rolls back on RPC failure', async () => {
      bondMock.senseDismissThread.mockRejectedValue(new Error('fail'))

      const mem = useMemory()
      mem.threads.value = [makeThread({ debriefId: 'd1', thread: 'Thread A' })]

      await mem.dismissThread('d1', 'Thread A')

      expect(mem.threads.value).toHaveLength(1)
    })
  })

  describe('removeDecision', () => {
    it('removes decision optimistically', async () => {
      const mem = useMemory()
      mem.decisions.value = [
        makeDecision({ debriefId: 'd1', decision: 'Decision A' }),
        makeDecision({ debriefId: 'd2', decision: 'Decision B' }),
      ]

      await mem.removeDecision('d1', 'Decision A')

      expect(mem.decisions.value).toHaveLength(1)
      expect(mem.decisions.value[0].decision).toBe('Decision B')
      expect(bondMock.senseRemoveDecision).toHaveBeenCalledWith('d1', 'Decision A')
    })
  })

  describe('deleteDebrief', () => {
    it('removes debrief and associated threads/decisions', async () => {
      const mem = useMemory()
      mem.debriefs.value = [makeDebrief({ id: 'd1' }), makeDebrief({ id: 'd2' })]
      mem.threads.value = [makeThread({ debriefId: 'd1' }), makeThread({ debriefId: 'd2' })]
      mem.decisions.value = [makeDecision({ debriefId: 'd1' }), makeDecision({ debriefId: 'd2' })]

      await mem.deleteDebrief('d1')

      expect(mem.debriefs.value).toHaveLength(1)
      expect(mem.debriefs.value[0].id).toBe('d2')
      expect(mem.threads.value).toHaveLength(1)
      expect(mem.threads.value[0].debriefId).toBe('d2')
      expect(mem.decisions.value).toHaveLength(1)
      expect(mem.decisions.value[0].debriefId).toBe('d2')
      expect(bondMock.senseDeleteDebrief).toHaveBeenCalledWith('d1')
    })
  })

  describe('isEmpty', () => {
    it('returns true when all arrays are empty', () => {
      const mem = useMemory()
      expect(mem.isEmpty.value).toBe(true)
    })

    it('returns false when any array has data', () => {
      const mem = useMemory()
      mem.facts.value = [makeFact()]
      expect(mem.isEmpty.value).toBe(false)
    })
  })
})
