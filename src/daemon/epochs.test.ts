import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { closeDb, getDb } from './db'
import { ensureTranscriptSchema, insertTurnStart, upsertMessages } from './transcript'
import {
  calculateSoftLimit,
  closeEpoch,
  createEpoch,
  ensureActiveEpoch,
  findActiveEpoch,
  findEpoch,
} from './epochs'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-epochs-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  ensureTranscriptSchema()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('epoch store', () => {
  it('creates, finds, and closes epoch rows', () => {
    const epoch = createEpoch({ id: 'epoch-1', piSessionId: 'pi-1', piSessionFile: '/tmp/pi.jsonl', now: '2026-01-01T00:00:00.000Z' })

    expect(epoch).toMatchObject({
      id: 'epoch-1',
      piSessionId: 'pi-1',
      piSessionFile: '/tmp/pi.jsonl',
      status: 'active',
      startedAt: '2026-01-01T00:00:00.000Z',
      contextTokens: 0,
      contextWindow: 0,
      observedThroughSeq: 0,
      reflectedThroughSeq: 0,
    })
    expect(findEpoch('epoch-1')?.id).toBe('epoch-1')
    expect(findActiveEpoch()?.id).toBe('epoch-1')

    const closed = closeEpoch({ id: 'epoch-1', reason: 'test_done', now: '2026-01-01T01:00:00.000Z' })
    expect(closed).toMatchObject({ status: 'closed', endedAt: '2026-01-01T01:00:00.000Z', endReason: 'test_done' })
    expect(findActiveEpoch()).toBeNull()
  })

  it('calculates a soft context limit with a deterministic fallback', () => {
    expect(calculateSoftLimit(200_000)).toBe(184_000)
    expect(calculateSoftLimit(100, { ratio: 0.5 })).toBe(50)
    expect(calculateSoftLimit(0, { fallbackContextWindow: 1_000 })).toBe(920)
  })

  it('ensureActiveEpoch creates an epoch when none exists and reuses it below the soft limit', async () => {
    const first = await ensureActiveEpoch({ piSessionId: 'pi-1', now: '2026-01-01T00:00:00.000Z' })
    expect(first.rolledOver).toBe(false)
    expect(first.epoch.piSessionId).toBe('pi-1')

    const second = await ensureActiveEpoch({ contextTokens: 100, contextWindow: 1_000 })
    expect(second).toMatchObject({ rolledOver: false, softLimit: 920 })
    expect(second.epoch.id).toBe(first.epoch.id)
    expect(second.epoch.contextTokens).toBe(100)
    expect(second.epoch.contextWindow).toBe(1_000)
  })

  it('rolls over at the soft limit after final observing and memory flushing transcript ranges', async () => {
    createEpoch({ id: 'epoch-1', piSessionId: 'pi-1' })
    insertTurnStart({ epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'alpha' })
    upsertMessages([{ id: 'b1', role: 'bond', epochId: 'epoch-1', turnId: 'turn-1', text: 'omega' }])

    const finalObserver = vi.fn()
    const memoryFlush = vi.fn()
    const result = await ensureActiveEpoch({
      contextTokens: 950,
      contextWindow: 1_000,
      piSessionId: 'pi-2',
      now: '2026-01-01T02:00:00.000Z',
      finalObserver,
      memoryFlush,
    })

    expect(result.rolledOver).toBe(true)
    expect(result.previousEpoch).toMatchObject({ id: 'epoch-1', status: 'closed', endReason: 'context_soft_limit' })
    expect(result.epoch).toMatchObject({ status: 'active', piSessionId: 'pi-2' })
    expect(finalObserver).toHaveBeenCalledWith(expect.objectContaining({ epoch: expect.objectContaining({ id: 'epoch-1' }), fromSeq: 1, toSeq: 3 }))
    expect(memoryFlush).toHaveBeenCalledWith(expect.objectContaining({ fromSeq: 1, toSeq: 3, messages: expect.arrayContaining([expect.objectContaining({ id: 'u1' })]) }))

    const closed = findEpoch('epoch-1')!
    expect(closed.observedThroughSeq).toBe(3)
    expect(closed.reflectedThroughSeq).toBe(3)
  })

  it('falls back to rollover when observer hooks fail and leaves failed markers unadvanced', async () => {
    createEpoch({ id: 'epoch-1', piSessionId: 'pi-1' })
    insertTurnStart({ epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'alpha' })

    const warn = vi.fn()
    const result = await ensureActiveEpoch({
      contextTokens: 950,
      contextWindow: 1_000,
      piSessionId: 'pi-2',
      finalObserver: () => { throw new Error('observer down') },
      memoryFlush: () => { throw new Error('flush down') },
      logger: { warn },
    })

    expect(result.rolledOver).toBe(true)
    // Failures are reported through the logger and the memory ledger, not a
    // returned array nobody read (always [] on the deferred production path).
    expect(warn.mock.calls.flat().join(' ')).toContain('observer down')
    expect(warn.mock.calls.flat().join(' ')).toContain('flush down')
    expect(result.epoch.piSessionId).toBe('pi-2')
    const closed = findEpoch('epoch-1')!
    expect(closed.status).toBe('closed')
    expect(closed.observedThroughSeq).toBe(0)
    expect(closed.reflectedThroughSeq).toBe(0)
  })
})

