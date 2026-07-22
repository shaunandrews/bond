import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../db'
import { setDataDir } from '../paths'
import { MEMORY_RUN_HISTORY, countConsecutiveFailures, findLastFailedRun, getMemoryHealth, listMemoryRuns, recordMemoryRun } from './ledger'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-memory-ledger-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function record(outcome: Parameters<typeof recordMemoryRun>[0]['outcome'], reason?: string): void {
  recordMemoryRun({ kind: 'observer', rangeFrom: 1, rangeTo: 24, outcome, reason })
}

describe('memory ledger', () => {
  it('records runs newest-first with their counts', () => {
    recordMemoryRun({ kind: 'observer', rangeFrom: 1, rangeTo: 24, outcome: 'partial', persistedCount: 2, skippedCount: 1, reason: 'memories[1]: unresolvable sourceIds: 845' })
    recordMemoryRun({ kind: 'reflector', rangeFrom: 25, rangeTo: 60, outcome: 'ok', persistedCount: 3 })

    const runs = listMemoryRuns()
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ kind: 'reflector', outcome: 'ok', persistedCount: 3 })
    expect(runs[1]).toMatchObject({ kind: 'observer', outcome: 'partial', skippedCount: 1 })
  })

  it('counts only trailing failures, stopping at the first success', () => {
    record('parse_failed', 'boom')
    record('ok')
    record('transport_failed', 'socket hang up')
    record('parse_failed', 'No JSON object found')
    expect(countConsecutiveFailures('observer')).toBe(2)
    expect(countConsecutiveFailures('reflector')).toBe(0)
    expect(findLastFailedRun()?.reason).toBe('No JSON object found')
  })

  it('treats partial and empty as non-failures', () => {
    record('parse_failed', 'boom')
    record('partial')
    expect(countConsecutiveFailures('observer')).toBe(0)
  })

  it(`prunes to the newest ${MEMORY_RUN_HISTORY} rows`, () => {
    for (let i = 0; i < MEMORY_RUN_HISTORY + 25; i += 1) record('ok')
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM memory_runs').get() as { n: number }
    expect(count.n).toBeLessThanOrEqual(MEMORY_RUN_HISTORY + 1)
  })

  it('computes lag from the active epoch marker against the transcript', async () => {
    const { createEpoch } = await import('../epochs')
    const { insertTurnStart } = await import('../transcript')
    createEpoch({ id: 'epoch-1', piSessionId: 'pi-1' })
    insertTurnStart({ epochId: 'epoch-1', turnId: 't1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'hi' })
    getDb().prepare('UPDATE epochs SET observed_through_seq = 1 WHERE id = ?').run('epoch-1')

    const health = getMemoryHealth()
    expect(health.maxSeq).toBe(3)
    expect(health.observedThroughSeq).toBe(1)
    expect(health.observerLagSeqs).toBe(2)
  })

  it('THE INCIDENT: reports the freeze instead of looking healthy', () => {
    // The real 2026-07-21 shape: repeated observer rejections over a growing
    // range, working memory frozen at 17:10:21Z, nothing surfaced anywhere.
    for (const range of [[833, 845], [833, 852], [833, 864]]) {
      recordMemoryRun({
        kind: 'observer',
        rangeFrom: range[0],
        rangeTo: range[1],
        outcome: 'parse_failed',
        reason: 'Memory observer rejected output: memories[1] has unknown sourceIds: 845',
      })
    }

    const health = getMemoryHealth()
    expect(health.consecutiveObserverFailures).toBe(3)
    expect(health.lastError).toContain('unknown sourceIds')
    expect(health.lastRuns[0]).toMatchObject({ outcome: 'parse_failed', rangeTo: 864 })
  })

  it('never throws when the write fails', () => {
    getDb().exec('DROP TABLE IF EXISTS memory_runs')
    getDb().exec('CREATE TABLE memory_runs (id INTEGER PRIMARY KEY)')
    expect(() => record('ok')).not.toThrow()
  })
})
