import { ref } from 'vue'
import type { ChatThread, ThreadSummary } from '../../shared/threads'

/**
 * Singleton chat-threads metadata state (plans/chat-threads.md). One
 * `thread.listRecent` feeds the Recent threads picker; a lazy per-anchor
 * cache backs each MessageBubble's Discuss/Thread footer without a bulk
 * upfront fetch — most transcript pages have anchors well outside the
 * "recent" window, so a MessageBubble asks for its own on mount instead.
 */

const threadsByAnchor = ref<Map<string, ChatThread>>(new Map())
const recentThreads = ref<ThreadSummary[]>([])
const activeThreadId = ref<string | null>(null)
const loadingRecent = ref(false)

const ACTIVE_THREAD_KEY = 'bond:active-thread-id'

let started = false
let unsubscribe: (() => void) | undefined
const anchorLookupsInFlight = new Set<string>()

function cacheThread(thread: ChatThread) {
  const next = new Map(threadsByAnchor.value)
  next.set(thread.anchorMessageId, thread)
  threadsByAnchor.value = next
}

function uncacheThreadId(threadId: string) {
  for (const [anchor, t] of threadsByAnchor.value) {
    if (t.id === threadId) {
      const next = new Map(threadsByAnchor.value)
      next.delete(anchor)
      threadsByAnchor.value = next
      return
    }
  }
}

function threadForAnchor(anchorMessageId: string): ChatThread | undefined {
  return threadsByAnchor.value.get(anchorMessageId)
}

/** Kicks off a background lookup once per anchor. Call from a MessageBubble on mount; cheap, indexed, and cached. */
async function ensureAnchorChecked(anchorMessageId: string): Promise<void> {
  if (threadsByAnchor.value.has(anchorMessageId) || anchorLookupsInFlight.has(anchorMessageId)) return
  anchorLookupsInFlight.add(anchorMessageId)
  try {
    const thread = await window.bond.getThreadForAnchor(anchorMessageId)
    if (thread) cacheThread(thread)
  } catch { /* stays unresolved — the footer just shows Discuss until retried */ }
  finally {
    anchorLookupsInFlight.delete(anchorMessageId)
  }
}

async function loadRecent(limit?: number): Promise<void> {
  loadingRecent.value = true
  try {
    const { threads } = await window.bond.listRecentThreads(limit)
    recentThreads.value = threads
  } catch { /* stale/empty on failure — the picker just shows what it already had */ }
  finally { loadingRecent.value = false }
}

/** Refreshes any thread we've already cached (e.g. reply counts) — not just the recent list. */
async function refreshCachedThreads(): Promise<void> {
  const ids = [...new Set([...threadsByAnchor.value.values()].map(t => t.id))]
  await Promise.all(ids.map(async id => {
    try {
      const t = await window.bond.getThread(id)
      if (t) cacheThread(t)
    } catch { /* keep the stale cached copy */ }
  }))
}

function persistActiveThreadId() {
  try {
    if (activeThreadId.value) localStorage.setItem(ACTIVE_THREAD_KEY, activeThreadId.value)
    else localStorage.removeItem(ACTIVE_THREAD_KEY)
  } catch { /* best effort */ }
}

/** Idempotent by anchor — reopens the existing thread if one is already there. */
async function openThread(anchorMessageId: string): Promise<ChatThread> {
  const existing = threadForAnchor(anchorMessageId)
  if (existing) {
    activeThreadId.value = existing.id
    persistActiveThreadId()
    return existing
  }
  const thread = await window.bond.createThread(anchorMessageId)
  cacheThread(thread)
  activeThreadId.value = thread.id
  persistActiveThreadId()
  return thread
}

/** For the Recent threads picker and relaunch restore. */
async function openThreadById(threadId: string): Promise<ChatThread | null> {
  const thread = await window.bond.getThread(threadId)
  if (thread) {
    cacheThread(thread)
    activeThreadId.value = thread.id
    persistActiveThreadId()
  }
  return thread
}

function closeActiveThread(): void {
  activeThreadId.value = null
  persistActiveThreadId()
}

/** Only actually deletes a thread that never got a real message. */
async function deleteDraftIfEmpty(threadId: string): Promise<boolean> {
  const result = await window.bond.deleteDraftThread(threadId)
  if (result.ok) uncacheThreadId(threadId)
  return result.ok
}

/** Restore-on-relaunch reads this; the caller confirms the anchor still exists before reopening. */
function lastActiveThreadId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_THREAD_KEY)
  } catch {
    return null
  }
}

function start(): void {
  if (started) return
  started = true
  void loadRecent()
  try {
    unsubscribe = window.bond.onThreadChanged(() => {
      void loadRecent()
      void refreshCachedThreads()
    })
  } catch { /* compatibility test surfaces may not expose events */ }
}

/** Test-only: drop singleton state so each test starts cold. */
export function resetThreadsForTest(): void {
  started = false
  threadsByAnchor.value = new Map()
  recentThreads.value = []
  activeThreadId.value = null
  loadingRecent.value = false
  anchorLookupsInFlight.clear()
  unsubscribe?.()
  unsubscribe = undefined
}

export function useThreads() {
  start()
  return {
    threadsByAnchor,
    recentThreads,
    activeThreadId,
    loadingRecent,
    threadForAnchor,
    ensureAnchorChecked,
    loadRecent,
    openThread,
    openThreadById,
    closeActiveThread,
    deleteDraftIfEmpty,
    lastActiveThreadId,
  }
}
