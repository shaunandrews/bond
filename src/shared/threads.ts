/**
 * Chat threads (plans/chat-threads.md) — a temporary, message-anchored side
 * conversation attached to one completed Bond response. NOT a branch: the
 * main conversation is untouched, and nothing said in a thread flows back
 * into it automatically.
 */

/**
 * Every turn/send/cancel/subscribe and every turn-scoped streamed chunk
 * carries one of these. `null`/absent thread_id in storage means 'main'.
 */
export type ConversationScope =
  | { type: 'main' }
  | { type: 'thread'; threadId: string }

export const MAIN_SCOPE: ConversationScope = { type: 'main' }

export function threadScope(threadId: string): ConversationScope {
  return { type: 'thread', threadId }
}

/** The nullable DB column value a scope maps to — null means main. */
export function scopeToThreadId(scope: ConversationScope | undefined | null): string | null {
  return scope && scope.type === 'thread' ? scope.threadId : null
}

export function threadIdToScope(threadId: string | null | undefined): ConversationScope {
  return threadId ? threadScope(threadId) : MAIN_SCOPE
}

export function scopesEqual(a: ConversationScope, b: ConversationScope): boolean {
  return scopeToThreadId(a) === scopeToThreadId(b)
}

/** Defensive wire-boundary parse (mirrors parseEditMode in shared/session.ts) — anything malformed defaults to main. */
export function parseConversationScope(raw: unknown): ConversationScope {
  if (raw && typeof raw === 'object') {
    const candidate = raw as { type?: unknown; threadId?: unknown }
    if (candidate.type === 'thread' && typeof candidate.threadId === 'string' && candidate.threadId) {
      return { type: 'thread', threadId: candidate.threadId }
    }
    if (candidate.type === 'main') return MAIN_SCOPE
  }
  return MAIN_SCOPE
}

/** A single message carried in a thread's frozen context snapshot. */
export interface ThreadContextMessage {
  id: string
  seq: number
  role: 'user' | 'bond'
  text: string
  imageIds?: string[]
}

export interface ThreadContextSnapshotV1 {
  version: 1
  createdAt: string
  anchorMessageId: string
  anchorSeq: number
  messages: ThreadContextMessage[]
}

export type ThreadStatus = 'draft' | 'open' | 'closed'

export interface ChatThread {
  id: string
  anchorMessageId: string
  contextSnapshot: ThreadContextSnapshotV1
  title?: string | null
  status: ThreadStatus
  replyCount: number
  createdAt: string
  updatedAt: string
  lastReadAt?: string | null
}

export interface ThreadSummary {
  id: string
  anchorMessageId: string
  title?: string | null
  status: ThreadStatus
  replyCount: number
  updatedAt: string
}
