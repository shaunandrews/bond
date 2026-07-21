/**
 * The fast deterministic path: Sense captures → segments → blocks.
 *
 * This loop performs **no model call**. It reads capture metadata, opens and
 * closes segments on resource change, credits presence, resolves known
 * resources against `desk_matchers`, and reports when the leading thread has
 * held a clear majority of a rolling window long enough to call a switch.
 *
 * Everything slow — inference, questions, notes — hangs off the signals this
 * produces. The UI clock never waits for any of it.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import { getSenseSettings } from '../settings'
import {
  addBlockPresence,
  addSegmentPresence,
  attributeSegment,
  clearCandidate,
  closeSegment,
  createBlock,
  createSegment,
  getRuntime,
  linkCapture,
  mergeEvidenceOnSegment,
  setRuntime,
  touchThread,
  updateBlock,
  type DeskRuntime,
} from './store'
import { recordMatcherHit, resolveMatcher } from './matchers'
import { buildEvidence, redactAll, redactField, signatureForCapture, type CaptureRow } from './signature'
import { DESK_TIMING } from '../../shared/desk'
import type { DeskEvidence, DeskSegment } from '../../shared/desk'

/**
 * The survived-the-recheck predicate plus an age floor.
 *
 * A capture row is inserted at *trigger* time, but `controller.onCaptureReady`
 * re-checks the blacklist against a post-capture snapshot and DELETES the row
 * if it now trips. Reading rows the moment they appear would let Desk segment a
 * capture that is about to be deleted for being 1Password — the capture link
 * would cascade away, but `resource_signature` and `evidence_json` would keep
 * the blacklisted window's title forever.
 *
 * `image_path IS NOT NULL` alone is wrong on the other side: `purgeOldImages`
 * nulls it and stamps `image_purged_at`, and `enforceStorageCap` purges
 * oldest-first with NO age filter — so on a storage-capped day a capture from
 * minutes ago can lose its image while keeping its text. Gating on image_path
 * alone would make those permanently invisible to the sweep and to back-fill.
 */
const ELIGIBLE = `(image_path IS NOT NULL OR image_purged_at IS NOT NULL)`

/**
 * The `(captured_at, id)` checkpoint can otherwise leapfrog a row forever:
 * `onCaptureReady` clears `pendingCapture` before its awaits, so capture N can
 * still be awaiting `getSnapshot()` when N+1 completes first. N becomes
 * eligible after N+1 but carries an earlier `captured_at` — if the checkpoint
 * has already advanced past it, N is skipped and never reconsidered. Ten
 * seconds is far longer than a snapshot round-trip and costs nothing here.
 */
const AGE_FLOOR_SECONDS = 10

/**
 * How far back a first run reaches.
 *
 * Desk answers "where was I?", and that question has a short half-life — the
 * In-flight list is today's work, and TaCoS found only the last 30 minutes of
 * activity carried useful resumption context. Segmenting the entire Sense store
 * produces thousands of unknown segments, each of which costs a model call to
 * label, for blocks nobody will ever look at.
 *
 * So a fresh checkpoint starts here rather than at the beginning of time. Older
 * captures stay in Sense untouched; Desk simply never derives from them.
 */
export const BACKFILL_HORIZON_HOURS = 24

export interface SegmenterContext {
  db?: Database.Database
  /** Injected for tests; production reads the wall clock. */
  now?: () => Date
  /** Injected for tests; production reads the user's Sense settings. */
  captureIntervalSeconds?: number
  idleThresholdSeconds?: number
  limit?: number
}

interface Ctx {
  db: Database.Database
  nowIso: string
  nowMs: number
  captureIntervalSeconds: number
  idleThresholdSeconds: number
}

function resolveCtx(context: SegmenterContext = {}): Ctx {
  const db = context.db ?? getDb()
  const now = context.now ? context.now() : new Date()
  let interval = context.captureIntervalSeconds
  let idle = context.idleThresholdSeconds
  if (interval === undefined || idle === undefined) {
    // `captureIntervalSeconds` is USER-CONFIGURABLE. Hardcoding the default of
    // 15 would quietly mis-scale every duration for anyone who changed it.
    const settings = getSenseSettings()
    interval = interval ?? settings.captureIntervalSeconds
    idle = idle ?? settings.idleThresholdSeconds
  }
  return {
    db,
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
    captureIntervalSeconds: Math.max(1, interval),
    idleThresholdSeconds: Math.max(1, idle),
  }
}

