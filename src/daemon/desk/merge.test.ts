import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import {
  attributeSegment,
  createBlock,
  createSegment,
  createThread,
  getBlockDetail,
  getRuntime,
  getSegment,
  getThread,
  setRuntime,
} from './store'
import { confirmMatcher, findMatcher, getSuppression, listMatchers, recordRejection, writeInferredMatcher } from './matchers'
import { mergeThreads } from './merge'
import type { DeskThread } from '../../shared/desk'

let testDir: string
let target: DeskThread
let source: DeskThread

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-merge-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  target = createThread({ name: 'Studio sync', source: 'user' })
  source = createThread({ name: 'Sync dialog', source: 'inferred' })
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

describe('mergeThreads', () => {
  it('rejects merging a thread into itself or a missing thread', () => {
    expect(mergeThreads(target.id, target.id)).toBeNull()
    expect(mergeThreads(target.id, 'nope')).toBeNull()
    expect(mergeThreads('nope', source.id)).toBeNull()
  })

  it('re-points blocks, segments, matchers, and todo links, then removes the loser', () => {
    const block = createBlock({ threadId: source.id })
    const seg = createSegment({ blockId: block.id, startedAt: 'a', resourceSignature: 'sig', evidence: {} })
    attributeSegment(seg.id, { threadId: source.id, confidence: 0.8 })
    writeInferredMatcher({
      field: 'title', operator: 'exact', pattern: 'only on source', threadId: source.id, confidence: 0.8, example: {},
    })

    const result = mergeThreads(target.id, source.id)!

    expect(result.movedBlocks).toBe(1)
    expect(result.movedSegments).toBe(1)
    expect(result.movedMatchers).toBe(1)
    expect(getBlockDetail(block.id)!.threadId).toBe(target.id)
    expect(getSegment(seg.id)!.attributedThreadId).toBe(target.id)
    expect(listMatchers()[0].threadId).toBe(target.id)
    expect(getThread(source.id)).toBeNull()
  })

  it('leaves nothing pointing at the removed thread', () => {
    const block = createBlock({ threadId: source.id })
    createSegment({ blockId: block.id, startedAt: 'a', resourceSignature: 'sig', evidence: {} })
    writeInferredMatcher({ field: 'resource', operator: 'exact', pattern: 'sig', threadId: source.id, confidence: 1, example: {} })
    recordRejection('other-sig', source.id)

    mergeThreads(target.id, source.id)

    const db = getDb()
    for (const [table, column] of [
      ['desk_blocks', 'thread_id'],
      ['desk_segments', 'attributed_thread_id'],
      ['desk_matchers', 'thread_id'],
      ['desk_suppressions', 'thread_id'],
      ['desk_todo_links', 'thread_id'],
    ] as const) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(source.id) as { n: number }
      expect(`${table}:${n.n}`).toBe(`${table}:0`)
    }
  })

  it('moves a pending candidate over so a merge cannot strand the runtime', () => {
    setRuntime({ candidateThreadId: source.id, candidateResourceSignature: 'sig' })
    mergeThreads(target.id, source.id)
    expect(getRuntime().candidateThreadId).toBe(target.id)
  })

  it('re-points a pending question at the survivor', () => {
    const db = getDb()
    db.prepare(`
      INSERT INTO desk_questions (id, kind, proposed_thread_id, state, expires_at, created_at)
      VALUES ('q1', 'thread_switch', ?, 'pending', '2099-01-01T00:00:00.000Z', '2026-07-20T10:00:00.000Z')
    `).run(source.id)
    mergeThreads(target.id, source.id)
    const q = db.prepare('SELECT proposed_thread_id FROM desk_questions WHERE id = ?').get('q1') as { proposed_thread_id: string }
    expect(q.proposed_thread_id).toBe(target.id)
  })
})

describe('merge collisions — suppressions', () => {
  it('never weakens a suppression: max count, later expiry, permanent wins', () => {
    // target rejected once today; source rejected three times, permanently.
    recordRejection('shared-sig', target.id, { at: '2026-07-20T10:00:00.000Z' })
    recordRejection('shared-sig', source.id)
    recordRejection('shared-sig', source.id)
    recordRejection('shared-sig', source.id)

    const result = mergeThreads(target.id, source.id)!
    expect(result.mergedSuppressions).toBe(1)

    const merged = getSuppression('shared-sig', target.id)!
    expect(merged.rejectionCount).toBe(3)
    expect(merged.permanent).toBe(true)
  })

  it('keeps the later suppress_until', () => {
    recordRejection('shared-sig', target.id, { at: '2026-07-20T10:00:00.000Z', dayEnd: '2026-07-20T23:59:59.999Z' })
    recordRejection('shared-sig', source.id, { at: '2026-07-21T10:00:00.000Z', dayEnd: '2026-07-25T23:59:59.999Z' })

    mergeThreads(target.id, source.id)
    expect(getSuppression('shared-sig', target.id)!.suppressUntil).toBe('2026-07-25T23:59:59.999Z')
  })

  it('carries a non-colliding suppression over untouched', () => {
    recordRejection('source-only', source.id, { at: '2026-07-20T10:00:00.000Z' })
    mergeThreads(target.id, source.id)
    expect(getSuppression('source-only', target.id)!.rejectionCount).toBe(1)
  })

  it('leaves exactly one row per signature after the merge', () => {
    recordRejection('shared-sig', target.id)
    recordRejection('shared-sig', source.id)
    mergeThreads(target.id, source.id)
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM desk_suppressions').get() as { n: number }
    expect(n.n).toBe(1)
  })
})

