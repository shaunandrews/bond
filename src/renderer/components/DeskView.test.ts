import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DeskView from './DeskView.vue'
import type { DeskBlockDetail, DeskMatcher, DeskStats, DeskStatus, DeskThread } from '../../shared/desk'

function thread(id: string, name: string, over: Partial<DeskThread> = {}): DeskThread {
  return {
    id, name, normalizedName: name.toLowerCase(), colorSeed: id,
    status: 'established', source: 'user', userNote: null, userNoteUpdatedAt: null,
    lastSeenAt: null, archivedAt: null, createdAt: 'x', updatedAt: 'x', ...over,
  }
}

function block(over: Partial<DeskBlockDetail> = {}): DeskBlockDetail {
  const t = thread('t1', 'Studio sync dialog')
  return {
    id: 'b1', threadId: t.id, startedAt: '2026-07-20T09:00:00.000Z', endedAt: null,
    presenceSeconds: 4800, state: 'committed', summary: null, reentryNote: null,
    noteStatus: 'none', confidence: 0.9, source: 'inferred',
    createdAt: 'x', updatedAt: 'x', thread: t, ...over,
  }
}

function matcher(over: Partial<DeskMatcher> = {}): DeskMatcher {
  return {
    id: 'm1', threadId: 't1', field: 'title', operator: 'prefix',
    pattern: 'Studio — Sync', normalizedPattern: 'studio — sync', confirmed: true,
    source: 'user', confidence: 1, specificity: 213, example: {}, enabled: true,
    hits: 12, lastSeenAt: null, exampleUpdatedAt: null, createdAt: 'x', updatedAt: 'x', ...over,
  }
}

const STATUS: DeskStatus = {
  running: true, senseState: 'recording', senseEnabled: true, currentBlock: null,
  presenceSeconds: 0, pendingQuestion: null, lastAssertionAt: null,
  backfilling: false, unresolvedSegments: 0,
}

const STATS: DeskStats = {
  windowHours: 24, modelCalls: 4, failedCalls: 0, immediateCalls: 0, sweptCalls: 4,
  segmentsInferred: 20, promptChars: 4000, avgLatencyMs: 800, cacheHitRate: 0.82,
  segmentsResolvedByMatcher: 82, segmentsResolvedByModel: 18, unresolvedSegments: 0,
  medianUnknownLatencySeconds: 40, blocks: 6, threads: 3, matchers: 9, confirmedMatchers: 2,
}

/** onDeskChanged keeps its own signature so the reload test can invoke it. */
const onDeskChanged = vi.fn<(fn: () => void) => () => void>(() => () => {})

const bond = {
  deskStatus: vi.fn(),
  deskBlocks: vi.fn(),
  deskThreads: vi.fn(),
  deskMatchers: vi.fn(),
  deskStats: vi.fn(),
  deskCreateThread: vi.fn(),
  deskRenameThread: vi.fn(),
  deskArchiveThread: vi.fn(),
  deskMergeThreads: vi.fn(),
  deskUpdateNote: vi.fn(),
  deskDisableMatcher: vi.fn(),
  deskDeleteMatcher: vi.fn(),
  onDeskChanged,
}

async function render(over: {
  blocks?: DeskBlockDetail[]
  threads?: DeskThread[]
  matchers?: DeskMatcher[]
  status?: DeskStatus
} = {}) {
  bond.deskStatus.mockResolvedValue(over.status ?? STATUS)
  bond.deskBlocks.mockResolvedValue(over.blocks ?? [])
  bond.deskThreads.mockResolvedValue(over.threads ?? [])
  bond.deskMatchers.mockResolvedValue(over.matchers ?? [])
  bond.deskStats.mockResolvedValue(STATS)
  const wrapper = mount(DeskView)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  onDeskChanged.mockImplementation(() => () => {})
  ;(window as unknown as { bond: typeof bond }).bond = bond
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() }) as never
})

describe('DeskView — Day', () => {
  it('says so when nothing was observed', async () => {
    const wrapper = await render()
    expect(wrapper.text()).toContain('Nothing observed today yet')
  })

  it('lists blocks with an approximate duration', async () => {
    const wrapper = await render({ blocks: [block()] })
    expect(wrapper.text()).toContain('Studio sync dialog')
    expect(wrapper.text()).toContain('~1h 20m')
  })

  it('shows a re-entry note and offers to add one when missing', async () => {
    const withNote = await render({ blocks: [block({ reentryNote: 'Conflict copy unwritten' })] })
    expect(withNote.text()).toContain('Conflict copy unwritten')

    const without = await render({ blocks: [block()] })
    expect(without.text()).toContain('Add a re-entry note')
  })

  it('saves an edited note', async () => {
    const wrapper = await render({ blocks: [block()] })
    await wrapper.find('.desk-block-note').trigger('click')
    await wrapper.findComponent({ name: 'BondInput' }).vm.$emit('update:modelValue', 'Left mid-refactor')
    await wrapper.find('.desk-block-note-edit button').trigger('click')
    expect(bond.deskUpdateNote).toHaveBeenCalledWith('b1', 'Left mid-refactor')
  })

  it('skips blocks with no thread', async () => {
    const wrapper = await render({ blocks: [block({ thread: null, threadId: null })] })
    expect(wrapper.findAll('.desk-block')).toHaveLength(0)
  })

  it('says plainly when Sense is off', async () => {
    const wrapper = await render({ status: { ...STATUS, senseEnabled: false } })
    expect(wrapper.text()).toContain('Sense is off')
  })

  it('grades nothing — no score, streak, target, or comparison', async () => {
    const wrapper = await render({ blocks: [block({ reentryNote: 'mid-refactor' })] })
    expect(wrapper.text().toLowerCase()).not.toMatch(/score|streak|goal|target|yesterday|productiv/)
  })
})