type EligibleRow = CaptureRow & { text_source: string | null }

/** Captures past the age floor that survived the post-capture blacklist recheck. */
export function selectEligibleCaptures(runtime: DeskRuntime, ctx: Ctx, limit: number): EligibleRow[] {
  const floor = new Date(ctx.nowMs - AGE_FLOOR_SECONDS * 1000).toISOString()
  const where = [ELIGIBLE, 'captured_at < ?']
  const params: unknown[] = [floor]
  if (runtime.processedCaptureAt) {
    where.push('(captured_at > ? OR (captured_at = ? AND id > ?))')
    params.push(runtime.processedCaptureAt, runtime.processedCaptureAt, runtime.processedCaptureId ?? '')
  } else {
    // First run: reach back only as far as the horizon.
    where.push('captured_at >= ?')
    params.push(new Date(ctx.nowMs - BACKFILL_HORIZON_HOURS * 3_600_000).toISOString())
  }
  return ctx.db.prepare(`
    SELECT id, captured_at, app_name, app_bundle_id, window_title, text_content, text_status, text_source,
           image_path, image_purged_at
    FROM sense_captures
    WHERE ${where.join(' AND ')}
    ORDER BY captured_at ASC, id ASC
    LIMIT ?
  `).all(...params, limit) as EligibleRow[]
}

/** The segment currently accepting captures, if one is open. */
export function openSegment(ctx: Ctx): DeskSegment | null {
  const row = ctx.db.prepare(
    'SELECT * FROM desk_segments WHERE ended_at IS NULL ORDER BY started_at DESC, created_at DESC LIMIT 1'
  ).get() as Record<string, unknown> | undefined
  if (!row) return null
  return toSegmentRow(row)
}

function toSegmentRow(row: Record<string, unknown>): DeskSegment {
  let evidence: DeskEvidence = {}
  try {
    const parsed = JSON.parse(String(row.evidence_json ?? '{}'))
    if (parsed && typeof parsed === 'object') evidence = parsed as DeskEvidence
  } catch { /* garbage evidence must not take a read path down */ }
  return {
    id: String(row.id),
    blockId: (row.block_id as string) ?? null,
    startedAt: String(row.started_at),
    endedAt: (row.ended_at as string) ?? null,
    presenceSeconds: Number(row.presence_seconds ?? 0),
    resourceSignature: String(row.resource_signature),
    evidence,
    attributionState: String(row.attribution_state) as DeskSegment['attributionState'],
    attributedThreadId: (row.attributed_thread_id as string) ?? null,
    matcherId: (row.matcher_id as string) ?? null,
    attributionConfidence: Number(row.attribution_confidence ?? 0),
    attributedAt: (row.attributed_at as string) ?? null,
    inferenceAttempts: Number(row.inference_attempts ?? 0),
    retryAt: (row.retry_at as string) ?? null,
    createdAt: String(row.created_at),
  }
}

/**
 * Presence credited for one capture.
 *
 * Captures do not arrive on a metronome — `eventDrivenCapture` fires on app
 * switch and `clipboardCapture` on clipboard change, so a burst of six captures
 * in ten seconds must not be credited as six intervals. Credit
 * `min(gap, 2 × captureInterval)`; the cap absorbs both bursts and short
 * stalls, and a gap past the idle threshold credits nothing at all.
 */
export function creditPresence(
  gapSeconds: number | null,
  opts: { captureIntervalSeconds: number; idleThresholdSeconds: number }
): number {
  if (gapSeconds === null) return 0 // first capture in a segment anchors, credits nothing
  if (gapSeconds <= 0) return 0
  if (gapSeconds > opts.idleThresholdSeconds) return 0
  return Math.min(gapSeconds, 2 * opts.captureIntervalSeconds)
}

export interface IngestResult {
  capturesProcessed: number
  segmentsOpened: number
  presenceSeconds: number
  blocksOpened: number
}

/**
 * Read every eligible capture past the checkpoint and fold it into segments.
 * The checkpoint advances only after the whole capture is folded in, so a crash
 * re-reads rather than skips.
 */
