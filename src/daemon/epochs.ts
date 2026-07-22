import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from './db'
import { ensureTranscriptSchema, getMessagesForRange } from './transcript'
import type { TranscriptMessage } from '../shared/transcript'

export const DEFAULT_CONTEXT_WINDOW = 200_000
/**
 * Pi compacts its own session IN PLACE and the session survives — measured
 * firing at 75.3% of the window with a better summary than Bond's handoff.
 * Bond's rollover at 0.8 was pre-empting it to solve the same problem worse:
 * it kills the session outright and hands the successor a prose tail. At 0.92
 * rollover only fires if Pi's compaction fails to keep up — a genuine backstop.
 */
export const DEFAULT_SOFT_LIMIT_RATIO = 0.92

export type EpochStatus = 'active' | 'closed'

export interface Epoch {
  id: string
  piSessionId: string
  piSessionFile: string | null
  /** null means the main conversation. */
  threadId: string | null
  status: EpochStatus
  startedAt: string
  endedAt: string | null
  endReason: string | null
  contextTokens: number
  contextWindow: number
  observedThroughSeq: number
  reflectedThroughSeq: number
}

export interface CreateEpochInput {
  id?: string
  piSessionId?: string
  piSessionFile?: string | null
  /** null/omitted means the main conversation. */
  threadId?: string | null
  now?: string
}

export interface CloseEpochInput {
  id: string
  reason?: string | null
  now?: string
}

export interface EpochHookContext {
  epoch: Epoch
  fromSeq: number
  toSeq: number
  messages: TranscriptMessage[]
}

export type EpochHook = (context: EpochHookContext) => void | Promise<void>

export interface EnsureActiveEpochOptions {
  /** null/omitted means the main conversation. */
  threadId?: string | null
  contextTokens?: number | null
  contextWindow?: number | null
  softLimitRatio?: number
  fallbackContextWindow?: number
  rolloverReason?: string
  now?: string
  piSessionId?: string
  piSessionFile?: string | null
  finalObserver?: EpochHook
  memoryFlush?: EpochHook
  /** Alias kept for call-sites that name the hook as a verb. */
  flushMemory?: EpochHook
  /**
   * When provided, rollover hook work (observer + reflector — real LLM
   * round-trips) is scheduled here instead of awaited inline, so the epoch
   * swap itself is just two synchronous writes. Marker advancement moves
   * INTO the scheduled task, which re-reads the observed/reflected markers
   * at run time (the background queue may have advanced them since).
   */
  deferHookWork?: (task: () => Promise<void>) => void
  logger?: Pick<Console, 'warn'>
}

export interface EnsureActiveEpochResult {
  epoch: Epoch
  rolledOver: boolean
  previousEpoch: Epoch | null
  softLimit: number
}

type EpochRow = {
  id: string
  pi_session_id: string
  pi_session_file: string | null
  thread_id: string | null
  status: EpochStatus
  started_at: string
  ended_at: string | null
  end_reason: string | null
  context_tokens: number
  context_window: number
  observed_through_seq: number
  reflected_through_seq: number
}

function nowIso(): string {
  return new Date().toISOString()
}

function toEpoch(row: EpochRow): Epoch {
  return {
    id: row.id,
    piSessionId: row.pi_session_id,
    piSessionFile: row.pi_session_file,
    threadId: row.thread_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    contextTokens: row.context_tokens,
    contextWindow: row.context_window,
    observedThroughSeq: row.observed_through_seq,
    reflectedThroughSeq: row.reflected_through_seq,
  }
}

