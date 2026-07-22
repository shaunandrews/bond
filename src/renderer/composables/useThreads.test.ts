import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useThreads, resetThreadsForTest } from './useThreads'
import type { ChatThread, ThreadSummary } from '../../shared/threads'

function makeThread(over: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    anchorMessageId: 'anchor-1',
    contextSnapshot: { version: 1, createdAt: '2026-01-01T00:00:00.000Z', anchorMessageId: 'anchor-1', anchorSeq: 1, messages: [] },
    status: 'draft',
    replyCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

interface MockBond {
  listRecentThreads: ReturnType<typeof vi.fn>
  getThreadForAnchor: ReturnType<typeof vi.fn>
  getThread: ReturnType<typeof vi.fn>
  createThread: ReturnType<typeof vi.fn>
  deleteDraftThread: ReturnType<typeof vi.fn>
  onThreadChanged: (fn: () => void) => () => void
}

let bond: MockBond
let changeListeners: Array<() => void>

beforeEach(() => {
  resetThreadsForTest()
  localStorage.clear()
  changeListeners = []
  bond = {
    listRecentThreads: vi.fn().mockResolvedValue({ threads: [] as ThreadSummary[] }),
    getThreadForAnchor: vi.fn().mockResolvedValue(null),
    getThread: vi.fn().mockResolvedValue(null),
    createThread: vi.fn(),
    deleteDraftThread: vi.fn().mockResolvedValue({ ok: false }),
    onThreadChanged: (fn: () => void) => {
      changeListeners.push(fn)
      return () => { changeListeners = changeListeners.filter(l => l !== fn) }
    },
  }
  ;(window as unknown as { bond: unknown }).bond = bond
})

afterEach(() => {
  resetThreadsForTest()
  delete (window as unknown as { bond?: unknown }).bond
  localStorage.clear()
})

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('useThreads', () => {
  it('loads recent threads once on first use (singleton)', async () => {
    bond.listRecentThreads.mockResolvedValue({ threads: [{ id: 't1', anchorMessageId: 'a1', status: 'open', replyCount: 2, updatedAt: '2026-01-01' }] })
    useThreads()
    useThreads()
    await flush()

    expect(bond.listRecentThreads).toHaveBeenCalledTimes(1)
    const { recentThreads } = useThreads()
    expect(recentThreads.value).toHaveLength(1)
  })

  it('ensureAnchorChecked looks up an anchor once and caches the result', async () => {
    const thread = makeThread()
    bond.getThreadForAnchor.mockResolvedValue(thread)
    const { ensureAnchorChecked, threadForAnchor } = useThreads()

    await ensureAnchorChecked('anchor-1')
    await ensureAnchorChecked('anchor-1')
    await flush()

    expect(bond.getThreadForAnchor).toHaveBeenCalledTimes(1)
    expect(threadForAnchor('anchor-1')?.id).toBe('thread-1')
  })

  it('does not look up an anchor already in the cache', async () => {
    bond.getThreadForAnchor.mockResolvedValue(makeThread())
    const { ensureAnchorChecked } = useThreads()
    await ensureAnchorChecked('anchor-1')
    await ensureAnchorChecked('anchor-1')
    expect(bond.getThreadForAnchor).toHaveBeenCalledTimes(1)
  })

  it('openThread creates a new thread and sets it active, persisting to localStorage', async () => {
    const thread = makeThread()
    bond.createThread.mockResolvedValue(thread)
    const { openThread, activeThreadId } = useThreads()

    const result = await openThread('anchor-1')
    expect(result?.id).toBe('thread-1')
    expect(activeThreadId.value).toBe('thread-1')
    expect(localStorage.getItem('bond:active-thread-id')).toBe('thread-1')
  })

  // plans/chat-threads.md Failure behavior: "If thread.create fails, leave
  // the main UI unchanged and show a non-destructive inline error near the action."
  it('a failed thread.create leaves activeThreadId untouched and records a per-anchor error instead of throwing', async () => {
    bond.createThread.mockRejectedValue(new Error('network error'))
    const { openThread, activeThreadId, createErrorFor } = useThreads()

    const result = await openThread('anchor-1')
    expect(result).toBeNull()
    expect(activeThreadId.value).toBeNull()
    expect(localStorage.getItem('bond:active-thread-id')).toBeNull()
    expect(createErrorFor('anchor-1')).toBeTruthy()
  })

  it('a later successful openThread for the same anchor clears its earlier create error', async () => {
    bond.createThread.mockRejectedValueOnce(new Error('network error'))
    const { openThread, createErrorFor } = useThreads()

    await openThread('anchor-1')
    expect(createErrorFor('anchor-1')).toBeTruthy()

    bond.createThread.mockResolvedValue(makeThread())
    await openThread('anchor-1')
    expect(createErrorFor('anchor-1')).toBeUndefined()
  })

  it('openThread is idempotent by anchor — reopens the cached thread without calling createThread again', async () => {
    const thread = makeThread()
    bond.createThread.mockResolvedValue(thread)
    const { openThread } = useThreads()

    await openThread('anchor-1')
    await openThread('anchor-1')
    expect(bond.createThread).toHaveBeenCalledTimes(1)
  })

  it('closeActiveThread clears the active id and its localStorage persistence', async () => {
    bond.createThread.mockResolvedValue(makeThread())
    const { openThread, closeActiveThread, activeThreadId } = useThreads()
    await openThread('anchor-1')
    expect(activeThreadId.value).toBe('thread-1')

    closeActiveThread()
    expect(activeThreadId.value).toBeNull()
    expect(localStorage.getItem('bond:active-thread-id')).toBeNull()
  })

  it('deleteDraftIfEmpty removes the thread from the cache only when the daemon actually deleted it', async () => {
    const thread = makeThread()
    bond.createThread.mockResolvedValue(thread)
    bond.deleteDraftThread.mockResolvedValue({ ok: false })
    const { openThread, deleteDraftIfEmpty, threadForAnchor } = useThreads()
    await openThread('anchor-1')

    expect(await deleteDraftIfEmpty('thread-1')).toBe(false)
    expect(threadForAnchor('anchor-1')).toBeDefined()

    bond.deleteDraftThread.mockResolvedValue({ ok: true })
    expect(await deleteDraftIfEmpty('thread-1')).toBe(true)
    expect(threadForAnchor('anchor-1')).toBeUndefined()
  })

  it('lastActiveThreadId reads the persisted id for relaunch restore', async () => {
    bond.createThread.mockResolvedValue(makeThread())
    const { openThread, lastActiveThreadId } = useThreads()
    expect(lastActiveThreadId()).toBeNull()
    await openThread('anchor-1')
    expect(lastActiveThreadId()).toBe('thread-1')
  })

  it('refreshes recent threads and cached threads on thread.changed', async () => {
    const { ensureAnchorChecked, threadForAnchor } = useThreads()
    bond.getThreadForAnchor.mockResolvedValue(makeThread({ replyCount: 0 }))
    await ensureAnchorChecked('anchor-1')
    await flush()
    expect(threadForAnchor('anchor-1')?.replyCount).toBe(0)

    bond.getThread.mockResolvedValue(makeThread({ replyCount: 3, status: 'open' }))
    changeListeners.forEach(fn => fn())
    await flush()

    expect(bond.getThread).toHaveBeenCalledWith('thread-1')
    expect(threadForAnchor('anchor-1')?.replyCount).toBe(3)
  })
})
