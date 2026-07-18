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
    expect(calculateSoftLimit(200_000)).toBe(160_000)
    expect(calculateSoftLimit(100, { ratio: 0.5 })).toBe(50)
    expect(calculateSoftLimit(0, { fallbackContextWindow: 1_000 })).toBe(800)
  })

  it('ensureActiveEpoch creates an epoch when none exists and reuses it below the soft limit', async () => {
    const first = await ensureActiveEpoch({ piSessionId: 'pi-1', now: '2026-01-01T00:00:00.000Z' })
    expect(first.rolledOver).toBe(false)
    expect(first.epoch.piSessionId).toBe('pi-1')

    const second = await ensureActiveEpoch({ contextTokens: 100, contextWindow: 1_000 })
    expect(second).toMatchObject({ rolledOver: false, softLimit: 800 })
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
      contextTokens: 900,
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

    const result = await ensureActiveEpoch({
      contextTokens: 900,
      contextWindow: 1_000,
      piSessionId: 'pi-2',
      finalObserver: () => { throw new Error('observer down') },
      memoryFlush: () => { throw new Error('flush down') },
      logger: { warn: vi.fn() },
    })

    expect(result.rolledOver).toBe(true)
    expect(result.warnings).toEqual([
      expect.stringContaining('observer down'),
      expect.stringContaining('flush down'),
    ])
    expect(result.epoch.piSessionId).toBe('pi-2')
    const closed = findEpoch('epoch-1')!
    expect(closed.status).toBe('closed')
    expect(closed.observedThroughSeq).toBe(0)
    expect(closed.reflectedThroughSeq).toBe(0)
  })
})