describe('epoch marker seeding', () => {
  it('seeds both markers at the transcript high-water mark', () => {
    // Regression: markers defaulted to 0, so every new epoch re-observed the
    // entire transcript from seq 1 — 521 messages / ~38k tokens in the measured
    // case, growing with every rollover, forever.
    createEpoch({ id: 'epoch-0', piSessionId: 'pi-0' })
    insertTurnStart({ epochId: 'epoch-0', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'alpha' })
    closeEpoch('epoch-0')

    const next = createEpoch({ id: 'epoch-1', piSessionId: 'pi-1' })
    expect(next.observedThroughSeq).toBe(3)
    expect(next.reflectedThroughSeq).toBe(3)
  })

  it('seeds 0 on an empty database', () => {
    expect(createEpoch({ id: 'epoch-fresh' }).observedThroughSeq).toBe(0)
  })

  it('hands off with no gap and no overlap across a rollover', async () => {
    createEpoch({ id: 'epoch-1', piSessionId: 'pi-1' })
    insertTurnStart({ epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'alpha' })

    const ranges: Array<{ fromSeq: number; toSeq: number }> = []
    const result = await ensureActiveEpoch({
      contextTokens: 950,
      contextWindow: 1_000,
      piSessionId: 'pi-2',
      finalObserver: ({ fromSeq, toSeq }) => { ranges.push({ fromSeq, toSeq }) },
      memoryFlush: ({ fromSeq, toSeq }) => { ranges.push({ fromSeq, toSeq }) },
    })

    // The closing epoch's hook range ends exactly where the new epoch starts.
    expect(ranges).toEqual([{ fromSeq: 1, toSeq: 3 }, { fromSeq: 1, toSeq: 3 }])
    expect(result.epoch.observedThroughSeq).toBe(3)
    expect(result.epoch.reflectedThroughSeq).toBe(3)
  })
})

describe('deferred rollover hook work', () => {
  it('swaps epochs immediately and defers hook work when deferHookWork is provided', async () => {
    createEpoch({ id: 'epoch-1', piSessionId: 'pi-1' })
    insertTurnStart({ epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'alpha' })

    const finalObserver = vi.fn()
    const memoryFlush = vi.fn()
    const deferred: Array<() => Promise<void>> = []

    const result = await ensureActiveEpoch({
      contextTokens: 950,
      contextWindow: 1_000,
      piSessionId: 'pi-2',
      finalObserver,
      memoryFlush,
      deferHookWork: (task) => deferred.push(task),
    })

    // Swap already happened; hooks have not run and markers are untouched.
    expect(result.rolledOver).toBe(true)
    expect(result.epoch.piSessionId).toBe('pi-2')
    expect(findActiveEpoch()!.piSessionId).toBe('pi-2')
    expect(deferred).toHaveLength(1)
    expect(finalObserver).not.toHaveBeenCalled()
    expect(memoryFlush).not.toHaveBeenCalled()
    expect(findEpoch('epoch-1')!.observedThroughSeq).toBe(0)

    await deferred[0]()

    expect(finalObserver).toHaveBeenCalledWith(expect.objectContaining({ epoch: expect.objectContaining({ id: 'epoch-1' }), fromSeq: 1, toSeq: 3 }))
    expect(memoryFlush).toHaveBeenCalledWith(expect.objectContaining({ fromSeq: 1, toSeq: 3 }))
    const closed = findEpoch('epoch-1')!
    expect(closed.observedThroughSeq).toBe(3)
    expect(closed.reflectedThroughSeq).toBe(3)
  })

  it('deferred hook work re-reads markers advanced since scheduling', async () => {
    createEpoch({ id: 'epoch-1', piSessionId: 'pi-1' })
    insertTurnStart({ epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'alpha' })

    const finalObserver = vi.fn()
    const deferred: Array<() => Promise<void>> = []
    await ensureActiveEpoch({
      contextTokens: 950,
      contextWindow: 1_000,
      finalObserver,
      deferHookWork: (task) => deferred.push(task),
    })

    // A background observation advanced the marker between swap and run.
    getDb().prepare('UPDATE epochs SET observed_through_seq = 2 WHERE id = ?').run('epoch-1')
    await deferred[0]()

    expect(finalObserver).toHaveBeenCalledWith(expect.objectContaining({ fromSeq: 3, toSeq: 3 }))
  })
})
