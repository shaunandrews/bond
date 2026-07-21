/**
 * Matchers and suppressions — Desk's deterministic fast path.
 *
 * One table, two confidence levels. `confirmed = 0` is an inferred attribution
 * for one exact resource; `confirmed = 1` is a user-approved pattern. Splitting
 * them bought a join and an ambiguity about which one wins.
 *
 * The whole point of this module is the **authority matrix**: model inference
 * can never mutate or demote something the user confirmed, and silence can
 * never promote anything. There is deliberately no generic `upsertMatcher`
 * helper — a helper capable of erasing authority is the bug.
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import { computeSpecificity, normalizePattern, oneOffReason, tooBroadReason } from './signature'
import type { DeskEvidence, DeskMatcher, DeskMatcherField, DeskMatcherOperator } from '../../shared/desk'

interface MatcherRow {
  id: string
  thread_id: string
  field: string
  operator: string
  pattern: string
  normalized_pattern: string
  confirmed: number
  source: string
  confidence: number
  specificity: number
  example_json: string
  enabled: number
  hits: number
  last_seen_at: string | null
  example_updated_at: string | null
  created_at: string
  updated_at: string
}

function parseExample(json: string): DeskEvidence {
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as DeskEvidence) : {}
  } catch {
    return {}
  }
}

export function toMatcher(row: MatcherRow): DeskMatcher {
  return {
    id: row.id,
    threadId: row.thread_id,
    field: row.field as DeskMatcherField,
    operator: row.operator as DeskMatcherOperator,
    pattern: row.pattern,
    normalizedPattern: row.normalized_pattern,
    confirmed: row.confirmed === 1,
    source: row.source as DeskMatcher['source'],
    confidence: row.confidence,
    specificity: row.specificity,
    example: parseExample(row.example_json),
    enabled: row.enabled === 1,
    hits: row.hits,
    lastSeenAt: row.last_seen_at,
    exampleUpdatedAt: row.example_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const now = () => new Date().toISOString()

/** `path > title > bundle > resource`, applied after confirmed and specificity. */
const FIELD_RANK: Record<string, number> = { path: 4, title: 3, bundle: 2, resource: 1 }

export function getMatcher(id: string, db: Database.Database = getDb()): DeskMatcher | null {
  const row = db.prepare('SELECT * FROM desk_matchers WHERE id = ?').get(id) as MatcherRow | undefined
  return row ? toMatcher(row) : null
}

export function findMatcher(
  key: { field: DeskMatcherField; operator: DeskMatcherOperator; pattern: string },
  db: Database.Database = getDb()
): DeskMatcher | null {
  const row = db
    .prepare('SELECT * FROM desk_matchers WHERE field = ? AND operator = ? AND normalized_pattern = ?')
    .get(key.field, key.operator, normalizePattern(key.pattern)) as MatcherRow | undefined
  return row ? toMatcher(row) : null
}

export function listMatchers(
  opts: { confirmedOnly?: boolean; threadId?: string } = {},
  db: Database.Database = getDb()
): DeskMatcher[] {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.confirmedOnly) where.push('confirmed = 1')
  if (opts.threadId) { where.push('thread_id = ?'); params.push(opts.threadId) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return (db.prepare(
    `SELECT * FROM desk_matchers ${clause} ORDER BY confirmed DESC, specificity DESC, created_at`
  ).all(...params) as MatcherRow[]).map(toMatcher)
}

// --- suppressions ---

export interface Suppression {
  resourceSignature: string
  threadId: string
  rejectionCount: number
  suppressUntil: string | null
  permanent: boolean
  updatedAt: string
}

export function getSuppression(
  signature: string,
  threadId: string,
  db: Database.Database = getDb()
): Suppression | null {
  const row = db
    .prepare('SELECT * FROM desk_suppressions WHERE resource_signature = ? AND thread_id = ?')
    .get(signature, threadId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    resourceSignature: row.resource_signature as string,
    threadId: row.thread_id as string,
    rejectionCount: Number(row.rejection_count ?? 0),
    suppressUntil: (row.suppress_until as string) ?? null,
    permanent: Number(row.permanent ?? 0) === 1,
    updatedAt: row.updated_at as string,
  }
}

