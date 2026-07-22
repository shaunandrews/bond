import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import { registerApproval } from './approvals'
import { setTurnTransport, startBondTurn, cancelActiveTurn, settleTurns, getActiveTurn, abortActiveTurnForShutdown } from './turns'
import type { TaggedChunk } from '../shared/stream'
import { threadScope } from '../shared/threads'

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

/** A thread row satisfying the FK chain (anchor message must exist first), with a well-formed snapshot. */
function seedThread(id: string, anchorId = `anchor-${id}`) {
  const db = getDb()
  db.prepare("INSERT INTO messages (id, role, text) VALUES (?, 'bond', 'anchor text')").run(anchorId)
  const snapshot = {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    anchorMessageId: anchorId,
    anchorSeq: 1,
    messages: [{ id: anchorId, seq: 1, role: 'bond', text: 'anchor text' }],
  }
  db.prepare(`
    INSERT INTO threads (id, anchor_message_id, context_snapshot, status, created_at, updated_at)
    VALUES (?, ?, ?, 'open', ?, ?)
  `).run(id, anchorId, JSON.stringify(snapshot), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
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

describe('per-scope concurrent scheduling (chat threads)', () => {
  it('runs main and a thread turn at the same time — neither aborts the other', async () => {
    seedThread('thread-1')
    let mainAborted = false
    let threadAborted = false
    let resolveMain!: (v: { succeeded: boolean; piSessionId: string }) => void
    let resolveThread!: (v: { succeeded: boolean; piSessionId: string }) => void

    runBondQueryMock.mockImplementation((_prompt, options) => {
      if (options.turnId === 'main-turn') {
        return new Promise(resolve => {
          resolveMain = resolve
          options.abortSignal.addEventListener('abort', () => { mainAborted = true; resolve({ succeeded: false, piSessionId: 'pi-main' }) })
        })
      }
      return new Promise(resolve => {
        resolveThread = resolve
        options.abortSignal.addEventListener('abort', () => { threadAborted = true; resolve({ succeeded: false, piSessionId: 'pi-thread' }) })
      })
    })

    await startBondTurn({ text: 'main text', turnId: 'main-turn', model: 'balanced' })
    await startBondTurn({ text: 'thread text', turnId: 'thread-turn', model: 'balanced', scope: threadScope('thread-1') })

    // Both still running — starting the thread turn did not touch main.
    expect(mainAborted).toBe(false)
    expect(threadAborted).toBe(false)
    expect(getActiveTurn()?.turnId).toBe('main-turn')
    expect(getActiveTurn(threadScope('thread-1'))?.turnId).toBe('thread-turn')

    resolveMain({ succeeded: true, piSessionId: 'pi-main' })
    resolveThread({ succeeded: true, piSessionId: 'pi-thread' })
    await vi.waitFor(() => {
      expect(turnStatuses().sort()).toEqual(['done', 'done'])
    })

    const mainTurnRow = getDb().prepare('SELECT thread_id FROM turns WHERE id = ?').get('main-turn') as { thread_id: string | null }
    const threadTurnRow = getDb().prepare('SELECT thread_id FROM turns WHERE id = ?').get('thread-turn') as { thread_id: string | null }
    expect(mainTurnRow.thread_id).toBeNull()
    expect(threadTurnRow.thread_id).toBe('thread-1')
  })

  it('cancels only the targeted scope, leaving the other scope running', async () => {
    seedThread('thread-1')
    let mainAborted = false
    runBondQueryMock.mockImplementation((_prompt, options) => new Promise(resolve => {
      if (options.turnId === 'main-turn') {
        options.abortSignal.addEventListener('abort', () => { mainAborted = true; resolve({ succeeded: false, piSessionId: 'pi-main' }) })
      } else {
        options.abortSignal.addEventListener('abort', () => resolve({ succeeded: false, piSessionId: 'pi-thread' }))
      }
    }))

    await startBondTurn({ text: 'main text', turnId: 'main-turn', model: 'balanced' })
    await startBondTurn({ text: 'thread text', turnId: 'thread-turn', model: 'balanced', scope: threadScope('thread-1') })

    await cancelActiveTurn(threadScope('thread-1'))

    expect(mainAborted).toBe(false)
    expect(getActiveTurn()?.turnId).toBe('main-turn')
    expect(getActiveTurn(threadScope('thread-1'))).toBeNull()

    await vi.waitFor(() => {
      expect(getDb().prepare("SELECT status FROM turns WHERE id = 'thread-turn'").get()).toMatchObject({ status: 'cancelled' })
    })
  })

  it('tags every chunk with the turn\'s own scope', async () => {
    seedThread('thread-1')
    await startBondTurn({ text: 'main text', turnId: 'main-turn', model: 'balanced' })
    await startBondTurn({ text: 'thread text', turnId: 'thread-turn', model: 'balanced', scope: threadScope('thread-1') })

    await vi.waitFor(() => {
      expect(chunks.filter(c => c.kind === 'query_end')).toHaveLength(2)
    })

    const mainChunks = chunks.filter(c => c.turnId === 'main-turn')
    const threadChunks = chunks.filter(c => c.turnId === 'thread-turn')
    expect(mainChunks.every(c => c.scope?.type === 'main')).toBe(true)
    expect(threadChunks.every(c => c.scope?.type === 'thread' && c.scope.threadId === 'thread-1')).toBe(true)
  })

  it('a second send in one scope queues behind the first without touching the other scope', async () => {
    seedThread('thread-1')
    let concurrentMain = 0
    let maxConcurrentMain = 0
    runBondQueryMock.mockImplementation((_prompt, options) => new Promise(resolve => {
      if (options.turnId?.startsWith('main')) {
        concurrentMain++
        maxConcurrentMain = Math.max(maxConcurrentMain, concurrentMain)
        const finish = () => { concurrentMain--; resolve({ succeeded: true, piSessionId: 'pi-main' }) }
        if (options.abortSignal.aborted) return finish()
        options.abortSignal.addEventListener('abort', finish, { once: true })
        setTimeout(finish, 20)
      } else {
        resolve({ succeeded: true, piSessionId: 'pi-thread' })
      }
    }))

    await Promise.all([
      startBondTurn({ text: 'main 1', turnId: 'main-1', model: 'balanced' }),
      startBondTurn({ text: 'main 2', turnId: 'main-2', model: 'balanced' }),
      startBondTurn({ text: 'thread 1', turnId: 'thread-1-turn', model: 'balanced', scope: threadScope('thread-1') }),
    ])

    await vi.waitFor(() => {
      expect(turnStatuses().sort()).toEqual(['cancelled', 'done', 'done'])
    })
    // The two main sends never ran concurrently even though a thread send raced in alongside them.
    expect(maxConcurrentMain).toBe(1)
  })

  it('injects the frozen thread context envelope on the first turn only', async () => {
    seedThread('thread-1')
    const envelopes: (string | undefined)[] = []
    runBondQueryMock.mockImplementation(async (_prompt, options) => {
      envelopes.push(options.contextEnvelope)
      return { succeeded: true, piSessionId: options.piSessionId }
    })

    await startBondTurn({ text: 'first', turnId: 'thread-turn-1', model: 'balanced', scope: threadScope('thread-1') })
    await vi.waitFor(() => expect(envelopes).toHaveLength(1))
    await startBondTurn({ text: 'second', turnId: 'thread-turn-2', model: 'balanced', scope: threadScope('thread-1') })
    await vi.waitFor(() => expect(envelopes).toHaveLength(2))

    expect(envelopes[0]).toContain('<bond-thread-context>')
    expect(envelopes[0]).toContain('anchor text')
    expect(envelopes[1]).not.toContain('<bond-thread-context>')

    // Both turns resumed the SAME thread epoch — a thread's Pi session persists across turns.
    const epochIds = getDb().prepare("SELECT DISTINCT epoch_id FROM turns WHERE thread_id = 'thread-1'").all() as Array<{ epoch_id: string }>
    expect(epochIds).toHaveLength(1)
  })

  it('never injects the thread context envelope into a main turn', async () => {
    seedThread('thread-1')
    const envelopes: (string | undefined)[] = []
    runBondQueryMock.mockImplementation(async (_prompt, options) => {
      envelopes.push(options.contextEnvelope)
      return { succeeded: true, piSessionId: options.piSessionId }
    })

    await startBondTurn({ text: 'main message', turnId: 'main-only-turn', model: 'balanced' })
    await vi.waitFor(() => expect(envelopes).toHaveLength(1))
    expect(envelopes[0] ?? '').not.toContain('<bond-thread-context>')
  })
})

describe('shutdown hardening (chat threads)', () => {
  it('abortActiveTurnForShutdown aborts BOTH a running main turn and a running thread turn', async () => {
    seedThread('thread-1')
    let mainAborted = false
    let threadAborted = false
    runBondQueryMock.mockImplementation((_prompt, options) => new Promise(resolve => {
      const onAbort = () => resolve({ succeeded: false, piSessionId: 'pi' })
      if (options.turnId === 'main-turn') { options.abortSignal.addEventListener('abort', () => { mainAborted = true; onAbort() }) }
      else { options.abortSignal.addEventListener('abort', () => { threadAborted = true; onAbort() }) }
    }))

    await startBondTurn({ text: 'main', turnId: 'main-turn', model: 'balanced' })
    await startBondTurn({ text: 'thread', turnId: 'thread-turn', model: 'balanced', scope: threadScope('thread-1') })
    expect(getActiveTurn()?.turnId).toBe('main-turn')
    expect(getActiveTurn(threadScope('thread-1'))?.turnId).toBe('thread-turn')

    abortActiveTurnForShutdown()

    expect(mainAborted).toBe(true)
    expect(threadAborted).toBe(true)
    expect(getActiveTurn()).toBeNull()
    expect(getActiveTurn(threadScope('thread-1'))).toBeNull()
  })

  it('settleTurns (data-dir swap) drains a running main AND a running thread turn together', async () => {
    seedThread('thread-1')
    runBondQueryMock.mockImplementation((_prompt, options) => new Promise(resolve => {
      options.abortSignal.addEventListener('abort', () => resolve({ succeeded: false, piSessionId: 'pi' }), { once: true })
    }))

    await startBondTurn({ text: 'main', turnId: 'main-turn', model: 'balanced' })
    await startBondTurn({ text: 'thread', turnId: 'thread-turn', model: 'balanced', scope: threadScope('thread-1') })

    await settleTurns()

    expect(getActiveTurn()).toBeNull()
    expect(getActiveTurn(threadScope('thread-1'))).toBeNull()
    const statuses = turnStatuses()
    expect(statuses.sort()).toEqual(['cancelled', 'cancelled'])
  })
})

describe('approval and question round trips inside a thread', () => {
  it('parks and clears an approval scoped to a thread turn without touching main', async () => {
    seedThread('thread-1')
    runBondQueryMock.mockImplementationOnce((_prompt, options) => new Promise(resolve => {
      options.abortSignal.addEventListener('abort', () => resolve({ succeeded: false, piSessionId: 'pi-thread' }), { once: true })
    }))

    const result = await startBondTurn({ text: 'needs approval', turnId: 'thread-approval-turn', model: 'balanced', scope: threadScope('thread-1') })
    const { registerApproval, pendingApprovalTurnIds, clearTurnApprovals } = await import('./approvals')
    const parked = registerApproval('req-thread-1', result.turnId)
    expect(pendingApprovalTurnIds()).toContain(result.turnId)

    clearTurnApprovals(result.turnId)
    await expect(parked).resolves.toEqual({ approved: false })

    // Cancelling the thread turn must never touch a hypothetical main approval registry entry.
    expect(pendingApprovalTurnIds()).not.toContain(result.turnId)
  })

  it('a thread turn image attachment saves and reports imageIds exactly like a main turn does', async () => {
    seedThread('thread-1')
    runBondQueryMock.mockResolvedValueOnce({ succeeded: true, piSessionId: 'pi-thread' })

    const result = await startBondTurn({
      text: 'here is a screenshot',
      turnId: 'thread-image-turn',
      model: 'balanced',
      scope: threadScope('thread-1'),
      images: [{ data: 'aGVsbG8=', mediaType: 'image/png' }],
    })

    expect(result.ok).toBe(true)
    expect(result.imageIds?.length).toBe(1)
    // The turn's own user message row must carry the saved image id, scoped to the thread.
    const turnRow = getDb().prepare('SELECT user_message_id FROM turns WHERE id = ?').get('thread-image-turn') as { user_message_id: string }
    const userMessage = getDb().prepare('SELECT image_ids, thread_id FROM messages WHERE id = ?').get(turnRow.user_message_id) as { image_ids: string; thread_id: string | null }
    expect(JSON.parse(userMessage.image_ids)).toEqual(result.imageIds)
    expect(userMessage.thread_id).toBe('thread-1')
  })
})