export function ingestCaptures(context: SegmenterContext = {}): IngestResult {
  const ctx = resolveCtx(context)
  const result: IngestResult = { capturesProcessed: 0, segmentsOpened: 0, presenceSeconds: 0, blocksOpened: 0 }
  let runtime = getRuntime(ctx.db)
  const rows = selectEligibleCaptures(runtime, ctx, context.limit ?? 200)
  if (rows.length === 0) return result

  let current = openSegment(ctx)
  let lastCapturedAt = runtime.processedCaptureAt

  for (const row of rows) {
    const textSource = row.text_source
    const signature = signatureForCapture(row, textSource)
    const evidence = buildEvidence(row, textSource)
    const capturedMs = Date.parse(row.captured_at)
    const gapSeconds = lastCapturedAt ? (capturedMs - Date.parse(lastCapturedAt)) / 1000 : null

    // A session gap ends the block outright; short absence only pauses presence.
    const sessionBroken = gapSeconds !== null && gapSeconds > DESK_TIMING.sessionGapSeconds
    if (sessionBroken) {
      if (current) { closeSegment(current.id, lastCapturedAt!, ctx.db); current = null }
      if (runtime.currentBlockId) {
        updateBlock(runtime.currentBlockId, { endedAt: lastCapturedAt!, state: 'committed' }, ctx.db)
        runtime = setRuntime({ currentBlockId: null }, ctx.db)
      }
      clearCandidate(ctx.db)
      runtime = getRuntime(ctx.db)
    }

    if (!current || current.resourceSignature !== signature) {
      if (current) closeSegment(current.id, row.captured_at, ctx.db)
      current = createSegment({
        blockId: runtime.currentBlockId,
        startedAt: row.captured_at,
        resourceSignature: signature,
        evidence,
      }, ctx.db)
      result.segmentsOpened++
    } else {
      mergeEvidenceOnSegment(current.id, current.evidence, evidence, ctx.db)
      current = { ...current, evidence: { ...current.evidence, ...evidence } }
    }

    linkCapture(current.id, row.id, ctx.db)

    const credited = sessionBroken
      ? 0
      : creditPresence(gapSeconds, ctx)
    if (credited > 0) {
      addSegmentPresence(current.id, credited, ctx.db)
      result.presenceSeconds += credited
      if (runtime.currentBlockId) addBlockPresence(runtime.currentBlockId, credited, ctx.db)
    }

    // Deterministic resolution — no model call on this path.
    if (current.attributionState === 'unresolved' && !current.attributedThreadId) {
      const titles = redactAll(evidence.titles ?? [])
      const matcher = resolveMatcher(
        { signature, bundleId: row.app_bundle_id, titles, paths: evidence.paths ?? [] },
        { at: row.captured_at },
        ctx.db
      )
      if (matcher) {
        attributeSegment(current.id, {
          threadId: matcher.threadId,
          matcherId: matcher.id,
          confidence: matcher.confirmed ? 1 : matcher.confidence,
        }, ctx.db)
        recordMatcherHit(matcher.id, row.captured_at, ctx.db)
        touchThread(matcher.threadId, row.captured_at, ctx.db)
        current = { ...current, attributedThreadId: matcher.threadId, attributionState: 'resolved' }
      }
    }

    lastCapturedAt = row.captured_at
    runtime = setRuntime({ processedCaptureAt: row.captured_at, processedCaptureId: row.id }, ctx.db)
    result.capturesProcessed++
  }

  return result
}

// --- temporal smoothing ---

export interface WindowShare {
  threadId: string
  seconds: number
  share: number
}

/**
 * Smooth over a rolling window of **time**, not a count of observations.
 *
 * Sense's cadence is irregular, so "the last eight captures" can span thirty
 * seconds during heavy switching or several minutes while idle. Reconstructed
 * from segment attribution snapshots, so it survives a restart without being
 * persisted.
 */
export function rollingWindow(
  atIso: string,
  context: SegmenterContext = {},
  windowSeconds: number = DESK_TIMING.smoothingWindowSeconds
): { total: number; leader: WindowShare | null; shares: WindowShare[] } {
  const ctx = resolveCtx(context)
  const start = new Date(Date.parse(atIso) - windowSeconds * 1000).toISOString()
  const rows = ctx.db.prepare(`
    SELECT attributed_thread_id AS thread_id, SUM(presence_seconds) AS seconds
    FROM desk_segments
    WHERE attributed_thread_id IS NOT NULL
      AND started_at <= ?
      AND (ended_at IS NULL OR ended_at >= ?)
    GROUP BY attributed_thread_id
  `).all(atIso, start) as { thread_id: string; seconds: number }[]

  const total = rows.reduce((sum, r) => sum + Number(r.seconds ?? 0), 0)
  const shares = rows
    .map(r => ({ threadId: r.thread_id, seconds: Number(r.seconds ?? 0), share: total > 0 ? Number(r.seconds) / total : 0 }))
    .sort((a, b) => b.seconds - a.seconds)
  const leader = shares[0] ?? null
  // "A clear majority", not merely the most — a 40/35/25 split is not a switch.
  return { total, leader: leader && leader.share > 0.5 ? leader : null, shares }
}

