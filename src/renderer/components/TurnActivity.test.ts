import { describe, expect, it, vi } from 'vitest'
import { nextTick, type ComponentPublicInstance } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import TurnActivity from './TurnActivity.vue'
import type { TurnActivityData } from '../types/activity'

// Same workaround as MarkdownMessage.test.ts: VTU's mount return type
// collapses SFC prop types under this toolchain, so pin the instance type to
// keep setProps() type-safe.
type ActivityWrapper = VueWrapper<unknown, ComponentPublicInstance<{ data: TurnActivityData }>>

function mountActivity(data: TurnActivityData): ActivityWrapper {
  return mount(TurnActivity, { props: { data } }) as unknown as ActivityWrapper
}

function activity(overrides: Partial<TurnActivityData> = {}): TurnActivityData {
  const now = Date.now()
  return {
    turnId: 'turn-1',
    status: 'done',
    startedAt: now - 3000,
    endedAt: now,
    events: [
      { id: 'think-1', type: 'thinking', label: 'Thinking', ts: now - 2900, endTs: now - 2000, text: 'Reasoning text' },
      { id: 'tool-1', type: 'tool', label: 'Read file.ts', ts: now - 1900, endTs: now - 500, toolName: 'Read', toolUseId: 'call-1', input: { path: 'file.ts' }, output: 'contents' },
    ],
    ...overrides,
  }
}

describe('TurnActivity', () => {
  it('renders a compact completed summary', () => {
    const wrapper = mount(TurnActivity, { props: { data: activity() } })
    expect(wrapper.text()).toContain('Thought for 3s')
    expect(wrapper.text()).toContain('Used 1 tool')
  })

  it('expands chronological details with thinking and tool previews', async () => {
    const wrapper = mount(TurnActivity, { props: { data: activity() } })
    await wrapper.find('.activity-compact').trigger('click')
    expect(wrapper.text()).toContain('Thinking')
    expect(wrapper.text()).toContain('Read file.ts')

    await wrapper.findAll('.event-row')[0].trigger('click')
    expect(wrapper.text()).toContain('Reasoning text')

    await wrapper.findAll('.event-row')[1].trigger('click')
    expect(wrapper.text()).toContain('file.ts')
    expect(wrapper.text()).toContain('contents')
  })

  it('offers a short tool output preview with a full reveal', async () => {
    const output = 'x'.repeat(900)
    const wrapper = mount(TurnActivity, { props: { data: activity({ events: [
      { id: 'tool-1', type: 'tool', label: 'Ran command', ts: Date.now() - 1000, endTs: Date.now(), toolName: 'Bash', output },
    ] }) } })

    await wrapper.find('.activity-compact').trigger('click')
    await wrapper.find('.event-row').trigger('click')
    expect(wrapper.find('pre').text().length).toBeLessThan(output.length)
    await wrapper.find('.detail-toggle').trigger('click')
    expect(wrapper.find('pre').text()).toBe(output)
  })

  it('auto-expands failures', () => {
    const wrapper = mount(TurnActivity, { props: { data: activity({ status: 'failed', expanded: true, events: [
      { id: 'err-1', type: 'error', label: 'Error', ts: Date.now(), text: 'boom' },
    ] }) } })
    expect(wrapper.text()).toContain('Failed')
    expect(wrapper.text()).toContain('Error')
  })

  it('keeps the elapsed counter ticking while active even when no chunks arrive', async () => {
    vi.useFakeTimers()
    try {
      const data = activity({ status: 'working', startedAt: Date.now(), endedAt: undefined, events: [] })
      const wrapper = mount(TurnActivity, { props: { data } })
      expect(wrapper.text()).toContain('Working')

      vi.advanceTimersByTime(45_000)
      await nextTick()
      expect(wrapper.text()).toContain('45s')

      vi.advanceTimersByTime(30_000)
      await nextTick()
      expect(wrapper.text()).toContain('1m 15s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates no timer for completed rows', () => {
    // A transcript page renders dozens of finished activity rows; none of
    // them should keep an interval alive.
    vi.useFakeTimers()
    try {
      mount(TurnActivity, { props: { data: activity({ status: 'done', startedAt: 1000, endedAt: 2000, events: [] }) } })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the timer when a live row completes', async () => {
    vi.useFakeTimers()
    try {
      const data = activity({ status: 'working', startedAt: Date.now(), endedAt: undefined, events: [] })
      const wrapper = mountActivity(data)
      expect(vi.getTimerCount()).toBe(1)

      await wrapper.setProps({ data: { ...data, status: 'done', endedAt: Date.now() } })
      await nextTick()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits approvals from approval events', async () => {
    const wrapper = mount(TurnActivity, { props: { data: activity({ status: 'awaiting_approval', expanded: true, events: [
      { id: 'approval-1', type: 'approval', label: 'Approval requested: Bash', ts: Date.now(), requestId: 'req-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'pending' },
    ] }) } })
    await wrapper.find('.event-row').trigger('click')
    await wrapper.find('.approval-actions button').trigger('click')
    expect(wrapper.emitted('approve')?.[0]).toEqual(['req-1', true])
  })

  it('renders a pending question read-only, with no action buttons', async () => {
    const wrapper = mount(TurnActivity, { props: { data: activity({ status: 'awaiting_question', expanded: true, events: [
      { id: 'q-1', type: 'question', label: 'Question asked', ts: Date.now(), questionId: 'q-1', question: 'Which approach?', options: [
        { id: 'q-1:0', number: 1, label: 'Balanced', description: 'Middle ground' },
      ], status: 'pending' },
    ] }) } })
    expect(wrapper.text()).toContain('Question pending')
    await wrapper.find('.event-row').trigger('click')
    expect(wrapper.text()).toContain('1. Balanced')
    expect(wrapper.text()).toContain('Waiting for an answer')
    expect(wrapper.find('.approval-actions').exists()).toBe(false)
  })

  it('renders an answered question with the chosen option', async () => {
    const wrapper = mount(TurnActivity, { props: { data: activity({ status: 'working', expanded: true, events: [
      { id: 'q-2', type: 'question', label: 'Question asked', ts: Date.now(), endTs: Date.now(), questionId: 'q-2', question: 'Which?', options: [
        { id: 'q-2:0', number: 1, label: 'Balanced', description: 'Middle ground' },
      ], status: 'answered', answer: { kind: 'option', optionId: 'q-2:0', label: 'Balanced', number: 1 } },
    ] }) } })
    await wrapper.find('.event-row').trigger('click')
    expect(wrapper.text()).toContain('✓ 1. Balanced')
  })

  it('renders a cancelled question as dismissed', async () => {
    const wrapper = mount(TurnActivity, { props: { data: activity({ status: 'working', expanded: true, events: [
      { id: 'q-3', type: 'question', label: 'Question asked', ts: Date.now(), endTs: Date.now(), questionId: 'q-3', question: 'Which?', options: [], status: 'cancelled' },
    ] }) } })
    await wrapper.find('.event-row').trigger('click')
    expect(wrapper.text()).toContain('Dismissed')
  })
})
