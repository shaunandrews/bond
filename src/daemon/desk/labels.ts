/**
 * Derived attribution (Phase 2).
 *
 * Attribution used to be baked into `desk_segments.attributed_thread_id` at
 * capture time and could never be revisited — a wrong guess at 04:41 was
 * load-bearing at 20:41. Every system that handles correction well does the
 * opposite: it stores *observations* and *interpretations* separately and
 * re-derives the attribution on demand.
 *
 * `desk_labels` is that separation. Each row is one interpretation of a segment
 * — from a matcher, the model, or the user — with its source, provenance, and
 * the `rules_version` in force when it was made. `attributed_thread_id` stays,
 * demoted to a **cache** with a `derived_rules_version` stamp. Bump the version
 * (any user rule change, any thread merge/rename/archive) and the cache is
 * stale; a background sweep re-derives it. The notch reads the cache, so the
 * hot path is unchanged and staleness is invisible.
 *
 * The derivation rule (the authority order):
 *   1. A **user** label always wins and is never re-derived — frozen forever.
 *   2. Otherwise re-resolve against the current matchers. A **confirmed**
 *      matcher wins. An **unconfirmed** matcher supersedes a model label only
 *      when there is no model label — a model verdict is not overturned by a
 *      guess.
 *   3. Otherwise the **model** label, if any.
 *   4. Otherwise unresolved.
 *
 * This module writes labels alongside the existing cache writes; it never
 * imports the store's `attributeSegment` caller graph in a way that cycles —
 * the callers (segmenter, inference, service) own both sides.
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import {
  attributeSegment,
  getRulesVersion,
  listStaleAttributions,
  stampDerivedVersion,
} from './store'
import { resolveMatcher } from './matchers'
import { redactAll } from './signature'
import type { DeskSegment } from '../../shared/desk'

export type LabelSource = 'matcher' | 'model' | 'user'

export interface DeskLabel {
  id: string
  segmentId: string
  threadId: string | null
  source: LabelSource
  provenance: string | null
  confidence: number
  rulesVersion: number
  createdAt: string
}

interface LabelRow {
  id: string
  segment_id: string
  thread_id: string | null
  source: string
  provenance: string | null
  confidence: number
  rules_version: number
  created_at: string
}

const now = () => new Date().toISOString()

function toLabel(row: LabelRow): DeskLabel {
  return {
    id: row.id,
    segmentId: row.segment_id,
    threadId: row.thread_id,
    source: row.source as LabelSource,
    provenance: row.provenance,
    confidence: row.confidence,
    rulesVersion: row.rules_version,
    createdAt: row.created_at,
  }
}

/**
 * Record an interpretation. One live label per source per segment: a newer
 * matcher/model/user label supersedes the older one of the same source, which
 * keeps the table bounded (segment count x 3) and makes "the current user
 * label" a single unambiguous row.
 */
