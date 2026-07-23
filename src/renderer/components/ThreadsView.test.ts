import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ThreadsView from './ThreadsView.vue'
import { resetThreadsForTest } from '../composables/useThreads'
import type { ThreadSummary } from '../../shared/threads'

function makeSummary(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'thread-1',
    anchorMessageId: 'anchor-1',
    title: 'Panel layout jitter',
    status: 'open',
    replyCount: 3,
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

function mockBond(threads: ThreadSummary[]) {
  return {
    listRecentThreads: vi.fn().mockResolvedValue({ threads }),
    getThread: vi.fn().mockResolvedValue(null),
    onThreadChanged: vi.fn().mockReturnValue(vi.fn()),
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('ThreadsView', () => {
  let bond: ReturnType<typeof mockBond>

  beforeEach(() => {
    resetThreadsForTest()
    bond = mockBond([])
    ;(window as unknown as { bond: unknown }).bond = bond
  })

  afterEach(() => {
    resetThreadsForTest()
    delete (window as unknown as { bond?: unknown }).bond
  })

  it('loads recent threads on mount and renders one row per thread with its reply count', async () => {
    bond.listRecentThreads.mockResolvedValue({
      threads: [
        makeSummary({ id: 't1', title: 'First thread', replyCount: 3 }),
        makeSummary({ id: 't2', title: 'Second thread', replyCount: 1 }),
      ],
    })
    const wrapper = mount(ThreadsView)
    await flush()

    expect(bond.listRecentThreads).toHaveBeenCalledWith(50)
    const rows = wrapper.findAll('.threads-panel-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('First thread')
    expect(rows[0]!.text()).toContain('3 messages')
    expect(rows[1]!.text()).toContain('1 message')
  })

  it('shows the empty state when there are no threads', async () => {
    const wrapper = mount(ThreadsView)
    await flush()

    expect(wrapper.text()).toContain('No threads yet')
    expect(wrapper.findAll('.threads-panel-row')).toHaveLength(0)
  })

  it('emits open with the thread id when a row is clicked — the layout decision stays in App.vue', async () => {
    bond.listRecentThreads.mockResolvedValue({ threads: [makeSummary({ id: 't-open' })] })
    const wrapper = mount(ThreadsView)
    await flush()

    await wrapper.find('.threads-panel-row').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['t-open']])
  })

  it('falls back to "Thread" for an untitled thread', async () => {
    bond.listRecentThreads.mockResolvedValue({ threads: [makeSummary({ title: null })] })
    const wrapper = mount(ThreadsView)
    await flush()

    expect(wrapper.find('.threads-panel-row').text()).toContain('Thread')
  })
})
