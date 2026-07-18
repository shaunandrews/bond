import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from './db'
import { ensureTranscriptSchema, getMessagesForRange } from './transcript'
import type { TranscriptMessage } from '../shared/transcript'

export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_SOFT_LIMIT_RATIO = 0.8

export type EpochStatus = 'active' | 'closed'

export interface Epoch {
  id: string
  piSessionId: string
  piSessionFile: string | null
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
  logger?: Pick<Console, 'warn'>
}

export interface EnsureActiveEpochResult {
  epoch: Epoch
  rolledOver: boolean
  previousEpoch: Epoch | null
  softLimit: number
  warnings: string[]
}

type EpochRow = {
  id: string
  pi_session_id: string
  pi_session_file: string | null
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

export function findActiveEpoch(db?: Database.Database): Epoch | null {
  const actual = dbOrDefault(db)
  const row = actual.prepare("SELECT * FROM epochs WHERE status = 'active' ORDER BY started_at DESC LIMIT 1").get() as EpochRow | undefined
  return row ? toEpoch(row) : null
}

export function createEpoch(input: CreateEpochInput = {}, db?: Database.Database): Epoch {
  const actual = dbOrDefault(db)
  const id = input.id ?? randomUUID()
  const piSessionId = input.piSessionId ?? randomUUID()
  const startedAt = input.now ?? nowIso()
  actual.prepare(`
    INSERT INTO epochs (id, pi_session_id, pi_session_file, status, started_at)
    VALUES (?, ?, ?, 'active', ?)
  `).run(id, piSessionId, input.piSessionFile ?? null, startedAt)
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
  warnings: string[],
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
    const warning = `${name} failed for epoch ${epoch.id}: ${message}`
    warnings.push(warning)
    logger?.warn?.(`[bond] ${warning}`)
    return false
  }
}

export async function ensureActiveEpoch(options: EnsureActiveEpochOptions = {}, db?: Database.Database): Promise<EnsureActiveEpochResult> {
  const actual = dbOrDefault(db)
  let active = findActiveEpoch(actual)
  if (!active) {
    const epoch = createEpoch({
      piSessionId: options.piSessionId,
      piSessionFile: options.piSessionFile,
      now: options.now,
    }, actual)
    return { epoch, rolledOver: false, previousEpoch: null, softLimit: calculateSoftLimit(epoch.contextWindow, options), warnings: [] }
  }

  active = updateContextUsage(active, options.contextTokens, options.contextWindow, actual)
  const softLimit = calculateSoftLimit(active.contextWindow, options)
  if (active.contextTokens < softLimit) {
    return { epoch: active, rolledOver: false, previousEpoch: null, softLimit, warnings: [] }
  }

  const warnings: string[] = []
  const toSeq = maxMessageSeq(actual)

  const observedFrom = active.observedThroughSeq + 1
  const observedOk = await runHook('finalObserver', options.finalObserver, active, observedFrom, toSeq, actual, warnings, options.logger)
  if (observedOk && toSeq >= observedFrom) {
    actual.prepare('UPDATE epochs SET observed_through_seq = ? WHERE id = ?').run(toSeq, active.id)
  }

  const reflectedFrom = active.reflectedThroughSeq + 1
  const flush = options.memoryFlush ?? options.flushMemory
  const reflectedOk = await runHook('memoryFlush', flush, active, reflectedFrom, toSeq, actual, warnings, options.logger)
  if (reflectedOk && toSeq >= reflectedFrom) {
    actual.prepare('UPDATE epochs SET reflected_through_seq = ? WHERE id = ?').run(toSeq, active.id)
  }

  const closed = closeEpoch({ id: active.id, reason: options.rolloverReason ?? 'context_soft_limit', now: options.now }, actual) ?? active
  const epoch = createEpoch({
    piSessionId: options.piSessionId,
    piSessionFile: options.piSessionFile,
    now: options.now,
  }, actual)

  return { epoch, rolledOver: true, previousEpoch: closed, softLimit, warnings }
}
