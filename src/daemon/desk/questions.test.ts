import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import {
  acceptQuestion,
  assertionAllowed,
  cancelPendingQuestions,
  createQuestion,
  expireQuestions,
  getPendingQuestion,
  getQuestion,
  markAsserted,
  rejectQuestion,
  validateQuestion,
} from './questions'
import {
  attributeSegment,
  createBlock,
  createSegment,
  createThread,
  getBlockDetail,
  getRuntime,
  getSegment,
  setRuntime,
} from './store'
import { getSuppression, isSuppressed, listMatchers, writeInferredMatcher } from './matchers'
import type { DeskThread } from '../../shared/desk'

let testDir: string
let studio: DeskThread

const T0 = Date.parse('2026-07-20T09:00:00.000Z')
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString()
const ctx = (offsetSeconds: number) => ({ now: () => new Date(T0 + offsetSeconds * 1000) })

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-q-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  studio = createThread({ name: 'Studio sync dialog', source: 'user' })
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function switchQuestion(offset = 0, signature = 'sig-abc', blockId: string | null = null) {
  return createQuestion(
    { kind: 'thread_switch', proposedThreadId: studio.id, resourceSignature: signature, blockId },
    ctx(offset)
  )
}

describe('validateQuestion', () => {
  it('requires the foreign key each kind actually needs', () => {
    expect(validateQuestion({ kind: 'thread_switch', proposedThreadId: 't' })).toBeNull()
    expect(validateQuestion({ kind: 'thread_switch' })).toMatch(/proposedThreadId/)
    expect(validateQuestion({ kind: 'todo_started', itemId: 'i' })).toBeNull()
    expect(validateQuestion({ kind: 'todo_started' })).toMatch(/itemId/)
    expect(validateQuestion({ kind: 'nonsense' as never })).toMatch(/unknown question kind/)
  })
})

describe('the interruption budget', () => {
  it('allows the first assertion', () => {
    expect(assertionAllowed(ctx(0))).toBe(true)
  })

  it('holds the line for ten minutes after one', () => {
    markAsserted(ctx(0))
    expect(assertionAllowed(ctx(599))).toBe(false)
    expect(assertionAllowed(ctx(600))).toBe(true)
  })

  it('a restart cannot reset it', () => {
    markAsserted(ctx(0))
    closeDb()
    expect(assertionAllowed(ctx(300))).toBe(false)
  })

  it('refuses a second Ask inside the window', () => {
    expect(switchQuestion(0).ok).toBe(true)
    // resolve the first so 'already_pending' is not what blocks it
    acceptQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))
    const second = switchQuestion(120)
    expect(second).toEqual({ ok: false, reason: 'budget' })
  })

  it('refuses a second Ask while one is still pending', () => {
    switchQuestion(0)
    expect(switchQuestion(700)).toEqual({ ok: false, reason: 'already_pending' })
  })

  it('refuses an invalid question without spending the budget', () => {
    expect(createQuestion({ kind: 'thread_switch' }, ctx(0))).toMatchObject({ ok: false, reason: 'invalid' })
    expect(assertionAllowed(ctx(0))).toBe(true)
  })

  it('creating the Ask IS the assertion', () => {
    switchQuestion(0)
    expect(getRuntime().lastAssertionAt).toBe(at(0))
  })
})

describe('the pending question', () => {
  it('carries the proposed thread name for the one-line lozenge', () => {
    switchQuestion(0)
    const pending = getPendingQuestion(ctx(60))!
    expect(pending.proposedThreadName).toBe('Studio sync dialog')
    expect(pending.kind).toBe('thread_switch')
  })

  it('stops being pending once expired', () => {
    switchQuestion(0)
    expect(getPendingQuestion(ctx(60))).not.toBeNull()
    expect(getPendingQuestion(ctx(1300))).toBeNull()
  })
})

