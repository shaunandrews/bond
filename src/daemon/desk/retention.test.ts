import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import { cutoffFor, runDeskRetentionSweep } from './retention'
import { purgeOldCaptures } from '../sense/storage'
import {
  attributeSegment,
  createBlock,
  createSegment,
  createThread,
  getBlock,
  getSegment,
  getThread,
  linkCapture,
  updateBlock,
} from './store'
import { confirmMatcher, getSuppression, listMatchers, recordRejection, writeInferredMatcher } from './matchers'

let testDir: string
const NOW = new Date('2026-07-20T12:00:00.000Z')
const RETENTION_DAYS = 7
/** Two days past the 7-day cutoff. */
const OLD = '2026-07-11T12:00:00.000Z'
const RECENT = '2026-07-19T12:00:00.000Z'

const sweep = () => runDeskRetentionSweep(RETENTION_DAYS, { now: NOW })

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-ret-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function oldBlockWithSegment(threadId: string | null, startedAt = OLD) {
  const block = createBlock({ threadId, startedAt })
  const segment = createSegment({
    blockId: block.id, startedAt, resourceSignature: randomUUID(),
    evidence: { titles: ['Studio — Sync Dialog'], paths: ['~/dev/bond/sync.ts'] },
  })
  return { block, segment }
}

function seedCapture(capturedAt: string): string {
  const db = getDb()
  const sessionId = randomUUID()
  const id = randomUUID()
  db.prepare('INSERT INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, 0, ?)')
    .run(sessionId, capturedAt, capturedAt)
  db.prepare(`
    INSERT INTO sense_captures (id, session_id, captured_at, window_title, text_content, text_status, created_at)
    VALUES (?, ?, ?, 'Studio — Sync Dialog', 'work text', 'done', ?)
  `).run(id, sessionId, capturedAt, capturedAt)
  return id
}

describe('cutoffFor', () => {
  it('matches purgeOldCaptures — now minus textRetentionDays', () => {
    expect(cutoffFor(7, NOW)).toBe('2026-07-13T12:00:00.000Z')
  })
})

describe('expiring screen-derived data', () => {
  it('deletes expired segments and the blocks left empty behind them', () => {
    const { block, segment } = oldBlockWithSegment(null)
    const result = sweep()

    expect(result.deletedSegments).toBe(1)
    expect(result.deletedBlocks).toBe(1)
    expect(getSegment(segment.id)).toBeNull()
    expect(getBlock(block.id)).toBeNull()
  })

  it('keeps a recent segment and its block', () => {
    const { block, segment } = oldBlockWithSegment(null, RECENT)
    sweep()
    expect(getSegment(segment.id)).not.toBeNull()
    expect(getBlock(block.id)).not.toBeNull()
  })

  it('no raw title or path survives the cutoff', () => {
    oldBlockWithSegment(null)
    sweep()
    const rows = getDb().prepare('SELECT evidence_json FROM desk_segments').all()
    expect(rows).toHaveLength(0)
  })

  it('an old block that still has a recent segment is kept', () => {
    const block = createBlock({ startedAt: OLD })
    createSegment({ blockId: block.id, startedAt: RECENT, resourceSignature: 'sig', evidence: {} })
    sweep()
    expect(getBlock(block.id)).not.toBeNull()
  })

  it('deletes generated summaries and notes along with their block', () => {
    const { block } = oldBlockWithSegment(null)
    updateBlock(block.id, { summary: 'Worked on Studio', reentryNote: 'Conflict copy unwritten', noteStatus: 'ready' })
    sweep()
    expect(getBlock(block.id)).toBeNull()
  })
})

describe('matchers', () => {
  it('deletes an expired unconfirmed matcher', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const m = writeInferredMatcher({
      field: 'resource', operator: 'exact', pattern: 'sig', threadId: t.id, confidence: 0.7, example: {},
    }).matcher!
    getDb().prepare('UPDATE desk_matchers SET last_seen_at = ?, created_at = ? WHERE id = ?').run(OLD, OLD, m.id)

    expect(sweep().deletedMatchers).toBe(1)
    expect(listMatchers()).toHaveLength(0)
  })

  it('keeps an unconfirmed matcher that is still being hit', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const m = writeInferredMatcher({
      field: 'resource', operator: 'exact', pattern: 'sig', threadId: t.id, confidence: 0.7, example: {},
    }).matcher!
    getDb().prepare('UPDATE desk_matchers SET last_seen_at = ?, created_at = ? WHERE id = ?').run(RECENT, OLD, m.id)
    sweep()
    expect(listMatchers()).toHaveLength(1)
  })

  it('keeps a confirmed pattern but clears its captured example', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const m = confirmMatcher({
      field: 'title', operator: 'prefix', pattern: 'Studio — Sync', threadId: t.id,
      example: { titles: ['Studio — Sync Dialog'] },
    })
    getDb().prepare('UPDATE desk_matchers SET last_seen_at = ?, created_at = ?, example_updated_at = ? WHERE id = ?')
      .run(OLD, OLD, OLD, m.id)

    const result = sweep()
    expect(result.clearedExamples).toBe(1)

    const after = listMatchers()[0]
    expect(after.confirmed).toBe(true)
    expect(after.pattern).toBe('Studio — Sync')
    expect(after.example).toEqual({})
  })

  it('leaves a recent example alone', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    confirmMatcher({
      field: 'title', operator: 'prefix', pattern: 'Studio — Sync', threadId: t.id,
      example: { titles: ['Studio — Sync Dialog'] },
    })
    sweep()
    expect(listMatchers()[0].example.titles).toEqual(['Studio — Sync Dialog'])
  })
})