export function isSuppressed(
  signature: string,
  threadId: string,
  at: string = now(),
  db: Database.Database = getDb()
): boolean {
  const s = getSuppression(signature, threadId, db)
  if (!s) return false
  if (s.permanent) return true
  return !!s.suppressUntil && s.suppressUntil > at
}

/**
 * Three strikes. Rejecting the same pairing once suppresses it for the rest of
 * the day; three times makes it permanent. A rejection is negative evidence
 * only — it never becomes a positive attribution rule.
 */
export function recordRejection(
  signature: string,
  threadId: string,
  opts: { at?: string; dayEnd?: string } = {},
  db: Database.Database = getDb()
): Suppression {
  const at = opts.at ?? now()
  const existing = getSuppression(signature, threadId, db)
  const count = (existing?.rejectionCount ?? 0) + 1
  const permanent = count >= 3 || existing?.permanent === true
  // Rest of the day, in the user's local timezone.
  const endOfDay = opts.dayEnd ?? (() => {
    const d = new Date(at)
    d.setHours(23, 59, 59, 999)
    return d.toISOString()
  })()
  const until = existing?.suppressUntil && existing.suppressUntil > endOfDay ? existing.suppressUntil : endOfDay
  db.prepare(`
    INSERT INTO desk_suppressions (resource_signature, thread_id, rejection_count, suppress_until, permanent, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_signature, thread_id) DO UPDATE SET
      rejection_count = excluded.rejection_count,
      suppress_until = excluded.suppress_until,
      permanent = excluded.permanent,
      updated_at = excluded.updated_at
  `).run(signature, threadId, count, until, permanent ? 1 : 0, at)
  return getSuppression(signature, threadId, db)!
}

// --- resolution ---

export interface ResolveInput {
  signature: string
  bundleId: string | null
  titles: string[]
  paths: string[]
}

function patternMatches(operator: string, normalizedPattern: string, candidate: string): boolean {
  if (operator === 'exact') return candidate === normalizedPattern
  if (operator === 'prefix') return candidate.startsWith(normalizedPattern)
  return candidate.includes(normalizedPattern)
}

/**
 * One ordered lookup: `confirmed` first, then specificity, then field rank,
 * then oldest id. The suppression check happens BEFORE an unconfirmed matcher
 * is accepted, so "No" changes behaviour rather than merely hiding the next
 * question.
 */
export function resolveMatcher(
  input: ResolveInput,
  opts: { at?: string } = {},
  db: Database.Database = getDb()
): DeskMatcher | null {
  const at = opts.at ?? now()
  const candidates: Record<DeskMatcherField, string[]> = {
    resource: [input.signature],
    bundle: input.bundleId ? [normalizePattern(input.bundleId)] : [],
    title: input.titles.map(normalizePattern),
    path: input.paths.map(p => p.trim().toLowerCase()),
  }

  // Archiving a thread must actually stop it claiming new work. Without the
  // join, archiving only hides a thread from the In-flight list while its
  // matchers keep winning every lookup — the user's most direct corrective
  // gesture would silently do nothing.
  const rows = db.prepare(`
    SELECT m.* FROM desk_matchers m
    JOIN desk_threads t ON t.id = m.thread_id
    WHERE m.enabled = 1 AND t.status != 'archived'
    ORDER BY m.confirmed DESC, m.specificity DESC, m.created_at ASC
  `).all() as MatcherRow[]

  const hits = rows
    .filter(row => {
      const field = row.field as DeskMatcherField
      const pool = candidates[field] ?? []
      return pool.some(value => patternMatches(row.operator, row.normalized_pattern, value))
    })
    .sort((a, b) =>
      b.confirmed - a.confirmed ||
      b.specificity - a.specificity ||
      (FIELD_RANK[b.field] ?? 0) - (FIELD_RANK[a.field] ?? 0) ||
      a.created_at.localeCompare(b.created_at)
    )

  for (const row of hits) {
    // A confirmed matcher is the user's own instruction and outranks a
    // suppression, which only ever silenced an *inferred* guess.
    if (row.confirmed !== 1 && isSuppressed(input.signature, row.thread_id, at, db)) continue
    return toMatcher(row)
  }
  return null
}

