/**
 * Desk-derived screen data expires with Sense's text retention.
 *
 * No raw title, path, example, summary, generated note, inferred resource
 * attribution, or inferred orphan thread may outlive `textRetentionDays`.
 *
 * The queries key off **Desk timestamps**, never capture links, so this runs
 * correctly before or after `purgeOldCaptures` deletes the captures those links
 * pointed at. Both orders are covered by tests.
 *
 * What survives is exactly what the user authored: named/renamed threads,
 * todos, confirmed patterns, suppressions (an explicit rejection, and only an
 * opaque resource hash), and graduated `user_note` values.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db'

export interface DeskSweepResult {
  graduatedNotes: number
  deletedSegments: number
  deletedBlocks: number
  deletedMatchers: number
  clearedExamples: number
  deletedQuestions: number
  deletedThreads: number
}

export function cutoffFor(textRetentionDays: number, now: Date = new Date()): string {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - textRetentionDays)
  return cutoff.toISOString()
}

/**
 * One transaction, run alongside Sense's hourly retention cleanup.
 */
export function runDeskRetentionSweep(
  textRetentionDays: number,
  opts: { now?: Date; db?: Database.Database } = {}
): DeskSweepResult {
  const db = opts.db ?? getDb()
  const now = opts.now ?? new Date()
  const cutoff = cutoffFor(textRetentionDays, now)
  const nowIso = now.toISOString()

  const sweep = db.transaction((): DeskSweepResult => {
    const result: DeskSweepResult = {
      graduatedNotes: 0, deletedSegments: 0, deletedBlocks: 0,
      deletedMatchers: 0, clearedExamples: 0, deletedQuestions: 0, deletedThreads: 0,
    }

    // 1. Graduate edited notes BEFORE their source block expires. This is the
    //    explicit promotion from generated evidence to a user-authored thread
    //    note; the thread row renders it once the block is gone.
    const edited = db.prepare(`
      SELECT b.thread_id, b.reentry_note, b.updated_at
      FROM desk_blocks b
      WHERE b.note_status = 'edited'
        AND b.reentry_note IS NOT NULL
        AND b.thread_id IS NOT NULL
        AND b.started_at < ?
      ORDER BY b.thread_id, b.updated_at DESC
    `).all(cutoff) as { thread_id: string; reentry_note: string; updated_at: string }[]

    const newestPerThread = new Map<string, { note: string; updatedAt: string }>()
    for (const row of edited) {
      const existing = newestPerThread.get(row.thread_id)
      if (!existing || row.updated_at > existing.updatedAt) {
        newestPerThread.set(row.thread_id, { note: row.reentry_note, updatedAt: row.updated_at })
      }
    }
    const graduate = db.prepare(`
      UPDATE desk_threads
      SET user_note = ?, user_note_updated_at = ?, source = 'user', updated_at = ?
      WHERE id = ? AND (user_note_updated_at IS NULL OR user_note_updated_at < ?)
    `)
    for (const [threadId, { note, updatedAt }] of newestPerThread) {
      result.graduatedNotes += graduate.run(note, updatedAt, nowIso, threadId, updatedAt).changes
    }

    // 2. Expired segments, then blocks left with nothing behind them. Their
    //    summaries, notes, presence totals, and timestamps go with them.
    result.deletedSegments = db.prepare('DELETE FROM desk_segments WHERE started_at < ?').run(cutoff).changes
    result.deletedBlocks = db.prepare(`
      DELETE FROM desk_blocks
      WHERE started_at < ?
        AND NOT EXISTS (SELECT 1 FROM desk_segments s WHERE s.block_id = desk_blocks.id)
    `).run(cutoff).changes

    // 3. Unconfirmed matchers expire. Confirmed patterns remain because the
    //    user approved them — but their captured example does not.
    result.deletedMatchers = db.prepare(`
      DELETE FROM desk_matchers
      WHERE confirmed = 0 AND (last_seen_at IS NULL OR last_seen_at < ?) AND created_at < ?
    `).run(cutoff, cutoff).changes
    result.clearedExamples = db.prepare(`
      UPDATE desk_matchers SET example_json = '{}', example_updated_at = NULL, updated_at = ?
      WHERE example_json != '{}' AND example_updated_at IS NOT NULL AND example_updated_at < ?
    `).run(nowIso, cutoff).changes

    // 4. Resolved questions expire. Suppressions do NOT — they encode an
    //    explicit rejection and hold only an opaque hash, not a title.
    result.deletedQuestions = db.prepare(
      "DELETE FROM desk_questions WHERE state != 'pending' AND created_at < ?"
    ).run(cutoff).changes

    // 5. Inferred threads with nothing left to point at them. A user-created,
    //    user-renamed, or note-carrying thread is user-authored and stays.
    result.deletedThreads = db.prepare(`
      DELETE FROM desk_threads
      WHERE source = 'inferred'
        AND user_note IS NULL
        AND created_at < ?
        AND NOT EXISTS (SELECT 1 FROM desk_blocks b WHERE b.thread_id = desk_threads.id)
        AND NOT EXISTS (SELECT 1 FROM desk_matchers m WHERE m.thread_id = desk_threads.id)
        AND NOT EXISTS (SELECT 1 FROM desk_todo_links l WHERE l.thread_id = desk_threads.id)
        AND NOT EXISTS (SELECT 1 FROM desk_segments s WHERE s.attributed_thread_id = desk_threads.id)
    `).run(cutoff).changes

    return result
  })

  return sweep()
}