describe('questions and suppressions', () => {
  it('deletes resolved questions past the cutoff', () => {
    const db = getDb()
    db.prepare(`INSERT INTO desk_questions (id, kind, state, expires_at, created_at)
      VALUES ('q-old', 'thread_switch', 'rejected', ?, ?)`).run(OLD, OLD)
    db.prepare(`INSERT INTO desk_questions (id, kind, state, expires_at, created_at)
      VALUES ('q-new', 'thread_switch', 'accepted', ?, ?)`).run(RECENT, RECENT)

    expect(sweep().deletedQuestions).toBe(1)
    expect(db.prepare('SELECT id FROM desk_questions').all()).toEqual([{ id: 'q-new' }])
  })

  it('never deletes a still-pending question, however old', () => {
    getDb().prepare(`INSERT INTO desk_questions (id, kind, state, expires_at, created_at)
      VALUES ('q', 'thread_switch', 'pending', ?, ?)`).run(OLD, OLD)
    sweep()
    expect(getDb().prepare('SELECT id FROM desk_questions').all()).toHaveLength(1)
  })

  it('suppressions survive — an explicit rejection holding only an opaque hash', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    recordRejection('sig-abc', t.id, { at: OLD })
    getDb().prepare('UPDATE desk_suppressions SET updated_at = ?').run(OLD)
    sweep()
    expect(getSuppression('sig-abc', t.id)).not.toBeNull()
  })
})

describe('threads', () => {
  it('deletes an inferred thread with nothing left pointing at it', () => {
    const t = createThread({ name: 'Some guess', source: 'inferred' })
    getDb().prepare('UPDATE desk_threads SET created_at = ? WHERE id = ?').run(OLD, t.id)
    oldBlockWithSegment(t.id)

    expect(sweep().deletedThreads).toBe(1)
    expect(getThread(t.id)).toBeNull()
  })

  it('keeps a user-created thread even when everything else expires', () => {
    const t = createThread({ name: 'ISP problem', source: 'user' })
    getDb().prepare('UPDATE desk_threads SET created_at = ? WHERE id = ?').run(OLD, t.id)
    oldBlockWithSegment(t.id)
    sweep()
    expect(getThread(t.id)).not.toBeNull()
  })

  it('keeps an inferred thread that a confirmed matcher still points at', () => {
    const t = createThread({ name: 'Guess', source: 'inferred' })
    getDb().prepare('UPDATE desk_threads SET created_at = ? WHERE id = ?').run(OLD, t.id)
    confirmMatcher({ field: 'resource', operator: 'exact', pattern: 'sig', threadId: t.id })
    sweep()
    expect(getThread(t.id)).not.toBeNull()
  })

  it('keeps an inferred thread a todo still links to', () => {
    const db = getDb()
    const t = createThread({ name: 'Guess', source: 'inferred' })
    db.prepare('UPDATE desk_threads SET created_at = ? WHERE id = ?').run(OLD, t.id)
    db.prepare(`INSERT INTO collections (id, name, schema, created_at, updated_at) VALUES ('c1', 'Today', '{}', ?, ?)`)
      .run(OLD, OLD)
    db.prepare(`INSERT INTO collection_items (id, collection_id, data, created_at, updated_at)
      VALUES ('i1', 'c1', '{}', ?, ?)`).run(OLD, OLD)
    db.prepare('INSERT INTO desk_todo_links (item_id, thread_id, created_at) VALUES (?, ?, ?)').run('i1', t.id, OLD)

    sweep()
    expect(getThread(t.id)).not.toBeNull()
  })
})