export function recordMatcherHit(id: string, at: string = now(), db: Database.Database = getDb()): void {
  db.prepare('UPDATE desk_matchers SET hits = hits + 1, last_seen_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
}

// --- authority-matrix writes ---

export interface MatcherKey {
  field: DeskMatcherField
  operator: DeskMatcherOperator
  pattern: string
}

export type InferenceWriteResult =
  | { action: 'inserted'; matcher: DeskMatcher }
  | { action: 'refreshed'; matcher: DeskMatcher }
  | { action: 'blocked_confirmed'; matcher: DeskMatcher }
  | { action: 'blocked_other_thread'; matcher: DeskMatcher }

/**
 * The ONLY write path model inference is allowed to take. Guarded so it cannot
 * update a confirmed row, cannot steal a pattern already pointing at another
 * thread, and cannot set `confirmed = 1` under any circumstance.
 */
export function writeInferredMatcher(
  input: MatcherKey & { threadId: string; confidence: number; example: DeskEvidence },
  db: Database.Database = getDb()
): InferenceWriteResult {
  const existing = findMatcher(input, db)
  const ts = now()

  if (existing) {
    if (existing.confirmed) return { action: 'blocked_confirmed', matcher: existing }
    if (existing.threadId !== input.threadId) return { action: 'blocked_other_thread', matcher: existing }
    db.prepare(`
      UPDATE desk_matchers
      SET confidence = ?, example_json = ?, example_updated_at = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ? AND confirmed = 0
    `).run(input.confidence, JSON.stringify(input.example), ts, ts, ts, existing.id)
    return { action: 'refreshed', matcher: getMatcher(existing.id, db)! }
  }

  const id = randomUUID()
  const normalized = normalizePattern(input.pattern)
  db.prepare(`
    INSERT INTO desk_matchers (
      id, thread_id, field, operator, pattern, normalized_pattern, confirmed, source,
      confidence, specificity, example_json, enabled, hits, last_seen_at, example_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'inferred', ?, ?, ?, 1, 0, ?, ?, ?, ?)
  `).run(id, input.threadId, input.field, input.operator, input.pattern, normalized,
    input.confidence, computeSpecificity(input.operator, normalized),
    JSON.stringify(input.example), ts, ts, ts, ts)
  return { action: 'inserted', matcher: getMatcher(id, db)! }
}

/**
 * A plain block reassignment: re-point the exact-resource matcher, mark it
 * user-sourced, and **preserve** `confirmed` if it was already confirmed.
 * Re-teaching an existing pattern to a different thread must succeed, not error.
 */
export function repointMatcherByUser(
  input: MatcherKey & { threadId: string; example?: DeskEvidence },
  db: Database.Database = getDb()
): DeskMatcher {
  const existing = findMatcher(input, db)
  const ts = now()
  if (existing) {
    db.prepare(
      "UPDATE desk_matchers SET thread_id = ?, source = 'user', enabled = 1, updated_at = ? WHERE id = ?"
    ).run(input.threadId, ts, existing.id)
    if (input.example) {
      db.prepare('UPDATE desk_matchers SET example_json = ?, example_updated_at = ? WHERE id = ?')
        .run(JSON.stringify(input.example), ts, existing.id)
    }
    return getMatcher(existing.id, db)!
  }
  const id = randomUUID()
  const normalized = normalizePattern(input.pattern)
  db.prepare(`
    INSERT INTO desk_matchers (
      id, thread_id, field, operator, pattern, normalized_pattern, confirmed, source,
      confidence, specificity, example_json, enabled, hits, last_seen_at, example_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'user', 1.0, ?, ?, 1, 0, ?, ?, ?, ?)
  `).run(id, input.threadId, input.field, input.operator, input.pattern, normalized,
    computeSpecificity(input.operator, normalized), JSON.stringify(input.example ?? {}), ts, ts, ts, ts)
  return getMatcher(id, db)!
}

/**
 * Explicit confirmation of a concrete pattern — the only path to
 * `confirmed = 1`. Resets hits and replaces the example, because the user is
 * approving *this* pattern for *this* thread from now on.
 */
export function confirmMatcher(
  input: MatcherKey & { threadId: string; example?: DeskEvidence },
  db: Database.Database = getDb()
): DeskMatcher {
  const existing = findMatcher(input, db)
  const ts = now()
  if (existing) {
    db.prepare(`
      UPDATE desk_matchers
      SET thread_id = ?, confirmed = 1, source = 'user', enabled = 1, hits = 0, confidence = 1.0,
          example_json = ?, example_updated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(input.threadId, JSON.stringify(input.example ?? existing.example), ts, ts, existing.id)
    return getMatcher(existing.id, db)!
  }
  const id = randomUUID()
  const normalized = normalizePattern(input.pattern)
  db.prepare(`
    INSERT INTO desk_matchers (
      id, thread_id, field, operator, pattern, normalized_pattern, confirmed, source,
      confidence, specificity, example_json, enabled, hits, last_seen_at, example_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'user', 1.0, ?, ?, 1, 0, ?, ?, ?, ?)
  `).run(id, input.threadId, input.field, input.operator, input.pattern, normalized,
    computeSpecificity(input.operator, normalized), JSON.stringify(input.example ?? {}), ts, ts, ts, ts)
  return getMatcher(id, db)!
}

export function setMatcherEnabled(id: string, enabled: boolean, db: Database.Database = getDb()): DeskMatcher | null {
  db.prepare('UPDATE desk_matchers SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), id)
  return getMatcher(id, db)
}

export function deleteMatcher(id: string, db: Database.Database = getDb()): boolean {
  return db.prepare('DELETE FROM desk_matchers WHERE id = ?').run(id).changes > 0
}

/**
 * Delete unconfirmed matchers too broad to have been written in the first place.
 *
 * The breadth check lives at the inference write path, but matchers written
 * before it existed are still on disk actively mis-attributing work — a
 * `title|prefix|~` claims every terminal window forever, and no amount of
 * correct new inference outruns it. Run at worker start so the store repairs
 * itself rather than needing a manual sweep.
 *
 * Confirmed matchers are never touched: the user approved those, and breadth
 * they chose is their business.
 */
export function pruneOverbroadMatchers(db: Database.Database = getDb()): { deleted: number; reasons: string[] } {
  const rows = db.prepare(
    "SELECT id, field, pattern, example_json FROM desk_matchers WHERE confirmed = 0 AND field != 'resource'"
  ).all() as { id: string; field: string; pattern: string; example_json: string }[]

  const reasons: string[] = []
  const remove = db.prepare('DELETE FROM desk_matchers WHERE id = ? AND confirmed = 0')
  let deleted = 0

  for (const row of rows) {
    const example = parseExample(row.example_json)
    const reason = tooBroadReason(row.field, row.pattern, {
      appName: example.appName,
      bundleId: example.bundleId,
    }) ?? oneOffReason(row.pattern)
    if (!reason) continue
    deleted += remove.run(row.id).changes
    reasons.push(reason)
  }

  return { deleted, reasons }
}

/**
 * A rejected Ask removes the unconfirmed attribution that produced it. A
 * confirmed matcher is never touched — the user approved that one, and the
 * rejection was about a guess.
 */
export function dropInferredMatchersForThread(
  signature: string,
  threadId: string,
  db: Database.Database = getDb()
): number {
  return db.prepare(`
    DELETE FROM desk_matchers
    WHERE thread_id = ? AND confirmed = 0
      AND ((field = 'resource' AND normalized_pattern = ?) OR id IN (
        SELECT matcher_id FROM desk_segments WHERE resource_signature = ? AND matcher_id IS NOT NULL
      ))
  `).run(threadId, signature, signature).changes
}
