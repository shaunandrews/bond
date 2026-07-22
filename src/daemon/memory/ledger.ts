import type Database from 'better-sqlite3'
import type { MemoryHealth } from '../../shared/memory'
import { getDb } from '../db'
import { getSetting } from '../settings'
import { ensureTranscriptSchema } from '../transcript'
import { readCoreMemory } from './core-memory'

/**
 * Every memory run leaves a row here, including the ones that failed. Silence
 * was the meta-failure of 2026-07-21: thirty-six failures over five hours with
 * no signal to the user, the CLI, or Bond himself. This table is the record
 * `bond memory status`, `memory.health`, and the `memory_status` tool read.
 */
export const MEMORY_RUN_OUTCOMES = ['ok', 'partial', 'parse_failed', 'transport_failed', 'empty'] as const
export type MemoryRunOutcome = typeof MEMORY_RUN_OUTCOMES[number]

export type MemoryRunKind = 'observer' | 'reflector'

export interface MemoryRunInput {
  kind: MemoryRunKind
  rangeFrom: number
  rangeTo: number
  outcome: MemoryRunOutcome
  persistedCount?: number
  skippedCount?: number
  reason?: string | null
  ranAt?: string
}

export interface MemoryRunSummary {
  id: number
  kind: MemoryRunKind
  rangeFrom: number
  rangeTo: number
  outcome: MemoryRunOutcome
  persistedCount: number
  skippedCount: number
  reason: string | null
  ranAt: string
}

type MemoryRunRow = {
  id: number
  kind: MemoryRunKind
  range_from: number
  range_to: number
  outcome: MemoryRunOutcome
  persisted_count: number
  skipped_count: number
  reason: string | null
  ran_at: string
}

/** Rows kept; older ones are pruned on insert. */
export const MEMORY_RUN_HISTORY = 500

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS memory_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('observer','reflector')),
    range_from INTEGER NOT NULL,
    range_to INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok','partial','parse_failed','transport_failed','empty')),
    persisted_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    ran_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_runs_kind ON memory_runs(kind, id DESC);
`

// Same WeakSet-per-handle pattern as ensureTranscriptSchema: closeDb() and the
// sandbox swap both build a fresh Database, so there is nothing to reset.
const ensured = new WeakSet<Database.Database>()

export function ensureMemoryLedgerSchema(db: Database.Database = getDb()): void {
  if (ensured.has(db)) return
  db.exec(LEDGER_DDL)
  ensured.add(db)
}

/**
 * Never throws. A ledger write failing must not take down the memory run it is
 * describing — that would reintroduce the exact all-or-nothing coupling this
 * work removes.
 */
export function recordMemoryRun(input: MemoryRunInput, db?: Database.Database): void {
  try {
    const actual = db ?? getDb()
    ensureMemoryLedgerSchema(actual)
    actual.prepare(`
      INSERT INTO memory_runs (kind, range_from, range_to, outcome, persisted_count, skipped_count, reason, ran_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.kind,
      input.rangeFrom,
      input.rangeTo,
      input.outcome,
      input.persistedCount ?? 0,
      input.skippedCount ?? 0,
      input.reason ?? null,
      input.ranAt ?? new Date().toISOString(),
    )
    actual.prepare(`DELETE FROM memory_runs WHERE id <= (SELECT MAX(id) FROM memory_runs) - ?`).run(MEMORY_RUN_HISTORY)
  } catch (error) {
    console.warn(`[bond] memory ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function listMemoryRuns(limit = 10, db?: Database.Database): MemoryRunSummary[] {
  const actual = db ?? getDb()
  ensureMemoryLedgerSchema(actual)
  const rows = actual.prepare('SELECT * FROM memory_runs ORDER BY id DESC LIMIT ?').all(Math.max(1, limit)) as MemoryRunRow[]
  return rows.map(toSummary)
}

/** Trailing failures for one kind, newest-first, stopping at the first success. */
export function countConsecutiveFailures(kind: MemoryRunKind, db?: Database.Database): number {
  const actual = db ?? getDb()
  ensureMemoryLedgerSchema(actual)
  const rows = actual.prepare('SELECT outcome FROM memory_runs WHERE kind = ? ORDER BY id DESC LIMIT ?')
    .all(kind, MEMORY_RUN_HISTORY) as Array<{ outcome: MemoryRunOutcome }>
  let count = 0
  for (const row of rows) {
    if (row.outcome !== 'parse_failed' && row.outcome !== 'transport_failed') break
    count += 1
  }
  return count
}

export function findLastFailedRun(db?: Database.Database): MemoryRunSummary | null {
  const actual = db ?? getDb()
  ensureMemoryLedgerSchema(actual)
  const row = actual.prepare(`
    SELECT * FROM memory_runs
    WHERE outcome IN ('parse_failed','transport_failed')
    ORDER BY id DESC LIMIT 1
  `).get() as MemoryRunRow | undefined
  return row ? toSummary(row) : null
}

/**
 * The single health read behind `memory.health`, `bond memory status`, and the
 * `memory_status` tool. Reads state directly rather than trusting any cached
 * flag: `active: true` with 24 stale facts IS the failure mode.
 */
export function getMemoryHealth(db?: Database.Database): MemoryHealth {
  const actual = db ?? getDb()
  ensureMemoryLedgerSchema(actual)
  ensureTranscriptSchema(actual)

  const core = readCoreMemory()
  let workingUpdatedAt: string | null = null
  try {
    const raw = getSetting('memory.working')
    const parsed = raw ? JSON.parse(raw) as { updatedAt?: unknown } : null
    workingUpdatedAt = typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null
  } catch {
    workingUpdatedAt = null
  }

  const maxSeq = (actual.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages').get() as { seq: number }).seq
  const epoch = actual.prepare("SELECT id, observed_through_seq, reflected_through_seq FROM epochs WHERE status = 'active' ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string; observed_through_seq: number; reflected_through_seq: number } | undefined

  // An epoch created before marker seeding carries 0, which would read as
  // "the whole transcript is pending". It is not: an epoch owes only its own
  // messages, and service.ts clamps the real range the same way.
  const epochStart = epoch
    ? (actual.prepare('SELECT MIN(seq) AS seq FROM messages WHERE epoch_id = ?').get(epoch.id) as { seq: number | null }).seq
    : null
  const floor = epochStart == null ? 0 : epochStart - 1
  const observedThroughSeq = Math.max(epoch?.observed_through_seq ?? 0, floor)
  const reflectedThroughSeq = Math.max(epoch?.reflected_through_seq ?? 0, floor)

  return {
    workingUpdatedAt,
    coreUpdatedAt: core.updatedAt || null,
    coreItems: core.facts.length + core.preferences.length + core.decisions.length,
    maxSeq,
    observedThroughSeq,
    reflectedThroughSeq,
    observerLagSeqs: Math.max(0, maxSeq - observedThroughSeq),
    consecutiveObserverFailures: countConsecutiveFailures('observer', actual),
    consecutiveReflectorFailures: countConsecutiveFailures('reflector', actual),
    lastError: findLastFailedRun(actual)?.reason ?? null,
    lastRuns: listMemoryRuns(10, actual),
  }
}

function toSummary(row: MemoryRunRow): MemoryRunSummary {
  return {
    id: row.id,
    kind: row.kind,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    outcome: row.outcome,
    persistedCount: row.persisted_count,
    skippedCount: row.skipped_count,
    reason: row.reason,
    ranAt: row.ran_at,
  }
}