describe('accepting', () => {
  it('commits the switch to a new block', () => {
    setRuntime({ candidateSince: at(0) })
    switchQuestion(0)
    const result = acceptQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))!

    const block = getBlockDetail(result.committedBlockId!)!
    expect(block.threadId).toBe(studio.id)
    expect(block.source).toBe('confirmed')
    expect(block.startedAt).toBe(at(0))
    expect(getRuntime().currentBlockId).toBe(block.id)
  })

  it('is idempotent — answering twice does nothing the second time', () => {
    switchQuestion(0)
    const id = getPendingQuestion(ctx(60))!.id
    expect(acceptQuestion(id, ctx(60))).not.toBeNull()
    expect(acceptQuestion(id, ctx(70))).toBeNull()
    expect(rejectQuestion(id, ctx(70))).toBeNull()
  })
})

describe('rejecting — a real state change, not a dismissal', () => {
  function seedInferredAttribution(signature = 'sig-abc') {
    const matcher = writeInferredMatcher({
      field: 'resource', operator: 'exact', pattern: signature,
      threadId: studio.id, confidence: 0.8, example: {},
    }).matcher
    const segment = createSegment({ blockId: null, startedAt: at(0), resourceSignature: signature, evidence: {} })
    attributeSegment(segment.id, { threadId: studio.id, matcherId: matcher.id, confidence: 0.8 })
    return { matcher, segment }
  }

  it('drops the unconfirmed matcher that produced the suggestion', () => {
    seedInferredAttribution()
    switchQuestion(0)
    const result = rejectQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))!

    expect(result.droppedMatchers).toBe(1)
    expect(listMatchers()).toHaveLength(0)
  })

  it('clears the affected segment attributions', () => {
    const { segment } = seedInferredAttribution()
    switchQuestion(0)
    const result = rejectQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))!

    expect(result.clearedSegments).toBe(1)
    expect(getSegment(segment.id)!.attributedThreadId).toBeNull()
    expect(getSegment(segment.id)!.attributionState).toBe('unresolved')
  })

  it('suppresses the pairing so the next resolution differs', () => {
    seedInferredAttribution()
    switchQuestion(0)
    rejectQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))
    expect(isSuppressed('sig-abc', studio.id, at(3600))).toBe(true)
  })

  it('three rejections make the suppression permanent', () => {
    for (let day = 0; day < 3; day++) {
      seedInferredAttribution()
      switchQuestion(day * 86_400)
      rejectQuestion(getPendingQuestion(ctx(day * 86_400 + 60))!.id, ctx(day * 86_400 + 60))
    }
    const suppression = getSuppression('sig-abc', studio.id)!
    expect(suppression.rejectionCount).toBe(3)
    expect(suppression.permanent).toBe(true)
  })

  it('a rejection never creates a positive attribution rule', () => {
    switchQuestion(0)
    rejectQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))
    expect(listMatchers()).toHaveLength(0)
  })

  it('restores an optimistically-attributed block to unknown', () => {
    const block = createBlock({ threadId: studio.id, startedAt: at(0), source: 'inferred', confidence: 0.7 })
    seedInferredAttribution()
    switchQuestion(0, 'sig-abc', block.id)
    rejectQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))

    expect(getBlockDetail(block.id)!.threadId).toBeNull()
  })

  it('leaves a manually-assigned block alone', () => {
    const block = createBlock({ threadId: studio.id, startedAt: at(0), source: 'manual', confidence: 1 })
    switchQuestion(0, 'sig-abc', block.id)
    rejectQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))

    expect(getBlockDetail(block.id)!.threadId).toBe(studio.id)
  })

  it('clears the candidate that produced the Ask', () => {
    setRuntime({ candidateThreadId: studio.id, candidateSince: at(0), candidatePresenceSeconds: 200 })
    switchQuestion(0)
    rejectQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))

    const rt = getRuntime()
    expect(rt.candidateThreadId).toBeNull()
    expect(rt.candidatePresenceSeconds).toBe(0)
  })

  it('leaves the current block in place — "No" means stay put', () => {
    const block = createBlock({ threadId: null, startedAt: at(0) })
    setRuntime({ currentBlockId: block.id })
    switchQuestion(0)
    rejectQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))

    expect(getRuntime().currentBlockId).toBe(block.id)
  })
})

