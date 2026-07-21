import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DeskInFlight from './DeskInFlight.vue'
import type { DeskBlockDetail, DeskThread } from '../../shared/desk'

function thread(id: string, name: string): DeskThread {
  return {
    id, name, normalizedName: name.toLowerCase(), colorSeed: id,
    status: 'established', source: 'user', userNote: null, userNoteUpdatedAt: null,
    lastSeenAt: null, archivedAt: null, createdAt: 'x', updatedAt: 'x',
  }
}

function block(over: Partial<DeskBlockDetail> = {}): DeskBlockDetail {
  const t = thread('t1', 'Studio sync dialog')
  return {
    id: 'b1', threadId: t.id, startedAt: 'x', endedAt: null, presenceSeconds: 4800,
    state: 'committed', summary: null, reentryNote: null, noteStatus: 'none',
    confidence: 0.9, source: 'inferred', createdAt: 'x', updatedAt: 'x',
    thread: t, ...over,
  }
}

const THREADS = [thread('t1', 'Studio sync dialog'), thread('t2', 'ISP problem')]

describe('DeskInFlight', () => {
  it('says so when nothing has been observed', () => {
    const wrapper = mount(DeskInFlight, { props: { blocks: [], threads: THREADS } })
    expect(wrapper.text()).toContain('Nothing observed yet')
  })

  it('leads with the thread name and an approximate time', () => {
    const wrapper = mount(DeskInFlight, { props: { blocks: [block()], threads: THREADS } })
    expect(wrapper.text()).toContain('Studio sync dialog')
    expect(wrapper.text()).toContain('~1h 20m')
  })

  it('never shows a precise duration', () => {
    const wrapper = mount(DeskInFlight, {
      props: { blocks: [block({ presenceSeconds: 4983 })], threads: THREADS },
    })
    expect(wrapper.text()).toContain('~')
    expect(wrapper.text()).not.toContain('83m')
  })

  it('shows the re-entry note, which is the point of the row', () => {
    const wrapper = mount(DeskInFlight, {
      props: { blocks: [block({ reentryNote: 'Conflict-state copy unwritten' })], threads: THREADS },
    })
    expect(wrapper.text()).toContain('Conflict-state copy unwritten')
  })

  it('marks a note that is still being written', () => {
    const wrapper = mount(DeskInFlight, {
      props: { blocks: [block({ noteStatus: 'pending' })], threads: THREADS },
    })
    expect(wrapper.text()).toContain('writing a note')
  })

  it('shows no score, streak, percentage, or comparison', () => {
    const wrapper = mount(DeskInFlight, {
      props: { blocks: [block({ reentryNote: 'mid-refactor' })], threads: THREADS },
    })
    expect(wrapper.text().toLowerCase()).not.toMatch(/score|streak|%|yesterday|goal|productiv/)
  })

  it('skips a block with no thread rather than rendering a blank row', () => {
    const wrapper = mount(DeskInFlight, {
      props: { blocks: [block({ thread: null, threadId: null })], threads: THREADS },
    })
    expect(wrapper.findAll('.desk-row')).toHaveLength(0)
  })

  it('opens and closes the picker on the same row', async () => {
    const wrapper = mount(DeskInFlight, { props: { blocks: [block()], threads: THREADS } })
    await wrapper.find('.desk-row-main').trigger('click')
    expect(wrapper.emitted('openPicker')![0]).toEqual(['b1'])

    await wrapper.setProps({ reassigning: 'b1' })
    await wrapper.find('.desk-row-main').trigger('click')
    expect(wrapper.emitted('openPicker')![1]).toEqual([null])
  })

  it('offers every thread except the one the block is already on', async () => {
    const wrapper = mount(DeskInFlight, {
      props: { blocks: [block()], threads: THREADS, reassigning: 'b1' },
    })
    const options = wrapper.findAll('.desk-picker-option')
    expect(options).toHaveLength(1)
    expect(options[0].text()).toContain('ISP problem')
  })

  it('emits the reassignment', async () => {
    const wrapper = mount(DeskInFlight, {
      props: { blocks: [block()], threads: THREADS, reassigning: 'b1' },
    })
    await wrapper.find('.desk-picker-option').trigger('click')
    expect(wrapper.emitted('reassign')![0]).toEqual(['b1', 't2'])
  })

  it('says so when there is nowhere else to move a block', () => {
    const wrapper = mount(DeskInFlight, {
      props: { blocks: [block()], threads: [THREADS[0]], reassigning: 'b1' },
    })
    expect(wrapper.text()).toContain('No other threads yet')
  })

  it('disables rows while a write is in flight', () => {
    const wrapper = mount(DeskInFlight, {
      props: { blocks: [block()], threads: THREADS, busy: true },
    })
    expect(wrapper.find('.desk-row-main').attributes('disabled')).toBeDefined()
  })
})