export function recordLabel(
  input: { segmentId: string; threadId: string | null; source: LabelSource; provenance?: string | null; confidence?: number },
  db: Database.Database = getDb()
): DeskLabel {
  const rulesVersion = getRulesVersion(db)
  db.prepare('DELETE FROM desk_labels WHERE segment_id = ? AND source = ?').run(input.segmentId, input.source)
  const id = randomUUID()
  db.prepare(`
    INSERT INTO desk_labels (id, segment_id, thread_id, source, provenance, confidence, rules_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.segmentId, input.threadId, input.source, input.provenance ?? null, input.confidence ?? 0, rulesVersion, now())
  return toLabel(db.prepare('SELECT * FROM desk_labels WHERE id = ?').get(id) as LabelRow)
}

export function listLabels(segmentId: string, db: Database.Database = getDb()): DeskLabel[] {
  return (db.prepare('SELECT * FROM desk_labels WHERE segment_id = ? ORDER BY created_at DESC').all(segmentId) as LabelRow[])
    .map(toLabel)
}

export function getLabelBySource(segmentId: string, source: LabelSource, db: Database.Database = getDb()): DeskLabel | null {
  const row = db.prepare('SELECT * FROM desk_labels WHERE segment_id = ? AND source = ? ORDER BY created_at DESC LIMIT 1')
    .get(segmentId, source) as LabelRow | undefined
  return row ? toLabel(row) : null
}

/** Re-point every label's thread reference in a merge (the merge's eighth table). */
export function repointLabels(fromThreadId: string, toThreadId: string, db: Database.Database = getDb()): number {
  return db.prepare('UPDATE desk_labels SET thread_id = ? WHERE thread_id = ?').run(toThreadId, fromThreadId).changes
}

export interface DerivationResult {
  threadId: string | null
  source: LabelSource | null
  matcherId: string | null
  confidence: number
}

/**
 * Re-derive one segment's attribution from its labels + the current rules, and
 * write the cache. Honors the authority order above; the user label is frozen.
 */
export function deriveAttribution(segment: DeskSegment, opts: { at?: string } = {}, db: Database.Database = getDb()): DerivationResult {
  const at = opts.at ?? now()
  const rulesVersion = getRulesVersion(db)

  const write = (r: DerivationResult, state: 'resolved' | 'unresolved') => {
    attributeSegment(segment.id, { threadId: r.threadId, matcherId: r.matcherId, confidence: r.confidence, state }, db)
    stampDerivedVersion(segment.id, rulesVersion, db)
    return r
  }

  // 0. A segment with NO interpretation record at all — a pre-Phase-2 row, or a
  // direct `attributeSegment` — is preserved, never wiped. We cannot re-derive
  // what we have no labels for, and dropping an attribution we can't reconstruct
  // is strictly worse than keeping it. (The migration backfills labels for real
  // production rows, so this only shields genuinely label-less segments.)
  if (listLabels(segment.id, db).length === 0) {
    stampDerivedVersion(segment.id, rulesVersion, db)
    return { threadId: segment.attributedThreadId, source: null, matcherId: segment.matcherId, confidence: segment.attributionConfidence }
  }

  // 1. A user label is frozen — it always wins and is never re-derived away.
  const user = getLabelBySource(segment.id, 'user', db)
  if (user) return write({ threadId: user.threadId, source: 'user', matcherId: null, confidence: 1 }, user.threadId ? 'resolved' : 'unresolved')

  // 2. Re-resolve against the current matchers.
  const ev = segment.evidence ?? {}
  const matcher = resolveMatcher(
    { signature: segment.resourceSignature, bundleId: ev.bundleId ?? null,
      titles: redactAll(ev.titles ?? []), paths: ev.paths ?? [], urls: ev.urls ?? [] },
    { at }, db
  )
  const model = getLabelBySource(segment.id, 'model', db)

  if (matcher && (matcher.confirmed || !model)) {
    return write({ threadId: matcher.threadId, source: 'matcher', matcherId: matcher.id,
      confidence: matcher.confirmed ? 1 : matcher.confidence }, 'resolved')
  }
  // 3. A model label (an unconfirmed matcher does not overturn it).
  if (model) {
    return write({ threadId: model.threadId, source: 'model', matcherId: null, confidence: model.confidence },
      model.threadId ? 'resolved' : 'unresolved')
  }
  // 4. Nothing to say.
  return write({ threadId: null, source: null, matcherId: null, confidence: 0 }, 'unresolved')
}

/** Re-derive a bounded batch of stale segments. Returns how many changed thread. */
export function rederiveStale(
  opts: { limit?: number; at?: string } = {},
  db: Database.Database = getDb()
): { swept: number; changed: number } {
  const rulesVersion = getRulesVersion(db)
  const stale = listStaleAttributions({ limit: opts.limit ?? 50, rulesVersion }, db)
  let changed = 0
  for (const segment of stale) {
    const before = segment.attributedThreadId
    const r = deriveAttribution(segment, { at: opts.at }, db)
    if (r.threadId !== before) changed++
  }
  return { swept: stale.length, changed }
}