describe('silence — an ignored Ask', () => {
  it('commits this block and teaches nothing', () => {
    setRuntime({ candidateSince: at(0) })
    switchQuestion(0)
    const [result] = expireQuestions(ctx(1300))

    expect(result.question.state).toBe('auto_accepted')
    const block = getBlockDetail(result.committedBlockId!)!
    expect(block.threadId).toBe(studio.id)
    // 'inferred', not 'confirmed' — silence is local consent, nothing more
    expect(block.source).toBe('inferred')
    expect(listMatchers()).toHaveLength(0)
  })

  it('never suppresses anything', () => {
    switchQuestion(0)
    expireQuestions(ctx(1300))
    expect(getSuppression('sig-abc', studio.id)).toBeNull()
  })

  it('leaves a not-yet-expired question alone', () => {
    switchQuestion(0)
    expect(expireQuestions(ctx(600))).toHaveLength(0)
    expect(getQuestion(getPendingQuestion(ctx(600))!.id)!.state).toBe('pending')
  })
})

describe('todo_started questions', () => {
  function seedTodo(title = 'Fix the ISP thing'): string {
    const db = getDb()
    const ts = at(0)
    db.prepare(`INSERT INTO collections (id, name, schema, created_at, updated_at) VALUES ('c1', 'Today', '{}', ?, ?)`)
      .run(ts, ts)
    const id = randomUUID()
    db.prepare('INSERT INTO collection_items (id, collection_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'c1', JSON.stringify({ title, status: 'todo' }), ts, ts)
    return id
  }

  function itemStatus(id: string): string {
    const row = getDb().prepare('SELECT data FROM collection_items WHERE id = ?').get(id) as { data: string }
    return JSON.parse(row.data).status
  }

  it('carries the item title for the lozenge', () => {
    const itemId = seedTodo()
    createQuestion({ kind: 'todo_started', itemId }, ctx(0))
    expect(getPendingQuestion(ctx(60))!.itemTitle).toBe('Fix the ISP thing')
  })

  it('accepting marks the item in progress', () => {
    const itemId = seedTodo()
    createQuestion({ kind: 'todo_started', itemId }, ctx(0))
    acceptQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))
    expect(itemStatus(itemId)).toBe('in_progress')
  })

  it('expiring marks the item in progress too', () => {
    const itemId = seedTodo()
    createQuestion({ kind: 'todo_started', itemId }, ctx(0))
    expireQuestions(ctx(1300))
    expect(itemStatus(itemId)).toBe('in_progress')
  })

  it('rejecting changes no attribution and no status', () => {
    const itemId = seedTodo()
    createQuestion({ kind: 'todo_started', itemId }, ctx(0))
    rejectQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))
    expect(itemStatus(itemId)).toBe('todo')
    expect(listMatchers()).toHaveLength(0)
  })

  it('shares the same global budget as a thread_switch', () => {
    const itemId = seedTodo()
    switchQuestion(0)
    acceptQuestion(getPendingQuestion(ctx(60))!.id, ctx(60))
    expect(createQuestion({ kind: 'todo_started', itemId }, ctx(120))).toMatchObject({ reason: 'budget' })
  })
})

describe('cancelPendingQuestions', () => {
  it('resolves nothing and commits nothing', () => {
    setRuntime({ candidateSince: at(0) })
    switchQuestion(0)
    expect(cancelPendingQuestions(ctx(60))).toBe(1)
    expect(getPendingQuestion(ctx(60))).toBeNull()
    expect(getRuntime().currentBlockId).toBeNull()
  })
})
