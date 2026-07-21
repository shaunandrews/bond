/**
 * The Desk worker — two loops, one serialized queue.
 *
 * Clones two existing patterns rather than inventing a third:
 *  - `sense/worker.ts` for poll → batch → mark. (Desk skips that file's FTS
 *    `safeUpdate` workaround: it never updates FTS-backed text.)
 *  - `memory/service.ts` for the serialized queue and a checkpoint advanced
 *    only after a successful transaction.
 *
 * **No scheduler.** `plans/bond-jobs.md` specs a jobs table and tick loop and
 * remains unimplemented; a `setInterval` matches the existing hourly retention
 * sweep in `sense/storage.ts`.
 */
import { runPiTextPrompt } from '../pi/runtime'
import { getRuntime, listBlocksAwaitingNote, requeueStaleSegments } from './store'
import { commitSwitch, evaluateSwitch, ingestCaptures } from './segmenter'
import {
  IMMEDIATE_CALLS_PER_HOUR,
  immediateBudgetRemaining,
  recordMetrics,
  runInferenceBatch,
  type TextPrompt,
} from './inference'
import { assertionAllowed, createQuestion, expireQuestions } from './questions'
import { pruneOverbroadMatchers } from './matchers'
import { generateReentryNote } from './notes'
import { emitDeskChanged } from './service'
import { unfinishedTodosForThread } from './today'
import { getDb } from '../db'
import { DESK_TIMING } from '../../shared/desk'

/** Fast segmentation: metadata only, no model call. */
const SEGMENT_INTERVAL_MS = 2_000
/** The batched-summary cadence the cost model is built on. */
const SWEEP_INTERVAL_MS = 15 * 60_000
/** Must match inference.ts's batch limit — a full batch means more are waiting. */
const BATCH_SEGMENTS = 14
/** Hard ceiling on one catch-up chain, so back-fill can never run away. */
const MAX_BACKFILL_ROUNDS = 200

export interface DeskWorkerOptions {
  prompt?: TextPrompt
  segmentIntervalMs?: number
  sweepIntervalMs?: number
}

export interface DeskWorker {
  start(): void
  stop(): void
  /** Run one segmentation tick now (tests, manual trigger). */
  tickNow(): Promise<void>
  /** Run one inference sweep now. */
  sweepNow(): Promise<void>
  /** Run sweeps back-to-back until caught up (bounded). */
  catchUpNow(): Promise<void>
  isRunning(): boolean
}

