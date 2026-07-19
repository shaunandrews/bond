import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import { registerApproval } from './approvals'
import { setTurnTransport, startBondTurn, cancelActiveTurn, settleTurns, getActiveTurn } from './turns'
import type { TaggedChunk } from '../shared/stream'

const { runBondQueryMock, scheduleEpochObservationMock } = vi.hoisted(() => ({
  runBondQueryMock: vi.fn(),
  scheduleEpochObservationMock: vi.fn(),
}))

vi.mock('./agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent')>()
  return {
    ...actual,
    runBondQuery: runBondQueryMock,
  }
})

vi.mock('./memory/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./memory/service')>()
  return {
    ...actual,
    scheduleEpochObservation: scheduleEpochObservationMock,
  }
})

let tempDir: string
let chunks: TaggedChunk[]

beforeEach(() => {
  runBondQueryMock.mockReset()
  scheduleEpochObservationMock.mockReset()
  runBondQueryMock.mockResolvedValue({ succeeded: true, piSessionId: 'pi-test', contextTokens: 10, contextWindow: 100 })
  tempDir = mkdtempSync(join(tmpdir(), 'bond-turns-test-'))
  setDataDir(tempDir)
  getDb()
  chunks = []
  setTurnTransport({
    broadcastChunk: (sessionId, chunk, tags) => chunks.push({ ...chunk, ...(sessionId ? { sessionId } : {}), ...tags }),
    imagesChanged: () => {},
  })
})

afterEach(async () => {
  await settleTurns()
  setTurnTransport(null)
  closeDb()
  rmSync(tempDir, { recursive: true, force: true })
  setDataDir(null as never)
})

function turnStatuses(): string[] {
  return (getDb().prepare('SELECT status FROM turns ORDER BY started_at ASC, id ASC').all() as Array<{ status: string }>).map(t => t.status)
}

describe('turn runner serialization', () => {
  it('serializes racing sends — the second aborts the first and queries never overlap', async () => {
    // Regression: two clients (desktop + phone) sending near-simultaneously
    // both passed the old activeQuery check across its await points and ran
    // two concurrent Pi queries against the same epoch session file.
    let concurrent = 0
    let maxConcurrent = 0
    runBondQueryMock.mockImplementation((_prompt, options) => new Promise((resolve) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      let finished = false
      const finish = (succeeded: boolean) => {
        if (finished) return
        finished = true
        concurrent--
        resolve({ succeeded, piSessionId: options.piSessionId })
      }
      if (options.abortSignal.aborted) return finish(false)
      options.abortSignal.addEventListener('abort', () => finish(false), { once: true })
      // A turn nobody aborts finishes successfully on a short timer.
      setTimeout(() => finish(true), 30)
    }))

    const [a, b] = await Promise.all([
      startBondTurn({ text: 'first', turnId: 'race-a', model: 'balanced' }),
      startBondTurn({ text: 'second', turnId: 'race-b', model: 'balanced' }),
    ])
    expect(a.turnId).toBe('race-a')
    expect(b.turnId).toBe('race-b')

    await vi.waitFor(() => {
      expect(turnStatuses().sort()).toEqual(['cancelled', 'done'])
    })
    expect(maxConcurrent).toBe(1)
  })

  it('creates exactly one epoch when two sends race on an empty database', async () => {
    // Pre-fix, both racers passed the null-epoch check and the second
    // createEpoch violated the one_active_epoch unique index.
    await Promise.all([
      startBondTurn({ text: 'first', model: 'balanced' }),
      startBondTurn({ text: 'second', model: 'balanced' }),
    ])
    await settleTurns()

    const count = getDb().prepare('SELECT COUNT(*) AS n FROM epochs').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('denies approvals parked by an aborted turn', async () => {
    runBondQueryMock.mockImplementationOnce((_prompt, options) => new Promise((resolve) => {
      options.abortSignal.addEventListener('abort', () => resolve({ succeeded: false, piSessionId: options.piSessionId }), { once: true })
    }))

    const first = await startBondTurn({ text: 'ask something', turnId: 'approval-turn', model: 'balanced' })
    const parked = registerApproval('req-x', first.turnId)

    await startBondTurn({ text: 'never mind, do this', model: 'balanced' })
    await expect(parked).resolves.toEqual({ approved: false })
  })

  it('cancelActiveTurn aborts the running turn and settles it as cancelled', async () => {
    runBondQueryMock.mockImplementationOnce((_prompt, options) => new Promise((resolve) => {
      options.abortSignal.addEventListener('abort', () => resolve({ succeeded: false, piSessionId: options.piSessionId }), { once: true })
    }))

    await startBondTurn({ text: 'long task', turnId: 'cancel-me', model: 'balanced' })
    expect(getActiveTurn()?.turnId).toBe('cancel-me')

    await cancelActiveTurn()

    expect(getActiveTurn()).toBeNull()
    expect(turnStatuses()).toEqual(['cancelled'])
    expect(chunks.some(c => c.kind === 'query_end' && c.turnId === 'cancel-me')).toBe(true)
  })

  it('persists done and schedules memory observation for a turn that recovered from tool errors', async () => {
    // Regression: any tool_execution_end with isError used to flag the whole
    // turn failed — recovered turns were recorded as failures and their
    // memory observation silently skipped.
    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_tool', name: 'read', toolUseId: 'call-1', summary: '/missing/path' })
      options.onChunk({ kind: 'tool_result', toolName: 'read', toolUseId: 'call-1', output: 'ENOENT', isError: true })
      options.onChunk({ kind: 'assistant_text', text: 'Found it elsewhere — here you go.' })
      return { succeeded: true, piSessionId: options.piSessionId, contextTokens: 42, contextWindow: 100 }
    })

    await startBondTurn({ text: 'read that file for me', turnId: 'recovered-turn', model: 'balanced' })
    await vi.waitFor(() => {
      expect(turnStatuses()).toEqual(['done'])
    })
    expect(scheduleEpochObservationMock).toHaveBeenCalledTimes(1)
  })

  it('broadcasts turn_start, query_start, and query_end in order with tags', async () => {
    await startBondTurn({ text: 'hello', turnId: 'tagged-turn', model: 'balanced' })
    await vi.waitFor(() => {
      expect(chunks.some(c => c.kind === 'query_end' && c.turnId === 'tagged-turn')).toBe(true)
    })

    const kinds = chunks.filter(c => c.turnId === 'tagged-turn').map(c => c.kind)
    expect(kinds[0]).toBe('turn_start')
    expect(kinds).toContain('query_start')
    expect(kinds[kinds.length - 1]).toBe('query_end')
  })
})