describe('DeskView — Threads', () => {
  async function threadsTab(over: Parameters<typeof render>[0] = {}) {
    const wrapper = await render(over)
    await wrapper.findComponent({ name: 'BondTab' }).vm.$emit('update:modelValue', 'threads')
    await flushPromises()
    return wrapper
  }

  it('creates a thread', async () => {
    const wrapper = await threadsTab()
    await wrapper.findComponent({ name: 'BondInput' }).vm.$emit('update:modelValue', 'ISP problem')
    await wrapper.find('.desk-new-thread button').trigger('click')
    expect(bond.deskCreateThread).toHaveBeenCalledWith('ISP problem')
  })

  it('will not create an empty thread', async () => {
    const wrapper = await threadsTab()
    expect(wrapper.find('.desk-new-thread button').attributes('disabled')).toBeDefined()
  })

  it('renames a thread', async () => {
    const wrapper = await threadsTab({ threads: [thread('t1', 'Old name')] })
    const buttons = wrapper.findAll('.desk-thread-actions button')
    await buttons[0].trigger('click')
    const inputs = wrapper.findAllComponents({ name: 'BondInput' })
    await inputs[inputs.length - 1].vm.$emit('update:modelValue', 'New name')
    await inputs[inputs.length - 1].vm.$emit('blur')
    expect(bond.deskRenameThread).toHaveBeenCalledWith('t1', 'New name')
  })

  it('archives and restores', async () => {
    const wrapper = await threadsTab({ threads: [thread('t1', 'Studio')] })
    await wrapper.findAll('.desk-thread-actions button')[2].trigger('click')
    expect(bond.deskArchiveThread).toHaveBeenCalledWith('t1', true)

    const archived = await threadsTab({ threads: [thread('t2', 'Old', { status: 'archived' })] })
    expect(archived.text()).toContain('Archived')
    await archived.find('.desk-thread.is-archived button').trigger('click')
    expect(bond.deskArchiveThread).toHaveBeenCalledWith('t2', false)
  })

  it('merging takes two deliberate steps', async () => {
    const wrapper = await threadsTab({
      threads: [thread('t1', 'Studio sync'), thread('t2', 'Sync dialog')],
    })
    // Opening the picker alone does nothing
    await wrapper.findAll('.desk-thread-actions button')[1].trigger('click')
    expect(bond.deskMergeThreads).not.toHaveBeenCalled()

    await wrapper.findComponent({ name: 'BondSelect' }).vm.$emit('update:modelValue', 't2')
    // BondSelect renders its own trigger button, so pick the one that says Merge.
    const merge = wrapper.findAll('.desk-merge button').find(b => b.text() === 'Merge')!
    await merge.trigger('click')
    expect(bond.deskMergeThreads).toHaveBeenCalledWith('t2', 't1')
  })

  it('never offers to merge a thread into itself', async () => {
    const wrapper = await threadsTab({
      threads: [thread('t1', 'Studio sync'), thread('t2', 'Sync dialog')],
    })
    await wrapper.findAll('.desk-thread-actions button')[1].trigger('click')
    const options = wrapper.findComponent({ name: 'BondSelect' }).props('options') as { value: string }[]
    expect(options.map(o => o.value)).toEqual(['t2'])
  })
})

describe('DeskView — Rules', () => {
  async function rulesTab(matchers: DeskMatcher[]) {
    const wrapper = await render({ matchers, threads: [thread('t1', 'Studio sync dialog')] })
    await wrapper.findComponent({ name: 'BondTab' }).vm.$emit('update:modelValue', 'rules')
    await flushPromises()
    return wrapper
  }

  it('says so when there are none', async () => {
    expect((await rulesTab([])).text()).toContain('No rules yet')
  })

  it('describes a rule in plain words with its example', async () => {
    const wrapper = await rulesTab([matcher({ example: { titles: ['Studio — Sync Dialog'] } })])
    expect(wrapper.text()).toContain('windows titled "Studio — Sync"')
    expect(wrapper.text()).toContain('Studio sync dialog')
    expect(wrapper.text()).toContain('confirmed')
    expect(wrapper.text()).toContain('Studio — Sync Dialog')
  })

  it('distinguishes an inferred guess from a confirmed rule', async () => {
    expect((await rulesTab([matcher({ confirmed: false })])).text()).toContain('inferred')
  })

  it('disables a rule', async () => {
    const wrapper = await rulesTab([matcher()])
    await wrapper.findAll('.desk-rule button')[0].trigger('click')
    expect(bond.deskDisableMatcher).toHaveBeenCalledWith('m1')
  })

  it('deleting takes two clicks', async () => {
    const wrapper = await rulesTab([matcher()])
    const del = wrapper.findAll('.desk-rule button')[1]
    await del.trigger('click')
    expect(bond.deskDeleteMatcher).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Really delete?')

    await wrapper.findAll('.desk-rule button')[1].trigger('click')
    expect(bond.deskDeleteMatcher).toHaveBeenCalledWith('m1')
  })

  it('offers no disable button for an already-disabled rule', async () => {
    const wrapper = await rulesTab([matcher({ enabled: false })])
    expect(wrapper.findAll('.desk-rule button')).toHaveLength(1)
  })
})

describe('DeskView — live updates', () => {
  it('reloads when the daemon broadcasts a change', async () => {
    await render()
    expect(bond.onDeskChanged).toHaveBeenCalled()

    bond.deskBlocks.mockResolvedValue([block()])
    onDeskChanged.mock.calls[0][0]()
    await flushPromises()
    expect(bond.deskBlocks).toHaveBeenCalledTimes(2)
  })
})