export function createDeskWorker(options: DeskWorkerOptions = {}): DeskWorker {
  const prompt: TextPrompt = options.prompt ?? runPiTextPrompt
  let segmentTimer: ReturnType<typeof setInterval> | null = null
  let sweepTimer: ReturnType<typeof setInterval> | null = null

  // One serialized queue for everything that writes, so a slow inference batch
  // can never interleave with a segmentation tick.
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch(error => {
      console.error('[desk/worker] task failed:', error)
    })
    return queue
  }

  async function segmentTick(): Promise<void> {
    // Desk may hold historical threads while Sense is off, but it accumulates
    // no presence and generates no inference in that state.
    if (!getRuntime().running) return

    const ingested = ingestCaptures()
    const expired = expireQuestions()
    let changed = ingested.capturesProcessed > 0 || expired.length > 0

    const decision = evaluateSwitch()
    if (decision.kind === 'switch') {
      changed = true
      await handleSwitch(decision.threadId, decision.sinceIso)
    }

    if (changed) emitDeskChanged()
    await writeDepartureNotes()
  }

  /**
   * A stable candidate either asks or commits. It asks when the budget allows
   * — silence then commits it a few minutes later. It commits directly when the
   * budget is spent, because a switch Desk is confident about should not be
   * lost just because it could not speak.
   */
  async function handleSwitch(threadId: string, sinceIso: string): Promise<void> {
    const runtime = getRuntime()
    const signature = runtime.candidateResourceSignature

    if (assertionAllowed()) {
      const asked = createQuestion({
        kind: 'thread_switch',
        proposedThreadId: threadId,
        blockId: runtime.currentBlockId,
        resourceSignature: signature,
      })
      if (asked.ok) return
    }

    commitSwitch(threadId, { sinceIso, source: 'inferred', confidence: 0.6 })
    await maybeAskAboutTodo(threadId)
  }

  /**
   * Notes are written **at departure, in the present tense of the work** — not
   * reconstructed later from a day summary. That constraint is the whole reason
   * this belongs in a live panel rather than an end-of-day report.
   *
   * Driven off a query so every departure route is covered: a smoothed switch,
   * an accepted Ask, an expired Ask, a manual start.
   */
  async function writeDepartureNotes(): Promise<void> {
    const pending = listBlocksAwaitingNote({ noiseFloorSeconds: DESK_TIMING.noiseFloorSeconds })
    if (pending.length === 0) return
    for (const block of pending) {
      const result = await generateReentryNote(block.id, { prompt })
      if (result.status === 'ready') emitDeskChanged()
    }
  }

  /**
   * "Looks like you're on the ISP thing — mark it started?" — the one place
   * the inferred and intentional lists meet, under the same global budget.
   */
  async function maybeAskAboutTodo(threadId: string): Promise<void> {
    if (!assertionAllowed()) return
    const todos = unfinishedTodosForThread(threadId)
    const pending = todos.find(item => item.data.status === 'todo')
    if (!pending) return
    createQuestion({ kind: 'todo_started', itemId: pending.id, blockId: getRuntime().currentBlockId })
  }

  async function runBatch(kind: 'immediate' | 'sweep'): Promise<boolean> {
    const nowIso = new Date().toISOString()
    if (kind === 'immediate' && immediateBudgetRemaining(nowIso) <= 0) return false

    const result = await runInferenceBatch({ prompt, kind })
    if (result.segments === 0) return false

    recordMetrics(kind, result, nowIso, getDb())
    if (result.problems.length > 0) {
      console.warn(`[desk/worker] inference problems (${kind}):`, result.problems.slice(0, 5))
    }
    if (result.resolved > 0) emitDeskChanged()
    // A full batch that mostly succeeded means more are waiting behind it.
    return result.ok && result.segments >= BATCH_SEGMENTS
  }

  /**
   * Catch up on a Sense history that predates Desk.
   *
   * "It is not empty" is the moment that sells the feature, and one batch per
   * 15 minutes does not deliver it: three days of existing captures segment
   * into ~1600 unknowns, which at that cadence is over a day of waiting. So
   * while a sweep keeps coming back full, run the next one straight away.
   *
   * Bounded hard: the chain stops the moment a batch is short, fails, or the
   * round cap is hit, so a pathological store cannot turn this into an
   * unbounded spend. The cap resets on the next scheduled sweep.
   */
  async function catchUp(): Promise<void> {
    for (let round = 0; round < MAX_BACKFILL_ROUNDS; round++) {
      if (!getRuntime().running) return
      const more = await runBatch('sweep')
      if (!more) return
    }
    console.log(`[desk/worker] back-fill hit its ${MAX_BACKFILL_ROUNDS}-round cap; resuming on the normal sweep`)
  }

  return {
    start(): void {
      if (segmentTimer) return
      console.log('[desk/worker] starting')
      // A batch that died mid-flight (crash, restart, hung provider) left its
      // segments on `queued`, where nothing can see them again. Same recovery
      // as sense/worker.ts's requeueStale.
      const requeued = requeueStaleSegments()
      if (requeued > 0) console.log(`[desk/worker] requeued ${requeued} stranded segment(s)`)
      // Self-heal: drop inferred matchers too broad to have been written.
      const pruned = pruneOverbroadMatchers()
      if (pruned.deleted > 0) {
        console.log(`[desk/worker] pruned ${pruned.deleted} over-broad matcher(s):`, pruned.reasons.slice(0, 5))
      }
      segmentTimer = setInterval(() => { enqueue(segmentTick) }, options.segmentIntervalMs ?? SEGMENT_INTERVAL_MS)
      segmentTimer.unref?.()
      sweepTimer = setInterval(() => { enqueue(catchUp) }, options.sweepIntervalMs ?? SWEEP_INTERVAL_MS)
      sweepTimer.unref?.()
      // Startup back-fill: catch up on everything Sense already recorded so the
      // panel is never empty on first open.
      enqueue(segmentTick)
      enqueue(catchUp)
    },

    stop(): void {
      if (segmentTimer) { clearInterval(segmentTimer); segmentTimer = null }
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
    },

    tickNow: () => enqueue(segmentTick),
    sweepNow: () => enqueue(async () => { await runBatch('sweep') }),
    catchUpNow: () => enqueue(catchUp),
    isRunning: () => segmentTimer !== null,
  }
}

export { IMMEDIATE_CALLS_PER_HOUR }