describe('merge — matchers cannot collide', () => {
  const KEY = { field: 'title' as const, operator: 'exact' as const, pattern: 'sync dialog' }

  it('the schema forbids two threads holding the same pattern in the first place', () => {
    writeInferredMatcher({ ...KEY, threadId: target.id, confidence: 0.5, example: {} })
    // The authority matrix refuses, and even a raw insert hits UNIQUE(field, operator, normalized_pattern)
    expect(writeInferredMatcher({ ...KEY, threadId: source.id, confidence: 0.9, example: {} }).action)
      .toBe('blocked_other_thread')
    expect(() =>
      getDb().prepare(`
        INSERT INTO desk_matchers (id, thread_id, field, operator, pattern, normalized_pattern,
          confirmed, source, confidence, specificity, created_at, updated_at)
        VALUES ('dupe', ?, 'title', 'exact', 'Sync dialog', 'sync dialog', 0, 'inferred', 1, 300, 'x', 'x')
      `).run(source.id)
    ).toThrow(/UNIQUE/)
  })

  it('re-points a matcher wholesale, preserving its authority and hits', () => {
    confirmMatcher({ ...KEY, threadId: source.id })
    getDb().prepare('UPDATE desk_matchers SET hits = 7 WHERE thread_id = ?').run(source.id)

    const result = mergeThreads(target.id, source.id)!
    expect(result.movedMatchers).toBe(1)

    const moved = findMatcher(KEY)!
    expect(moved.threadId).toBe(target.id)
    expect(moved.confirmed).toBe(true)
    expect(moved.hits).toBe(7)
    expect(listMatchers()).toHaveLength(1)
  })

  it('the matcher a segment and the runtime candidate point at survives the merge', () => {
    const m = writeInferredMatcher({ ...KEY, threadId: source.id, confidence: 0.5, example: {} }).matcher!
    const seg = createSegment({ blockId: null, startedAt: 'a', resourceSignature: 'sig', evidence: {} })
    attributeSegment(seg.id, { threadId: source.id, matcherId: m.id, confidence: 0.5 })
    setRuntime({ candidateMatcherId: m.id })

    mergeThreads(target.id, source.id)

    expect(getSegment(seg.id)!.matcherId).toBe(m.id)
    expect(getRuntime().candidateMatcherId).toBe(m.id)
    expect(findMatcher(KEY)!.threadId).toBe(target.id)
  })
})

describe('merge — thread identity', () => {
  it('keeps the newest user note', () => {
    getDb().prepare('UPDATE desk_threads SET user_note = ?, user_note_updated_at = ? WHERE id = ?')
      .run('older note', '2026-07-01T00:00:00.000Z', target.id)
    getDb().prepare('UPDATE desk_threads SET user_note = ?, user_note_updated_at = ? WHERE id = ?')
      .run('newer note', '2026-07-19T00:00:00.000Z', source.id)

    mergeThreads(target.id, source.id)
    expect(getThread(target.id)!.userNote).toBe('newer note')
  })

  it('keeps the target note when it is newer', () => {
    getDb().prepare('UPDATE desk_threads SET user_note = ?, user_note_updated_at = ? WHERE id = ?')
      .run('newer note', '2026-07-19T00:00:00.000Z', target.id)
    getDb().prepare('UPDATE desk_threads SET user_note = ?, user_note_updated_at = ? WHERE id = ?')
      .run('older note', '2026-07-01T00:00:00.000Z', source.id)

    mergeThreads(target.id, source.id)
    expect(getThread(target.id)!.userNote).toBe('newer note')
  })

  it('a merge is an explicit user act, so the survivor is established', () => {
    const provisionalA = createThread({ name: 'A', source: 'inferred' })
    const provisionalB = createThread({ name: 'B', source: 'inferred' })
    mergeThreads(provisionalA.id, provisionalB.id)
    expect(getThread(provisionalA.id)!.status).toBe('established')
  })

  it('keeps the later last_seen_at', () => {
    getDb().prepare('UPDATE desk_threads SET last_seen_at = ? WHERE id = ?').run('2026-07-01T00:00:00.000Z', target.id)
    getDb().prepare('UPDATE desk_threads SET last_seen_at = ? WHERE id = ?').run('2026-07-19T00:00:00.000Z', source.id)
    mergeThreads(target.id, source.id)
    expect(getThread(target.id)!.lastSeenAt).toBe('2026-07-19T00:00:00.000Z')
  })
})