function dbOrDefault(db?: Database.Database): Database.Database {
  const actual = db ?? getDb()
  ensureTranscriptSchema(actual)
  return actual
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function calculateSoftLimit(
  contextWindow: number | null | undefined,
  options: { ratio?: number; fallbackContextWindow?: number } = {},
): number {
  const ratio = validPositiveInteger(options.ratio) && options.ratio <= 1 ? options.ratio : DEFAULT_SOFT_LIMIT_RATIO
  const window = validPositiveInteger(contextWindow) ? contextWindow : (options.fallbackContextWindow ?? DEFAULT_CONTEXT_WINDOW)
  return Math.max(1, Math.floor(window * ratio))
}

export const calculateEpochSoftLimit = calculateSoftLimit

export function findEpoch(id: string, db?: Database.Database): Epoch | null {
  const actual = dbOrDefault(db)
  const row = actual.prepare('SELECT * FROM epochs WHERE id = ?').get(id) as EpochRow | undefined
  return row ? toEpoch(row) : null
}

/**
 * `threadId` is required, not defaulted — main and each thread may each have
 * one active epoch at once (concurrently), so silently defaulting scope here
 * is exactly the kind of bug that would resume the wrong conversation's epoch.
 */
export function findActiveEpoch(threadId: string | null, db?: Database.Database): Epoch | null {
  const actual = dbOrDefault(db)
  const row = threadId == null
    ? actual.prepare("SELECT * FROM epochs WHERE status = 'active' AND thread_id IS NULL ORDER BY started_at DESC LIMIT 1").get() as EpochRow | undefined
    : actual.prepare("SELECT * FROM epochs WHERE status = 'active' AND thread_id = ? ORDER BY started_at DESC LIMIT 1").get(threadId) as EpochRow | undefined
  return row ? toEpoch(row) : null
}

/**
 * Markers are SEEDED at the transcript high-water mark, never left at 0.
 * Everything before an epoch's birth is the previous epoch's duty — its
 * rollover hooks observe and reflect through the swap-time toSeq, which
 * `ensureActiveEpoch` captures immediately before closeEpoch/createEpoch with
 * no message writes in between. So the closing epoch's hook range ends exactly
 * where the new epoch's markers start: no gap, no overlap. Without this, every
 * new epoch re-observed the entire transcript from seq 1 (measured: 521
 * messages / ~38k tokens in one background run) and every rollover reflected
 * over all of history, growing forever.
 *
 * A THREAD epoch seeds its markers at NEVER_OBSERVED_MARKER instead — memory
 * observation is main-only (plans/chat-threads.md rule 11), and seeding at
 * the global high-water mark like a main epoch would be actively misleading
 * (it implies "everything up to here was already observed", which is false —
 * nothing in a thread ever gets observed at all). The sentinel guarantees
 * `fromSeq > toSeq` forever, so runHook's short-circuit means no observer or
 * reflector call is ever even attempted for a thread epoch.
 */
export const NEVER_OBSERVED_MARKER = Number.MAX_SAFE_INTEGER

export function createEpoch(input: CreateEpochInput = {}, db?: Database.Database): Epoch {
  const actual = dbOrDefault(db)
  const id = input.id ?? randomUUID()
  const piSessionId = input.piSessionId ?? randomUUID()
  const startedAt = input.now ?? nowIso()
  const threadId = input.threadId ?? null
  const seedSeq = threadId != null ? NEVER_OBSERVED_MARKER : maxMessageSeq(actual)
  actual.prepare(`
    INSERT INTO epochs (id, pi_session_id, pi_session_file, thread_id, status, started_at, observed_through_seq, reflected_through_seq)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(id, piSessionId, input.piSessionFile ?? null, threadId, startedAt, seedSeq, seedSeq)
  const created = findEpoch(id, actual)
  if (!created) throw new Error(`Failed to create epoch ${id}`)
  return created
}

export function closeEpoch(input: CloseEpochInput | string, db?: Database.Database): Epoch | null {
  const actual = dbOrDefault(db)
  const id = typeof input === 'string' ? input : input.id
  const reason = typeof input === 'string' ? 'closed' : (input.reason ?? 'closed')
  const endedAt = typeof input === 'string' ? nowIso() : (input.now ?? nowIso())

  actual.prepare(`
    UPDATE epochs
    SET status = 'closed', ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?)
    WHERE id = ?
  `).run(endedAt, reason, id)
  return findEpoch(id, actual)
}

function updateContextUsage(epoch: Epoch, contextTokens: number | null | undefined, contextWindow: number | null | undefined, db: Database.Database): Epoch {
  if (contextTokens == null && contextWindow == null) return epoch
  db.prepare(`
    UPDATE epochs SET
      context_tokens = COALESCE(?, context_tokens),
      context_window = COALESCE(?, context_window)
    WHERE id = ?
  `).run(contextTokens ?? null, contextWindow ?? null, epoch.id)
  return findEpoch(epoch.id, db) ?? epoch
}

function maxMessageSeq(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages').get() as { seq: number }
  return row.seq
}

async function runHook(
  name: 'finalObserver' | 'memoryFlush',
  hook: EpochHook | undefined,
  epoch: Epoch,
  fromSeq: number,
  toSeq: number,
  db: Database.Database,
  logger?: Pick<Console, 'warn'>,
): Promise<boolean> {
  if (toSeq < fromSeq) return true
  if (!hook) return true
  const messages = getMessagesForRange(fromSeq, toSeq)
  try {
    await hook({ epoch, fromSeq, toSeq, messages })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The ledger (memory/ledger.ts) is the durable record; this is the live
    // log line. The old `warnings` array was returned to a caller that never
    // read it and was always empty on the deferred path production uses.
    logger?.warn?.(`[bond] ${name} failed for epoch ${epoch.id}: ${message}`)
    return false
  }
}

/**
 * The observer/reflector work owed to a closing epoch. Markers are re-read
 * at run time and advanced here on success — the background queue may have
 * observed further since this work was scheduled, and `runHook` with an
 * undefined hook reports success, so advancing markers before the work runs
 * would make the re-reading observer skip everything.
 */
async function runRolloverHookWork(
  epochId: string,
  toSeq: number,
  options: EnsureActiveEpochOptions,
  db?: Database.Database,
): Promise<void> {
  const actual = dbOrDefault(db)
  const epoch = findEpoch(epochId, actual)
  if (!epoch) return

  const observedFrom = epoch.observedThroughSeq + 1
  const observedOk = await runHook('finalObserver', options.finalObserver, epoch, observedFrom, toSeq, actual, options.logger)
  if (observedOk && toSeq >= observedFrom) {
    actual.prepare('UPDATE epochs SET observed_through_seq = ? WHERE id = ?').run(toSeq, epoch.id)
  }

  const reflectedFrom = epoch.reflectedThroughSeq + 1
  const flush = options.memoryFlush ?? options.flushMemory
  const reflectedOk = await runHook('memoryFlush', flush, epoch, reflectedFrom, toSeq, actual, options.logger)
  if (reflectedOk && toSeq >= reflectedFrom) {
    actual.prepare('UPDATE epochs SET reflected_through_seq = ? WHERE id = ?').run(toSeq, epoch.id)
  }
}

export async function ensureActiveEpoch(options: EnsureActiveEpochOptions = {}, db?: Database.Database): Promise<EnsureActiveEpochResult> {
  const actual = dbOrDefault(db)
  const threadId = options.threadId ?? null
  let active = findActiveEpoch(threadId, actual)
  if (!active) {
    const epoch = createEpoch({
      threadId,
      piSessionId: options.piSessionId,
      piSessionFile: options.piSessionFile,
      now: options.now,
    }, actual)
    return { epoch, rolledOver: false, previousEpoch: null, softLimit: calculateSoftLimit(epoch.contextWindow, options) }
  }

  active = updateContextUsage(active, options.contextTokens, options.contextWindow, actual)
  const softLimit = calculateSoftLimit(active.contextWindow, options)
  if (active.contextTokens < softLimit) {
    return { epoch: active, rolledOver: false, previousEpoch: null, softLimit }
  }

  const toSeq = maxMessageSeq(actual)

  if (options.deferHookWork) {
    // Swap now, observe later: the turn that crosses the soft limit used to
    // block behind one or two model round-trips with zero UI feedback.
    // toSeq is captured at swap time — later messages belong to the new epoch.
    const closedId = active.id
    const closed = closeEpoch({ id: closedId, reason: options.rolloverReason ?? 'context_soft_limit', now: options.now }, actual) ?? active
    const epoch = createEpoch({
      threadId,
      piSessionId: options.piSessionId,
      piSessionFile: options.piSessionFile,
      now: options.now,
    }, actual)
    // The task resolves the db handle at run time — the captured one could
    // be closed by a sandbox data swap before the queue drains.
    options.deferHookWork(() => runRolloverHookWork(closedId, toSeq, options))
    return { epoch, rolledOver: true, previousEpoch: closed, softLimit }
  }

  await runRolloverHookWork(active.id, toSeq, options, actual)

  const closed = closeEpoch({ id: active.id, reason: options.rolloverReason ?? 'context_soft_limit', now: options.now }, actual) ?? active
  const epoch = createEpoch({
    threadId,
    piSessionId: options.piSessionId,
    piSessionFile: options.piSessionFile,
    now: options.now,
  }, actual)

  return { epoch, rolledOver: true, previousEpoch: closed, softLimit }
}
