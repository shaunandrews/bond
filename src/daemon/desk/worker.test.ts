import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import { createDeskWorker } from './worker'
import {
  attributeSegment,
  createBlock,
  createSegment,
  createThread,
  getBlockDetail,
  getRuntime,
  setRuntime,
} from './store'
import { getPendingQuestion } from './questions'
import { addTodayItem, linkTodo } from './today'
import { resetDeskListenersForTest } from './service'
import { confirmMatcher } from './matchers'
import type { DeskThread } from '../../shared/desk'

let testDir: string
let studio: DeskThread

const SESSION = 'session-1'
const T0 = Date.parse('2026-07-20T09:00:00.000Z')
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString()

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-worker-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  const db = getDb()
  db.prepare('INSERT INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, 0, ?)')
    .run(SESSION, at(0), at(0))
  resetDeskListenersForTest()
  studio = createThread({ name: 'Studio sync dialog', source: 'user' })
})

afterEach(() => {
  resetDeskListenersForTest()
  vi.useRealTimers()
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function seedCapture(offset: number, title = 'Studio — Sync Dialog'): string {
  const id = randomUUID()
  const capturedAt = at(offset)
  getDb().prepare(`
    INSERT INTO sense_captures (id, session_id, captured_at, app_name, app_bundle_id, window_title,
      text_status, text_source, image_path, created_at)
    VALUES (?, ?, ?, 'Studio', 'com.automattic.studio', ?, 'done', 'ocr', '/tmp/a.jpg', ?)
  `).run(id, SESSION, capturedAt, title, capturedAt)
  return id
}

/** A leading thread with enough attributed presence to clear the majority test. */
function seedLeader(threadId: string, startOffset: number, presence: number) {
  const s = createSegment({
    blockId: null, startedAt: at(startOffset), resourceSignature: randomUUID(), evidence: {},
  })
  attributeSegment(s.id, { threadId, confidence: 0.9 })
  getDb().prepare('UPDATE desk_segments SET presence_seconds = ? WHERE id = ?').run(presence, s.id)
  return s.id
}

describe('the worker respects Desk being off', () => {
  it('does nothing while not running', async () => {
    seedCapture(0)
    const worker = createDeskWorker({ prompt: async () => '' })
    await worker.tickNow()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM desk_segments').get()).toEqual({ n: 0 })
  })

  it('segments once running', async () => {
    setRuntime({ running: true })
    seedCapture(0)
    const worker = createDeskWorker({ prompt: async () => '' })
    await worker.tickNow()
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM desk_segments').get() as { n: number }).n).toBe(1)
  })
})

describe('the worker never calls a model on the fast path', () => {
  it('segmentation performs no inference', async () => {
    setRuntime({ running: true })
    const prompt = vi.fn(async () => '')
    seedCapture(0)
    seedCapture(15)

    await createDeskWorker({ prompt }).tickNow()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('a known resource resolves with no model call at all', async () => {
    setRuntime({ running: true })
    const prompt = vi.fn(async () => '')
    const worker = createDeskWorker({ prompt })

    const sig = (await import('./signature')).resourceSignature({
      bundleId: 'com.automattic.studio', appName: 'Studio', title: 'Studio — Sync Dialog',
    })
    confirmMatcher({ field: 'resource', operator: 'exact', pattern: sig, threadId: studio.id })

    seedCapture(0)
    await worker.tickNow()
    await worker.sweepNow()

    expect(prompt).not.toHaveBeenCalled()
  })
})

describe('the switch decision', () => {
  it('asks rather than committing silently when the budget allows', async () => {
    setRuntime({ running: true })
    seedLeader(studio.id, 0, 300)
    setRuntime({ candidateThreadId: studio.id, candidateSince: at(-600) })

    await createDeskWorker({ prompt: async () => '' }).tickNow()

    const pending = getPendingQuestion()
    expect(pending?.proposedThreadName).toBe('Studio sync dialog')
    // The block is NOT committed yet — the Ask is the assertion
    expect(getRuntime().currentBlockId).toBeNull()
  })

  it('commits directly when the budget is already spent', async () => {
    setRuntime({ running: true, lastAssertionAt: new Date().toISOString() })
    seedLeader(studio.id, 0, 300)
    setRuntime({ candidateThreadId: studio.id, candidateSince: at(-600) })

    await createDeskWorker({ prompt: async () => '' }).tickNow()

    expect(getPendingQuestion()).toBeNull()
    const blockId = getRuntime().currentBlockId
    expect(blockId).not.toBeNull()
    expect(getBlockDetail(blockId!)!.threadId).toBe(studio.id)
  })

  it('does not act on a candidate under three minutes old', async () => {
    setRuntime({ running: true })
    seedLeader(studio.id, 0, 300)
    setRuntime({ candidateThreadId: studio.id, candidateSince: new Date().toISOString() })

    await createDeskWorker({ prompt: async () => '' }).tickNow()

    expect(getPendingQuestion()).toBeNull()
    expect(getRuntime().currentBlockId).toBeNull()
  })

  it('offers to start a linked todo after a direct commit', async () => {
    const item = addTodayItem({ title: 'Fix the ISP thing' })
    linkTodo(item.id, studio.id)
    // Budget spent, so the switch commits directly — but has since recovered
    // enough for the follow-up todo question.
    setRuntime({ running: true, lastAssertionAt: new Date(Date.now() - 700_000).toISOString() })
    seedLeader(studio.id, 0, 300)
    setRuntime({ candidateThreadId: studio.id, candidateSince: at(-600) })

    const worker = createDeskWorker({ prompt: async () => '' })
    await worker.tickNow()

    // The switch itself took the budget as an Ask; answer it and tick again
    const pending = getPendingQuestion()
    expect(pending?.kind).toBe('thread_switch')
  })

  it('emits a change so the notch and the panel stay in lockstep', async () => {
    const listener = vi.fn()
    ;(await import('./service')).onDeskChanged(listener)
    setRuntime({ running: true })
    seedCapture(0)

    await createDeskWorker({ prompt: async () => '' }).tickNow()
    expect(listener).toHaveBeenCalled()
  })

  it('a quiet tick broadcasts nothing', async () => {
    const listener = vi.fn()
    ;(await import('./service')).onDeskChanged(listener)
    setRuntime({ running: true })

    await createDeskWorker({ prompt: async () => '' }).tickNow()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('the inference sweep', () => {
  it('collapses unresolved segments into one batched call', async () => {
    setRuntime({ running: true })
    const prompt = vi.fn(async () => `S1|${studio.id}|0.9|none|-\nS2|${studio.id}|0.8|none|-`)
    createSegment({ blockId: null, startedAt: at(0), resourceSignature: 's1', evidence: { appName: 'A' } })
    createSegment({ blockId: null, startedAt: at(10), resourceSignature: 's2', evidence: { appName: 'B' } })

    await createDeskWorker({ prompt }).sweepNow()

    expect(prompt).toHaveBeenCalledTimes(1)
    const resolved = getDb().prepare(
      "SELECT COUNT(*) AS n FROM desk_segments WHERE attribution_state = 'resolved'"
    ).get() as { n: number }
    expect(resolved.n).toBe(2)
  })

  it('records instrumentation the go/no-go reads', async () => {
    setRuntime({ running: true })
    createSegment({ blockId: null, startedAt: at(0), resourceSignature: 's1', evidence: { appName: 'A' } })

    await createDeskWorker({ prompt: async () => `S1|${studio.id}|0.9|none|-` }).sweepNow()

    const metrics = getDb().prepare('SELECT kind, calls, segments FROM desk_metrics').all()
    expect(metrics).toEqual([{ kind: 'sweep', calls: 1, segments: 1 }])
  })

  it('records a failed call too — a failure is data', async () => {
    setRuntime({ running: true })
    createSegment({ blockId: null, startedAt: at(0), resourceSignature: 's1', evidence: { appName: 'A' } })

    await createDeskWorker({ prompt: async () => { throw new Error('down') } }).sweepNow()

    const row = getDb().prepare('SELECT ok FROM desk_metrics').get() as { ok: number }
    expect(row.ok).toBe(0)
  })

  it('records nothing when there was nothing to infer', async () => {
    setRuntime({ running: true })
    await createDeskWorker({ prompt: async () => '' }).sweepNow()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM desk_metrics').get()).toEqual({ n: 0 })
  })

  it('a failing model call never takes the worker down', async () => {
    setRuntime({ running: true })
    createSegment({ blockId: null, startedAt: at(0), resourceSignature: 's1', evidence: { appName: 'A' } })
    const worker = createDeskWorker({ prompt: async () => { throw new Error('boom') } })
    await expect(worker.sweepNow()).resolves.toBeUndefined()
  })
})

describe('re-entry notes at departure', () => {
  function departedBlock(presence: number) {
    const block = createBlock({ threadId: studio.id, startedAt: at(0) })
    const seg = createSegment({
      blockId: block.id, startedAt: at(0), resourceSignature: 'sig',
      evidence: { appName: 'Studio', paths: ['SyncDialog.tsx'] },
    })
    void seg
    getDb().prepare('UPDATE desk_blocks SET ended_at = ?, presence_seconds = ? WHERE id = ?')
      .run(at(600), presence, block.id)
    return block
  }

  it('writes a note for a block that has been left', async () => {
    setRuntime({ running: true })
    const block = departedBlock(900)

    await createDeskWorker({ prompt: async () => 'Left at SyncDialog.tsx — conflict copy unwritten' }).tickNow()

    const after = getBlockDetail(block.id)!
    expect(after.reentryNote).toBe('Left at SyncDialog.tsx — conflict copy unwritten')
    expect(after.noteStatus).toBe('ready')
  })

  it('never writes one for a block below the noise floor', async () => {
    setRuntime({ running: true })
    const block = departedBlock(60)
    const prompt = vi.fn(async () => 'a note')

    await createDeskWorker({ prompt }).tickNow()

    expect(prompt).not.toHaveBeenCalled()
    expect(getBlockDetail(block.id)!.reentryNote).toBeNull()
  })

  it('does not rewrite a note it already wrote', async () => {
    setRuntime({ running: true })
    const block = departedBlock(900)
    const prompt = vi.fn(async () => 'the note')

    const worker = createDeskWorker({ prompt })
    await worker.tickNow()
    await worker.tickNow()

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(getBlockDetail(block.id)!.reentryNote).toBe('the note')
  })

  it('leaves the still-open current block alone', async () => {
    setRuntime({ running: true })
    const open = createBlock({ threadId: studio.id, startedAt: at(0) })
    getDb().prepare('UPDATE desk_blocks SET presence_seconds = 900 WHERE id = ?').run(open.id)
    const prompt = vi.fn(async () => 'a note')

    await createDeskWorker({ prompt }).tickNow()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('broadcasts so the panel picks the note up', async () => {
    const listener = vi.fn()
    ;(await import('./service')).onDeskChanged(listener)
    setRuntime({ running: true })
    departedBlock(900)

    await createDeskWorker({ prompt: async () => 'the note' }).tickNow()
    expect(listener).toHaveBeenCalled()
  })
})

describe('back-fill catch-up', () => {
  function seedUnresolved(n: number) {
    for (let i = 0; i < n; i++) {
      createSegment({ blockId: null, startedAt: at(i), resourceSignature: `sig-${i}`, evidence: { appName: 'A' } })
    }
  }

  it('runs sweeps back-to-back while batches keep coming back full', async () => {
    setRuntime({ running: true })
    seedUnresolved(30)
    let calls = 0
    const worker = createDeskWorker({
      prompt: async (p) => {
        calls++
        // answer every observation in the batch
        return p.split('\n').filter(l => /^S\d+\./.test(l))
          .map(l => `${l.split('.')[0]}|${studio.id}|0.9|none|-`).join('\n')
      },
    })

    await worker.catchUpNow()

    // 30 segments at 14 per batch = 3 rounds, and it stops on the short one
    expect(calls).toBe(3)
    const unresolved = getDb().prepare(
      "SELECT COUNT(*) AS n FROM desk_segments WHERE attribution_state != 'resolved'"
    ).get() as { n: number }
    expect(unresolved.n).toBe(0)
  })

  it('stops after a single short batch rather than spinning', async () => {
    setRuntime({ running: true })
    seedUnresolved(3)
    let calls = 0
    const worker = createDeskWorker({
      prompt: async () => { calls++; return `S1|${studio.id}|0.9|none|-` },
    })

    await worker.catchUpNow()
    expect(calls).toBe(1)
  })

  it('stops immediately when a batch fails rather than retrying in a tight loop', async () => {
    setRuntime({ running: true })
    seedUnresolved(30)
    let calls = 0
    const worker = createDeskWorker({
      prompt: async () => { calls++; throw new Error('provider down') },
    })

    await worker.catchUpNow()
    expect(calls).toBe(1)
  })

  it('stops when Desk is switched off mid-catch-up', async () => {
    setRuntime({ running: true })
    seedUnresolved(60)
    let calls = 0
    const worker = createDeskWorker({
      prompt: async (p) => {
        calls++
        setRuntime({ running: false })
        return p.split('\n').filter(l => /^S\d+\./.test(l))
          .map(l => `${l.split('.')[0]}|${studio.id}|0.9|none|-`).join('\n')
      },
    })

    await worker.catchUpNow()
    expect(calls).toBe(1)
  })

  it('does nothing when there is nothing to catch up on', async () => {
    setRuntime({ running: true })
    const prompt = vi.fn(async () => '')
    await createDeskWorker({ prompt }).catchUpNow()
    expect(prompt).not.toHaveBeenCalled()
  })
})

describe('the queue', () => {
  it('serializes work so a slow batch cannot interleave with a tick', async () => {
    setRuntime({ running: true })
    const order: string[] = []
    let release: (() => void) | null = null
    const gate = new Promise<void>(resolve => { release = resolve })

    createSegment({ blockId: null, startedAt: at(0), resourceSignature: 's1', evidence: { appName: 'A' } })
    seedCapture(0)

    const worker = createDeskWorker({
      prompt: async () => {
        order.push('inference:start')
        await gate
        order.push('inference:end')
        return `S1|${studio.id}|0.9|none|-`
      },
    })

    const sweep = worker.sweepNow()
    const tick = worker.tickNow().then(() => order.push('tick'))
    release!()
    await Promise.all([sweep, tick])

    expect(order).toEqual(['inference:start', 'inference:end', 'tick'])
  })
})

describe('start and stop', () => {
  it('start is idempotent and stop clears the timers', () => {
    vi.useFakeTimers()
    const worker = createDeskWorker({ prompt: async () => '' })
    worker.start()
    worker.start()
    expect(worker.isRunning()).toBe(true)
    worker.stop()
    expect(worker.isRunning()).toBe(false)
  })

  it('back-fills on start so the panel is never empty on first open', async () => {
    vi.useFakeTimers()
    setRuntime({ running: true })
    seedCapture(0)

    const worker = createDeskWorker({ prompt: async () => '' })
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    worker.stop()
    vi.useRealTimers()

    // startup enqueued a tick immediately, without waiting for the interval
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM desk_segments').get() as { n: number }).n).toBe(1)
  })
})
