/**
 * Thread merge — one transaction, explicit collision resolution.
 *
 * Merging re-points blocks, segment attribution snapshots, matchers, pending
 * candidates, suppressions, and todo links, then removes the losing thread.
 *
 * **Exactly one of those re-points can collide.** `desk_suppressions` is keyed
 * `PRIMARY KEY(resource_signature, thread_id)`, so two threads that both
 * rejected the same signature collide when one is re-pointed onto the other.
 * The resolution is a real decision, not a tie-break: take `max(count)`, the
 * later `suppress_until`, and `permanent = a OR b`. Suppression is negative
 * evidence and a merge must never *weaken* it — the wrong resolution silently
 * re-enables a suggestion the user rejected three times.
 *
 * `desk_matchers` cannot collide. Its `UNIQUE(field, operator,
 * normalized_pattern)` deliberately excludes `thread_id`, so a pattern has
 * exactly one row pointing at exactly one thread — which is the same invariant
 * the authority matrix relies on when it refuses to let inference steal a
 * pattern already claimed by another thread. Re-pointing matchers is therefore
 * a plain `UPDATE`, and a fold here would be unreachable code guarding a state
 * the schema cannot represent.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import { getThread } from './store'
import type { DeskThread } from '../../shared/desk'

export interface MergeResult {
  thread: DeskThread
  movedBlocks: number
  movedSegments: number
  movedMatchers: number
  mergedSuppressions: number
  movedTodoLinks: number
}

/**
 * Merge `sourceId` into `targetId`. Returns null if either thread is missing
 * or they are the same thread.
 */
export function mergeThreads(
  targetId: string,
  sourceId: string,
  db: Database.Database = getDb()
): MergeResult | null {
  if (targetId === sourceId) return null
  const target = getThread(targetId, db)
  const source = getThread(sourceId, db)
  if (!target || !source) return null

  const run = db.transaction((): MergeResult => {
    const now = new Date().toISOString()

    // --- suppressions: fold colliding pairs, never weakening them ---
    const colliding = db.prepare(`
      SELECT s.resource_signature, s.rejection_count, s.suppress_until, s.permanent
      FROM desk_suppressions s
      WHERE s.thread_id = ?
        AND EXISTS (SELECT 1 FROM desk_suppressions t WHERE t.thread_id = ? AND t.resource_signature = s.resource_signature)
    `).all(sourceId, targetId) as {
      resource_signature: string
      rejection_count: number
      suppress_until: string | null
      permanent: number
    }[]

    for (const row of colliding) {
      db.prepare(`
        UPDATE desk_suppressions
        SET rejection_count = MAX(rejection_count, ?),
            suppress_until = CASE
              WHEN suppress_until IS NULL THEN ?
              WHEN ? IS NULL THEN suppress_until
              WHEN ? > suppress_until THEN ?
              ELSE suppress_until END,
            permanent = MAX(permanent, ?),
            updated_at = ?
        WHERE thread_id = ? AND resource_signature = ?
      `).run(
        row.rejection_count,
        row.suppress_until, row.suppress_until, row.suppress_until, row.suppress_until,
        row.permanent, now, targetId, row.resource_signature
      )
    }
    db.prepare('DELETE FROM desk_suppressions WHERE thread_id = ? AND resource_signature IN (SELECT resource_signature FROM desk_suppressions WHERE thread_id = ?)')
      .run(sourceId, targetId)
    const mergedSuppressions = colliding.length
    db.prepare('UPDATE desk_suppressions SET thread_id = ?, updated_at = ? WHERE thread_id = ?')
      .run(targetId, now, sourceId)

    // --- matchers: a plain re-point; see the header for why it cannot collide ---
    const movedMatchers = db.prepare('UPDATE desk_matchers SET thread_id = ?, updated_at = ? WHERE thread_id = ?')
      .run(targetId, now, sourceId).changes

    // --- the plain re-points ---
    const movedBlocks = db.prepare('UPDATE desk_blocks SET thread_id = ?, updated_at = ? WHERE thread_id = ?')
      .run(targetId, now, sourceId).changes
    const movedSegments = db.prepare('UPDATE desk_segments SET attributed_thread_id = ? WHERE attributed_thread_id = ?')
      .run(targetId, sourceId).changes
    const movedTodoLinks = db.prepare('UPDATE desk_todo_links SET thread_id = ? WHERE thread_id = ?')
      .run(targetId, sourceId).changes
    db.prepare('UPDATE desk_questions SET proposed_thread_id = ? WHERE proposed_thread_id = ?').run(targetId, sourceId)
    db.prepare('UPDATE desk_runtime SET candidate_thread_id = ? WHERE candidate_thread_id = ?').run(targetId, sourceId)

    // --- keep the newest user note ---
    if (source.userNote && (!target.userNote ||
      (source.userNoteUpdatedAt ?? '') > (target.userNoteUpdatedAt ?? ''))) {
      db.prepare("UPDATE desk_threads SET user_note = ?, user_note_updated_at = ?, source = 'user', updated_at = ? WHERE id = ?")
        .run(source.userNote, source.userNoteUpdatedAt ?? now, now, targetId)
    }
    // A merge is an explicit user act; the survivor is established, and keeps
    // whichever last_seen_at is later.
    const lastSeen = [target.lastSeenAt, source.lastSeenAt].filter(Boolean).sort().pop() ?? null
    db.prepare("UPDATE desk_threads SET status = CASE WHEN status = 'archived' THEN status ELSE 'established' END, last_seen_at = ?, updated_at = ? WHERE id = ?")
      .run(lastSeen, now, targetId)

    db.prepare('DELETE FROM desk_threads WHERE id = ?').run(sourceId)

    return {
      thread: getThread(targetId, db)!,
      movedBlocks,
      movedSegments,
      movedMatchers,
      mergedSuppressions,
      movedTodoLinks,
    }
  })

  return run()
}