describe('edited-note graduation', () => {
  it('promotes the newest edited note to the thread before the block expires', () => {
    const t = createThread({ name: 'Studio sync', source: 'inferred' })
    const { block } = oldBlockWithSegment(t.id)
    updateBlock(block.id, { reentryNote: 'Conflict-state copy unwritten', noteStatus: 'edited' })
    getDb().prepare('UPDATE desk_blocks SET updated_at = ? WHERE id = ?').run(OLD, block.id)

    expect(sweep().graduatedNotes).toBe(1)

    const after = getThread(t.id)!
    expect(after.userNote).toBe('Conflict-state copy unwritten')
    expect(after.source).toBe('user')
    // and the source block is gone
    expect(getBlock(block.id)).toBeNull()
  })

  it('a graduated note keeps the inferred thread alive', () => {
    const t = createThread({ name: 'Studio sync', source: 'inferred' })
    getDb().prepare('UPDATE desk_threads SET created_at = ? WHERE id = ?').run(OLD, t.id)
    const { block } = oldBlockWithSegment(t.id)
    updateBlock(block.id, { reentryNote: 'Left mid-refactor', noteStatus: 'edited' })
    getDb().prepare('UPDATE desk_blocks SET updated_at = ? WHERE id = ?').run(OLD, block.id)

    sweep()
    expect(getThread(t.id)!.userNote).toBe('Left mid-refactor')
  })

  it('takes the most recently updated edited note per thread', () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    const older = oldBlockWithSegment(t.id).block
    const newer = oldBlockWithSegment(t.id).block
    updateBlock(older.id, { reentryNote: 'older note', noteStatus: 'edited' })
    updateBlock(newer.id, { reentryNote: 'newer note', noteStatus: 'edited' })
    getDb().prepare('UPDATE desk_blocks SET updated_at = ? WHERE id = ?').run('2026-07-11T09:00:00.000Z', older.id)
    getDb().prepare('UPDATE desk_blocks SET updated_at = ? WHERE id = ?').run('2026-07-11T18:00:00.000Z', newer.id)

    sweep()
    expect(getThread(t.id)!.userNote).toBe('newer note')
  })

  it('never overwrites a newer user note already on the thread', () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    getDb().prepare('UPDATE desk_threads SET user_note = ?, user_note_updated_at = ? WHERE id = ?')
      .run('the note I wrote myself', RECENT, t.id)
    const { block } = oldBlockWithSegment(t.id)
    updateBlock(block.id, { reentryNote: 'stale generated note', noteStatus: 'edited' })
    getDb().prepare('UPDATE desk_blocks SET updated_at = ? WHERE id = ?').run(OLD, block.id)

    sweep()
    expect(getThread(t.id)!.userNote).toBe('the note I wrote myself')
  })

  it('does not graduate a merely generated note', () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    const { block } = oldBlockWithSegment(t.id)
    updateBlock(block.id, { reentryNote: 'generated, never touched', noteStatus: 'ready' })
    getDb().prepare('UPDATE desk_blocks SET updated_at = ? WHERE id = ?').run(OLD, block.id)

    expect(sweep().graduatedNotes).toBe(0)
    expect(getThread(t.id)!.userNote).toBeNull()
  })
})

describe('order independence with capture deletion', () => {
  function seedLinkedOldData() {
    const t = createThread({ name: 'Guess', source: 'inferred' })
    getDb().prepare('UPDATE desk_threads SET created_at = ? WHERE id = ?').run(OLD, t.id)
    const { block, segment } = oldBlockWithSegment(t.id)
    attributeSegment(segment.id, { threadId: t.id, confidence: 0.8 })
    linkCapture(segment.id, seedCapture(OLD))
    return { thread: t, block, segment }
  }

  function assertNothingSurvives(threadId: string, blockId: string, segmentId: string) {
    expect(getSegment(segmentId)).toBeNull()
    expect(getBlock(blockId)).toBeNull()
    expect(getThread(threadId)).toBeNull()
    const links = getDb().prepare('SELECT COUNT(*) AS n FROM desk_capture_links').get() as { n: number }
    expect(links.n).toBe(0)
  }

  it('Desk sweep first, then capture deletion', () => {
    const { thread, block, segment } = seedLinkedOldData()
    sweep()
    purgeOldCaptures(RETENTION_DAYS)
    assertNothingSurvives(thread.id, block.id, segment.id)
  })

  it('capture deletion first, then Desk sweep', () => {
    const { thread, block, segment } = seedLinkedOldData()
    purgeOldCaptures(RETENTION_DAYS)
    // the link cascaded away, but Desk keys off its own timestamps
    sweep()
    assertNothingSurvives(thread.id, block.id, segment.id)
  })
})

describe('idempotence', () => {
  it('a second sweep changes nothing', () => {
    const t = createThread({ name: 'Guess', source: 'inferred' })
    getDb().prepare('UPDATE desk_threads SET created_at = ? WHERE id = ?').run(OLD, t.id)
    oldBlockWithSegment(t.id)
    sweep()

    expect(sweep()).toEqual({
      graduatedNotes: 0, deletedSegments: 0, deletedBlocks: 0,
      deletedMatchers: 0, clearedExamples: 0, deletedQuestions: 0, deletedThreads: 0,
    })
  })

  it('an empty database sweeps cleanly', () => {
    expect(() => sweep()).not.toThrow()
  })
})