export type SwitchDecision =
  | { kind: 'none' }
  | { kind: 'candidate'; threadId: string; sinceIso: string; presenceSeconds: number }
  | { kind: 'switch'; threadId: string; sinceIso: string; presenceSeconds: number }

/**
 * Has the leading thread held long enough to call a switch?
 *
 * **Nothing in the first 3 minutes.** Below that you are looking something up,
 * not switching tasks — the average dwell on a single window is ~2 minutes.
 */
export function evaluateSwitch(context: SegmenterContext = {}): SwitchDecision {
  const ctx = resolveCtx(context)
  const runtime = getRuntime(ctx.db)
  const { leader } = rollingWindow(ctx.nowIso, context)

  const currentThreadId = runtime.currentBlockId
    ? (ctx.db.prepare('SELECT thread_id FROM desk_blocks WHERE id = ?').get(runtime.currentBlockId) as
        { thread_id: string | null } | undefined)?.thread_id ?? null
    : null

  if (!leader || leader.threadId === currentThreadId) {
    if (runtime.candidateThreadId) clearCandidate(ctx.db)
    return { kind: 'none' }
  }

  // A new leader restarts the dwell clock; the same leader keeps accumulating.
  const continuing = runtime.candidateThreadId === leader.threadId && runtime.candidateSince
  const sinceIso = continuing ? runtime.candidateSince! : ctx.nowIso
  const heldSeconds = (ctx.nowMs - Date.parse(sinceIso)) / 1000

  setRuntime({
    candidateThreadId: leader.threadId,
    candidateSince: sinceIso,
    candidatePresenceSeconds: Math.round(leader.seconds),
  }, ctx.db)

  if (heldSeconds < DESK_TIMING.noiseFloorSeconds) {
    return { kind: 'candidate', threadId: leader.threadId, sinceIso, presenceSeconds: leader.seconds }
  }
  return { kind: 'switch', threadId: leader.threadId, sinceIso, presenceSeconds: leader.seconds }
}

/**
 * Commit a switch: close the outgoing block and open one for `threadId`.
 * Segments recorded since the candidate started are adopted by the new block so
 * its presence is not lost to the block it was observed under.
 */
export function commitSwitch(
  threadId: string,
  opts: { sinceIso?: string; source?: 'inferred' | 'confirmed' | 'manual'; confidence?: number } = {},
  context: SegmenterContext = {}
): string {
  const ctx = resolveCtx(context)
  const runtime = getRuntime(ctx.db)
  const startedAt = opts.sinceIso ?? ctx.nowIso

  const commit = ctx.db.transaction(() => {
    if (runtime.currentBlockId) {
      updateBlock(runtime.currentBlockId, { endedAt: startedAt, state: 'committed' }, ctx.db)
    }
    const block = createBlock({
      threadId,
      startedAt,
      source: opts.source ?? 'inferred',
      confidence: opts.confidence ?? 0,
    }, ctx.db)

    // Adopt the segments that made the case for this switch.
    const adopted = ctx.db.prepare(`
      SELECT id, presence_seconds FROM desk_segments
      WHERE attributed_thread_id = ? AND started_at >= ? AND (block_id IS NULL OR block_id = ?)
    `).all(threadId, startedAt, runtime.currentBlockId ?? '') as { id: string; presence_seconds: number }[]

    let adoptedPresence = 0
    for (const seg of adopted) {
      ctx.db.prepare('UPDATE desk_segments SET block_id = ? WHERE id = ?').run(block.id, seg.id)
      adoptedPresence += Number(seg.presence_seconds ?? 0)
      if (runtime.currentBlockId) {
        ctx.db.prepare('UPDATE desk_blocks SET presence_seconds = MAX(0, presence_seconds - ?) WHERE id = ?')
          .run(Number(seg.presence_seconds ?? 0), runtime.currentBlockId)
      }
    }
    if (adoptedPresence > 0) addBlockPresence(block.id, adoptedPresence, ctx.db)

    touchThread(threadId, startedAt, ctx.db)
    setRuntime({ currentBlockId: block.id }, ctx.db)
    clearCandidate(ctx.db)
    return block.id
  })

  return commit()
}
