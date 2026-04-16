import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MemoryView from './MemoryView.vue'
import { useMemory } from '../composables/useMemory'
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
    decision: 'Used TypeScript', debriefId: 'd1', sessionTitle: 'Test Session',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

/** Set up bond mock that returns the given data from loadMemory */
function setupBondMock(data?: {
  facts?: SenseFact[]
  debriefs?: SessionDebrief[]
  threads?: OpenThread[]
  decisions?: DecisionWithContext[]
}) {
  const mock = {
    senseMemory: vi.fn().mockResolvedValue({
      debriefs: data?.debriefs ?? [],
      facts: data?.facts ?? [],
    }),
    senseThreads: vi.fn().mockResolvedValue(data?.threads ?? []),
    senseDecisions: vi.fn().mockResolvedValue(data?.decisions ?? []),
    senseForget: vi.fn().mockResolvedValue({ ok: true }),
    senseRemember: vi.fn().mockResolvedValue(makeFact()),
    senseUpdateFact: vi.fn().mockResolvedValue(makeFact()),
    senseDeleteDebrief: vi.fn().mockResolvedValue({ ok: true }),
    senseDismissThread: vi.fn().mockResolvedValue({ ok: true }),
    senseRemoveDecision: vi.fn().mockResolvedValue({ ok: true }),
    senseSystemPromptPreview: vi.fn().mockResolvedValue({ prompt: 'Test system prompt' }),
  }
  ;(globalThis as any).window = { bond: mock }
  return mock
}

describe('MemoryView', () => {
  beforeEach(() => {
    // Reset singleton state
    const mem = useMemory()
    mem.facts.value = []
    mem.threads.value = []
    mem.decisions.value = []
    mem.debriefs.value = []
  })

  it('shows empty state when no data', async () => {
    setupBondMock()
    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(wrapper.text()).toContain('No memories yet')
  })

  it('renders all four sections with data', async () => {
    setupBondMock({
      facts: [makeFact()],
      threads: [makeThread()],
      decisions: [makeDecision()],
      debriefs: [makeDebrief()],
    })

    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(wrapper.text()).toContain('Pinned Facts')
    expect(wrapper.text()).toContain('Open Threads')
    expect(wrapper.text()).toContain('Recent Decisions')
    expect(wrapper.text()).toContain('Session Debriefs')
  })

  it('renders fact card with fact text', async () => {
    setupBondMock({ facts: [makeFact({ fact: 'Remember this important thing' })] })

    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(wrapper.text()).toContain('Remember this important thing')
  })

  it('renders thread card with session context', async () => {
    setupBondMock({
      threads: [makeThread({ thread: 'Fix the bug', sessionTitle: 'Debug Session' })],
    })

    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(wrapper.text()).toContain('Fix the bug')
    expect(wrapper.text()).toContain('Debug Session')
    expect(wrapper.text()).toContain('Resume')
  })

  it('renders debrief card with summary preview and topics', async () => {
    setupBondMock({
      debriefs: [makeDebrief({
        sessionTitle: 'Planning Session',
        summary: 'We planned the next sprint',
        topics: ['sprint', 'planning'],
      })],
    })

    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(wrapper.text()).toContain('Planning Session')
    expect(wrapper.text()).toContain('We planned the next sprint')
    expect(wrapper.text()).toContain('sprint')
    expect(wrapper.text()).toContain('planning')
  })

  it('renders decision items', async () => {
    setupBondMock({
      decisions: [makeDecision({ decision: 'Chose Vue over React', sessionTitle: 'Architecture' })],
    })

    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(wrapper.text()).toContain('Chose Vue over React')
    expect(wrapper.text()).toContain('Architecture')
  })

  it('hides sections when filter is active', async () => {
    setupBondMock({
      facts: [makeFact()],
      threads: [makeThread()],
      decisions: [makeDecision()],
      debriefs: [makeDebrief()],
    })

    const wrapper = mount(MemoryView)
    await flushPromises()

    // All sections visible initially
    expect(wrapper.text()).toContain('Pinned Facts')
    expect(wrapper.text()).toContain('Open Threads')

    // Click the "Facts" tab button
    const factsBtn = wrapper.findAll('.bond-tab').find(el => el.text() === 'Facts')
    factsBtn?.element.click()
    await flushPromises()

    expect(wrapper.text()).toContain('Pinned Facts')
    expect(wrapper.text()).not.toContain('Open Threads')
    expect(wrapper.text()).not.toContain('Recent Decisions')
  })

  it('loads memory on mount when empty', async () => {
    const bondMock = setupBondMock()
    mount(MemoryView)
    await flushPromises()

    expect(bondMock.senseMemory).toHaveBeenCalled()
    expect(bondMock.senseThreads).toHaveBeenCalled()
    expect(bondMock.senseDecisions).toHaveBeenCalled()
  })
})
