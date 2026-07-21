import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import * as desk from './service'
import {
  attributeSegment,
  createBlock,
  createSegment,
  createThread,
  getBlockDetail,
  getRuntime,
  setRuntime,
} from './store'
import { confirmMatcher, findMatcher, listMatchers, writeInferredMatcher } from './matchers'
import { createQuestion, getPendingQuestion } from './questions'
import { addTodayItem } from './today'
import type { DeskThread } from '../../shared/desk'

let testDir: string
let studio: DeskThread
let isp: DeskThread

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-service-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  desk.resetDeskListenersForTest()
  studio = createThread({ name: 'Studio sync dialog', source: 'user' })
  isp = createThread({ name: 'ISP problem', source: 'user' })
})

afterEach(() => {
  desk.resetDeskListenersForTest()
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function blockWithSegment(threadId: string | null, signature = 'sig-abc') {
  const block = createBlock({ threadId, startedAt: '2026-07-20T09:00:00.000Z' })
  const segment = createSegment({
    blockId: block.id, startedAt: '2026-07-20T09:00:00.000Z',
    resourceSignature: signature, evidence: { bundleId: 'com.automattic.studio', titles: ['Studio — Sync Dialog'] },
  })
  return { block, segment }
}

describe('the change broadcast', () => {
  it('fires on every state change so a second window stays in lockstep', () => {
    const listener = vi.fn()
    desk.onDeskChanged(listener)

    desk.createUserThread('New thread')
    expect(listener).toHaveBeenCalledTimes(1)

    desk.setRunning(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes cleanly', () => {
    const listener = vi.fn()
    const off = desk.onDeskChanged(listener)
    off()
    desk.createUserThread('x')
    expect(listener).not.toHaveBeenCalled()
  })

  it('a throwing listener does not take the operation down', () => {
    desk.onDeskChanged(() => { throw new Error('boom') })
    expect(() => desk.createUserThread('Still created')).not.toThrow()
    expect(desk.getThreads().some(t => t.name === 'Still created')).toBe(true)
  })
})

describe('status', () => {
  it('reports Sense disabled when nothing registered a provider', () => {
    const status = desk.getStatus()
    expect(status.senseEnabled).toBe(false)
    expect(status.senseState).toBe('disabled')
  })

  it('reads Sense through the registered provider', () => {
    desk.setSenseStateProvider(() => ({ state: 'recording', enabled: true }))
    const status = desk.getStatus()
    expect(status.senseState).toBe('recording')
    expect(status.senseEnabled).toBe(true)
  })

  it('a throwing Sense provider does not take status down', () => {
    desk.setSenseStateProvider(() => { throw new Error('controller gone') })
    expect(() => desk.getStatus()).not.toThrow()
    expect(desk.getStatus().senseState).toBe('disabled')
  })

  it('running is explicit, persisted state', () => {
    expect(desk.getStatus().running).toBe(false)
    desk.setRunning(true)
    closeDb()
    expect(desk.getStatus().running).toBe(true)
  })

  it('reports the current block and its summed presence', () => {
    const { block } = blockWithSegment(studio.id)
    getDb().prepare('UPDATE desk_blocks SET presence_seconds = 4800 WHERE id = ?').run(block.id)
    setRuntime({ currentBlockId: block.id })

    const status = desk.getStatus()
    expect(status.currentBlock!.thread!.name).toBe('Studio sync dialog')
    expect(status.presenceSeconds).toBe(4800)
  })

  it('surfaces the pending question', () => {
    createQuestion({ kind: 'thread_switch', proposedThreadId: studio.id, resourceSignature: 'sig' })
    expect(desk.getStatus().pendingQuestion!.proposedThreadName).toBe('Studio sync dialog')
  })

  it('reports back-fill until the checkpoint catches up with the newest capture', () => {
    const db = getDb()
    const ts = '2026-07-20T09:00:00.000Z'
    db.prepare('INSERT INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, 0, ?)')
      .run('s1', ts, ts)
    db.prepare(`INSERT INTO sense_captures (id, session_id, captured_at, image_path, text_status, created_at)
      VALUES ('c1', 's1', ?, '/tmp/a.jpg', 'done', ?)`).run(ts, ts)

    expect(desk.getStatus().backfilling).toBe(true)

    setRuntime({ processedCaptureAt: ts, processedCaptureId: 'c1' })
    expect(desk.getStatus().backfilling).toBe(false)
  })

  it('is not back-filling when there is nothing to back-fill', () => {
    expect(desk.getStatus().backfilling).toBe(false)
  })
})

describe('reassignment', () => {
  it('updates the block immediately — the rule write happens behind it', () => {
    const { block } = blockWithSegment(studio.id)
    const result = desk.reassignBlock({ blockId: block.id, threadId: isp.id })!

    expect(result.block.threadId).toBe(isp.id)
    expect(result.block.source).toBe('manual')
    expect(result.learned).toBe('Moved this block to ISP problem.')
  })

  it('re-points every segment on the block', () => {
    const { block, segment } = blockWithSegment(studio.id)
    attributeSegment(segment.id, { threadId: studio.id, confidence: 0.6 })
    desk.reassignBlock({ blockId: block.id, threadId: isp.id })

    const after = getBlockDetail(block.id)!.segments![0]
    expect(after.attributedThreadId).toBe(isp.id)
    expect(after.attributionConfidence).toBe(1)
  })

  it('stores a one-resource attribution and asks nothing further when no pattern is named', () => {
    const { block } = blockWithSegment(studio.id)
    const result = desk.reassignBlock({ blockId: block.id, threadId: isp.id })!

    expect(result.matcher!.confirmed).toBe(false)
    expect(result.matcher!.field).toBe('resource')
    expect(result.matcher!.source).toBe('user')
  })

  it('confirms a durable rule only when a concrete pattern is supplied', () => {
    const { block } = blockWithSegment(studio.id)
    const result = desk.reassignBlock({
      blockId: block.id, threadId: isp.id,
      confirmedMatcher: { field: 'title', operator: 'prefix', pattern: 'Studio — Sync Dialog' },
    })!

    expect(result.matcher!.confirmed).toBe(true)
    expect(result.learned).toContain('windows titled "Studio — Sync Dialog" will go to ISP problem')
  })

  it('says what it learned once, then stops talking about rules', () => {
    const { block } = blockWithSegment(studio.id)
    const first = desk.reassignBlock({ blockId: block.id, threadId: isp.id })!
    expect(first.learned).not.toMatch(/rule|matcher|pattern/i)
  })

  it('refuses to turn a generic app into a bundle-wide rule', () => {
    const { block } = blockWithSegment(studio.id)
    const result = desk.reassignBlock({
      blockId: block.id, threadId: isp.id,
      confirmedMatcher: { field: 'bundle', operator: 'exact', pattern: 'com.google.Chrome' },
    })!

    expect(result.learned).toContain('covers too much to become a rule')
    expect(listMatchers({ confirmedOnly: true })).toHaveLength(0)
    // the block still moved
    expect(result.block.threadId).toBe(isp.id)
  })

  it('allows a bundle rule for a purpose-built app', () => {
    const { block } = blockWithSegment(studio.id)
    const result = desk.reassignBlock({
      blockId: block.id, threadId: isp.id,
      confirmedMatcher: { field: 'bundle', operator: 'exact', pattern: 'com.automattic.studio' },
    })!
    expect(result.matcher!.confirmed).toBe(true)
  })

  it('re-teaching a confirmed pattern to another thread succeeds', () => {
    const key = { field: 'title' as const, operator: 'prefix' as const, pattern: 'Studio — Sync' }
    confirmMatcher({ ...key, threadId: studio.id })
    const { block } = blockWithSegment(studio.id)

    const result = desk.reassignBlock({ blockId: block.id, threadId: isp.id, confirmedMatcher: key })!
    expect(result.matcher!.threadId).toBe(isp.id)
    expect(findMatcher(key)!.confirmed).toBe(true)
  })

  it('returns null for a missing block or thread', () => {
    const { block } = blockWithSegment(studio.id)
    expect(desk.reassignBlock({ blockId: 'nope', threadId: isp.id })).toBeNull()
    expect(desk.reassignBlock({ blockId: block.id, threadId: 'nope' })).toBeNull()
  })

  it('preserves an existing confirmed matcher through a plain reassignment', () => {
    writeInferredMatcher({
      field: 'resource', operator: 'exact', pattern: 'sig-abc',
      threadId: studio.id, confidence: 0.5, example: {},
    })
    const { block } = blockWithSegment(studio.id)
    const result = desk.reassignBlock({ blockId: block.id, threadId: isp.id })!
    expect(result.matcher!.threadId).toBe(isp.id)
    expect(result.matcher!.confirmed).toBe(false)
  })
})

describe('notes', () => {
  it('a user edit marks the note edited so inference cannot overwrite it', () => {
    const { block } = blockWithSegment(studio.id)
    const after = desk.updateNote(block.id, '  Conflict-state copy unwritten  ')!
    expect(after.reentryNote).toBe('Conflict-state copy unwritten')
    expect(after.noteStatus).toBe('edited')
  })

  it('clearing a note resets it to none', () => {
    const { block } = blockWithSegment(studio.id)
    desk.updateNote(block.id, 'something')
    const after = desk.updateNote(block.id, '   ')!
    expect(after.reentryNote).toBeNull()
    expect(after.noteStatus).toBe('none')
  })
})

describe('answering', () => {
  it('accepts through the service and broadcasts', () => {
    const listener = vi.fn()
    desk.onDeskChanged(listener)
    createQuestion({ kind: 'thread_switch', proposedThreadId: studio.id, resourceSignature: 'sig' })
    const id = getPendingQuestion()!.id

    expect(desk.answerQuestion(id, true)).not.toBeNull()
    expect(listener).toHaveBeenCalled()
  })

  it('returns null for a question that is no longer pending', () => {
    expect(desk.answerQuestion('nope', true)).toBeNull()
  })
})

describe('manual block start', () => {
  it('closes the outgoing block and opens a manual one', () => {
    const first = createBlock({ threadId: studio.id, startedAt: '2026-07-20T09:00:00.000Z' })
    setRuntime({ currentBlockId: first.id, candidateThreadId: isp.id, candidatePresenceSeconds: 90 })

    const block = desk.startBlock(isp.id)

    expect(block.threadId).toBe(isp.id)
    expect(block.source).toBe('manual')
    expect(getBlockDetail(first.id)!.state).toBe('committed')
    expect(getRuntime().currentBlockId).toBe(block.id)
    expect(getRuntime().candidateThreadId).toBeNull()
  })
})

describe('Today', () => {
  it('joins items with their thread links', () => {
    const item = addTodayItem({ title: 'Call the ISP' })
    desk.linkTodoToThread(item.id, isp.id)

    const today = desk.getToday()
    expect(today.items).toHaveLength(1)
    expect(today.items[0].threadId).toBe(isp.id)
  })

  it('unlinking clears the join without deleting the item', () => {
    const item = addTodayItem({ title: 'Call the ISP' })
    desk.linkTodoToThread(item.id, isp.id)
    expect(desk.unlinkTodoFromThread(item.id)).toBe(true)
    expect(desk.getToday().items[0].threadId).toBeNull()
  })

  it('carrying forward is explicit and broadcasts', () => {
    const listener = vi.fn()
    const monday = new Date(2026, 6, 20)
    const tuesday = new Date(2026, 6, 21)
    const item = addTodayItem({ title: 'Unfinished' }, { now: monday })
    desk.onDeskChanged(listener)

    expect(desk.carryTodoForward(item.id, tuesday)).not.toBeNull()
    expect(listener).toHaveBeenCalled()
    expect(desk.getToday(tuesday).items).toHaveLength(1)
  })
})

describe('the rules editor', () => {
  it('lists confirmed matchers by default', () => {
    confirmMatcher({ field: 'title', operator: 'prefix', pattern: 'Studio — Sync', threadId: studio.id })
    writeInferredMatcher({
      field: 'resource', operator: 'exact', pattern: 'sig', threadId: isp.id, confidence: 0.4, example: {},
    })

    expect(desk.getMatchers()).toHaveLength(1)
    expect(desk.getMatchers(false)).toHaveLength(2)
  })

  it('disables and deletes', () => {
    const m = confirmMatcher({ field: 'title', operator: 'prefix', pattern: 'Studio', threadId: studio.id })
    expect(desk.disableMatcher(m.id)!.enabled).toBe(false)
    expect(desk.deleteMatcher(m.id)).toBe(true)
    expect(desk.deleteMatcher(m.id)).toBe(false)
  })
})

describe('thread catalogue', () => {
  it('merges through the service and broadcasts once', () => {
    const listener = vi.fn()
    desk.onDeskChanged(listener)
    const result = desk.mergeThreads(studio.id, isp.id)!
    expect(result.thread.id).toBe(studio.id)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a refused merge does not broadcast', () => {
    const listener = vi.fn()
    desk.onDeskChanged(listener)
    expect(desk.mergeThreads(studio.id, studio.id)).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it('archives and hides', () => {
    desk.archiveThread(isp.id, true)
    expect(desk.getThreads().map(t => t.id)).not.toContain(isp.id)
    expect(desk.getThreads(true).map(t => t.id)).toContain(isp.id)
  })
})
