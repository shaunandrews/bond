/**
 * Desk's data layer — threads, blocks, segments, runtime state.
 *
 * Row mapping lives here and nowhere else: the daemon reads snake_case SQLite
 * rows and every consumer above it sees the camelCase `shared/desk.ts` types.
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import { mergeEvidence, normalizeTitle } from './signature'
import type {
  DeskBlock,
  DeskBlockDetail,
  DeskBlockSource,
  DeskBlockState,
  DeskEvidence,
  DeskNoteStatus,
  DeskSegment,
  DeskThread,
  DeskThreadStatus,
  DeskAttributionState,
} from '../../shared/desk'

// --- row shapes ---

interface ThreadRow {
  id: string
  name: string
  normalized_name: string
  color_seed: string
  status: string
  source: string
  user_note: string | null
  user_note_updated_at: string | null
  last_seen_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface BlockRow {
  id: string
  thread_id: string | null
  started_at: string
  ended_at: string | null
  presence_seconds: number
  state: string
  summary: string | null
  reentry_note: string | null
  note_status: string
  confidence: number
  source: string
  created_at: string
  updated_at: string
}

interface SegmentRow {
  id: string
  block_id: string | null
  started_at: string
  ended_at: string | null
  presence_seconds: number
  resource_signature: string
  evidence_json: string
  attribution_state: string
  attributed_thread_id: string | null
  matcher_id: string | null
  attribution_confidence: number
  attributed_at: string | null
  inference_attempts: number
  retry_at: string | null
  created_at: string
}

export function toThread(row: ThreadRow): DeskThread {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    colorSeed: row.color_seed,
    status: row.status as DeskThreadStatus,
    source: row.source as DeskThread['source'],
    userNote: row.user_note,
    userNoteUpdatedAt: row.user_note_updated_at,
    lastSeenAt: row.last_seen_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toBlock(row: BlockRow): DeskBlock {
  return {
    id: row.id,
    threadId: row.thread_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    presenceSeconds: row.presence_seconds,
    state: row.state as DeskBlockState,
    summary: row.summary,
    reentryNote: row.reentry_note,
    noteStatus: row.note_status as DeskNoteStatus,
    confidence: row.confidence,
    source: row.source as DeskBlockSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Garbage `evidence_json` must never take a read path down. */
function parseEvidence(json: string): DeskEvidence {
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as DeskEvidence) : {}
  } catch {
    return {}
  }
}

export function toSegment(row: SegmentRow): DeskSegment {
  return {
    id: row.id,
    blockId: row.block_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    presenceSeconds: row.presence_seconds,
    resourceSignature: row.resource_signature,
    evidence: parseEvidence(row.evidence_json),
    attributionState: row.attribution_state as DeskAttributionState,
    attributedThreadId: row.attributed_thread_id,
    matcherId: row.matcher_id,
    attributionConfidence: row.attribution_confidence,
    attributedAt: row.attributed_at,
    inferenceAttempts: row.inference_attempts,
    retryAt: row.retry_at,
    createdAt: row.created_at,
  }
}

const now = () => new Date().toISOString()

// --- threads ---

export interface CreateThreadInput {
  name: string
  source: DeskThread['source']
  status?: DeskThreadStatus
  id?: string
}

export function createThread(input: CreateThreadInput, db: Database.Database = getDb()): DeskThread {
  const id = input.id ?? randomUUID()
  const ts = now()
  const name = input.name.trim() || 'Untitled thread'
  db.prepare(`
    INSERT INTO desk_threads (id, name, normalized_name, color_seed, status, source, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, normalizeTitle(name), id,
    input.status ?? (input.source === 'user' ? 'established' : 'provisional'),
    input.source, ts, ts, ts
  )
  return getThread(id, db)!
}

export function getThread(id: string, db: Database.Database = getDb()): DeskThread | null {
  const row = db.prepare('SELECT * FROM desk_threads WHERE id = ?').get(id) as ThreadRow | undefined
  return row ? toThread(row) : null
}

export function findThreadByName(name: string, db: Database.Database = getDb()): DeskThread | null {
  const row = db
    .prepare('SELECT * FROM desk_threads WHERE normalized_name = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1')
    .get(normalizeTitle(name)) as ThreadRow | undefined
  return row ? toThread(row) : null
}

export function listThreads(
  opts: { includeArchived?: boolean } = {},
  db: Database.Database = getDb()
): DeskThread[] {
  const sql = opts.includeArchived
    ? 'SELECT * FROM desk_threads ORDER BY last_seen_at DESC, created_at DESC'
    : "SELECT * FROM desk_threads WHERE status != 'archived' ORDER BY last_seen_at DESC, created_at DESC"
  return (db.prepare(sql).all() as ThreadRow[]).map(toThread)
}

export function renameThread(id: string, name: string, db: Database.Database = getDb()): DeskThread | null {
  const trimmed = name.trim()
  if (!trimmed) return getThread(id, db)
  db.prepare(
    "UPDATE desk_threads SET name = ?, normalized_name = ?, source = 'user', status = CASE WHEN status = 'provisional' THEN 'established' ELSE status END, updated_at = ? WHERE id = ?"
  ).run(trimmed, normalizeTitle(trimmed), now(), id)
  return getThread(id, db)
}

export function archiveThread(id: string, archived: boolean, db: Database.Database = getDb()): DeskThread | null {
  const ts = now()
  if (archived) {
    db.prepare("UPDATE desk_threads SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id)
  } else {
    db.prepare("UPDATE desk_threads SET status = 'established', archived_at = NULL, updated_at = ? WHERE id = ?").run(ts, id)
  }
  return getThread(id, db)
}

export function touchThread(id: string, at: string = now(), db: Database.Database = getDb()): void {
  db.prepare('UPDATE desk_threads SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
}

/**
 * A thread graduates to `established` once the user names or confirms it, or
 * once it appears on two separate blocks with high confidence. Inference alone
 * can propose but never establish.
 */
export function maybeEstablishThread(id: string, db: Database.Database = getDb()): void {
  const row = db.prepare('SELECT status FROM desk_threads WHERE id = ?').get(id) as { status: string } | undefined
  if (!row || row.status !== 'provisional') return
  const blocks = db
    .prepare('SELECT COUNT(*) AS n FROM desk_blocks WHERE thread_id = ? AND confidence >= 0.7')
    .get(id) as { n: number }
  if (blocks.n >= 2) {
    db.prepare("UPDATE desk_threads SET status = 'established', updated_at = ? WHERE id = ?").run(now(), id)
  }
}

// --- blocks ---

export function createBlock(
  input: { threadId?: string | null; startedAt?: string; source?: DeskBlockSource; confidence?: number },
  db: Database.Database = getDb()
): DeskBlock {
  const id = randomUUID()
  const ts = now()
  db.prepare(`
    INSERT INTO desk_blocks (id, thread_id, started_at, state, source, confidence, created_at, updated_at)
    VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?)
  `).run(id, input.threadId ?? null, input.startedAt ?? ts, input.source ?? 'inferred', input.confidence ?? 0, ts, ts)
  return getBlock(id, db)!
}

export function getBlock(id: string, db: Database.Database = getDb()): DeskBlock | null {
  const row = db.prepare('SELECT * FROM desk_blocks WHERE id = ?').get(id) as BlockRow | undefined
  return row ? toBlock(row) : null
}

export function getBlockDetail(id: string, db: Database.Database = getDb()): DeskBlockDetail | null {
  const block = getBlock(id, db)
  if (!block) return null
  return {
    ...block,
    thread: block.threadId ? getThread(block.threadId, db) : null,
    segments: listSegmentsForBlock(id, db),
  }
}

export function updateBlock(
  id: string,
  patch: Partial<{
    threadId: string | null
    endedAt: string | null
    presenceSeconds: number
    state: DeskBlockState
    summary: string | null
    reentryNote: string | null
    noteStatus: DeskNoteStatus
    confidence: number
    source: DeskBlockSource
  }>,
  db: Database.Database = getDb()
): DeskBlock | null {
  const columns: Record<string, string> = {
    threadId: 'thread_id',
    endedAt: 'ended_at',
    presenceSeconds: 'presence_seconds',
    state: 'state',
    summary: 'summary',
    reentryNote: 'reentry_note',
    noteStatus: 'note_status',
    confidence: 'confidence',
    source: 'source',
  }
  const p = { ...patch }
  // A block's `ended_at` can never precede its own `started_at`. The Ask
  // double-commit dated blocks from an earlier candidate clock and produced
  // four negative-duration blocks in a single day; `updateBlock` used to write
  // whatever it was handed. Clamp here so no caller can reintroduce it.
  if ('endedAt' in p && p.endedAt != null) {
    const row = db.prepare('SELECT started_at FROM desk_blocks WHERE id = ?').get(id) as
      { started_at: string } | undefined
    if (row && Date.parse(p.endedAt) < Date.parse(row.started_at)) p.endedAt = row.started_at
  }

  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in p)) continue
    sets.push(`${column} = ?`)
    values.push((p as Record<string, unknown>)[key])
  }
  if (sets.length === 0) return getBlock(id, db)
  sets.push('updated_at = ?')
  values.push(now(), id)
  db.prepare(`UPDATE desk_blocks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getBlock(id, db)
}

/**
 * Credit presence to an OPEN block only. A closed block is history; a late,
 * out-of-order capture (or a stale `currentBlockId` after a switch) must never
 * inflate a span that has already ended — 11 of 34 blocks once carried
 * presence exceeding their own wall-clock span, one by 4.18x.
 */
export function addBlockPresence(id: string, seconds: number, db: Database.Database = getDb()): void {
  if (seconds <= 0) return
  db.prepare('UPDATE desk_blocks SET presence_seconds = presence_seconds + ?, updated_at = ? WHERE id = ? AND ended_at IS NULL')
    .run(Math.round(seconds), now(), id)
}

/** The current block id, but only if it is still open. Clears a stale pointer. */
export function currentOpenBlockId(db: Database.Database = getDb()): string | null {
  const runtime = getRuntime(db)
  if (!runtime.currentBlockId) return null
  const row = db.prepare('SELECT ended_at FROM desk_blocks WHERE id = ?').get(runtime.currentBlockId) as
    { ended_at: string | null } | undefined
  if (!row || row.ended_at != null) {
    setRuntime({ currentBlockId: null }, db)
    return null
  }
  return runtime.currentBlockId
}

export function listBlocks(
  range: { from?: string; to?: string; limit?: number } = {},
  db: Database.Database = getDb()
): DeskBlockDetail[] {
  const where: string[] = []
  const params: unknown[] = []
  if (range.from) { where.push('started_at >= ?'); params.push(range.from) }
  if (range.to) { where.push('started_at <= ?'); params.push(range.to) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM desk_blocks ${clause} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, range.limit ?? 200) as BlockRow[]
  return rows.map(row => ({
    ...toBlock(row),
    thread: row.thread_id ? getThread(row.thread_id, db) : null,
    segments: listSegmentsForBlock(row.id, db),
  }))
}

/**
 * The **In flight** list — blocks Bond observed, newest first, one row per
 * thread. Blocks below the ~3-minute noise floor never surface as named work.
 */
export function listInFlight(
  opts: { since?: string; limit?: number; noiseFloorSeconds?: number } = {},
  db: Database.Database = getDb()
): DeskBlockDetail[] {
  const floor = opts.noiseFloorSeconds ?? 180
  const rows = db.prepare(`
    SELECT b.* FROM desk_blocks b
    WHERE b.thread_id IS NOT NULL
      AND b.state != 'dismissed'
      AND b.presence_seconds >= ?
      ${opts.since ? 'AND b.started_at >= ?' : ''}
      AND b.started_at = (
        SELECT MAX(b2.started_at) FROM desk_blocks b2
        WHERE b2.thread_id = b.thread_id AND b2.presence_seconds >= ? AND b2.state != 'dismissed'
      )
    ORDER BY b.started_at DESC
    LIMIT ?
  `).all(...(opts.since ? [floor, opts.since, floor] : [floor, floor]), opts.limit ?? 20) as BlockRow[]
  return rows.map(row => ({
    ...toBlock(row),
    thread: row.thread_id ? getThread(row.thread_id, db) : null,
    segments: listSegmentsForBlock(row.id, db),
  }))
}

// --- segments ---

export interface CreateSegmentInput {
  blockId: string | null
  startedAt: string
  resourceSignature: string
  evidence: DeskEvidence
  presenceSeconds?: number
}

export function createSegment(input: CreateSegmentInput, db: Database.Database = getDb()): DeskSegment {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO desk_segments (id, block_id, started_at, presence_seconds, resource_signature, evidence_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.blockId, input.startedAt, Math.round(input.presenceSeconds ?? 0), input.resourceSignature,
    JSON.stringify(input.evidence), now())
  return getSegment(id, db)!
}

export function getSegment(id: string, db: Database.Database = getDb()): DeskSegment | null {
  const row = db.prepare('SELECT * FROM desk_segments WHERE id = ?').get(id) as SegmentRow | undefined
  return row ? toSegment(row) : null
}

export function listSegmentsForBlock(blockId: string, db: Database.Database = getDb()): DeskSegment[] {
  return (db.prepare('SELECT * FROM desk_segments WHERE block_id = ? ORDER BY started_at').all(blockId) as SegmentRow[])
    .map(toSegment)
}

export function closeSegment(id: string, endedAt: string = now(), db: Database.Database = getDb()): void {
  db.prepare('UPDATE desk_segments SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(endedAt, id)
}

export function addSegmentPresence(id: string, seconds: number, db: Database.Database = getDb()): void {
  if (seconds <= 0) return
  db.prepare('UPDATE desk_segments SET presence_seconds = presence_seconds + ? WHERE id = ?').run(Math.round(seconds), id)
}

export function updateSegmentEvidence(id: string, evidence: DeskEvidence, db: Database.Database = getDb()): void {
  db.prepare('UPDATE desk_segments SET evidence_json = ? WHERE id = ?').run(JSON.stringify(evidence), id)
}

/** Fold a later capture's evidence into a running segment's, bounded. */
export function mergeEvidenceOnSegment(
  id: string,
  base: DeskEvidence,
  next: DeskEvidence,
  db: Database.Database = getDb()
): DeskEvidence {
  const merged = mergeEvidence(base, next)
  updateSegmentEvidence(id, merged, db)
  return merged
}

/**
 * Write a segment's attribution CACHE (Phase 2). This is the fast-path cache the
 * notch reads; the durable interpretation lives in `desk_labels`, and
 * `labels.ts` re-derives this cache when the rules change. A **user** label is
 * frozen and never re-derived; matcher and model labels do. (Before Phase 2 this
 * was a permanent snapshot — a wrong guess at 04:41 was load-bearing at 20:41.)
 */
export function attributeSegment(
  id: string,
  attribution: { threadId: string | null; matcherId?: string | null; confidence?: number; state?: DeskAttributionState },
  db: Database.Database = getDb()
): void {
  db.prepare(`
    UPDATE desk_segments
    SET attributed_thread_id = ?, matcher_id = ?, attribution_confidence = ?, attribution_state = ?, attributed_at = ?
    WHERE id = ?
  `).run(
    attribution.threadId,
    attribution.matcherId ?? null,
    attribution.confidence ?? 0,
    attribution.state ?? (attribution.threadId ? 'resolved' : 'unresolved'),
    attribution.threadId ? now() : null,
    id
  )
}

/** Undo an inferred attribution — what a rejected Ask does to its segments. */
export function clearSegmentAttribution(
  filter: { signature: string; threadId: string },
  db: Database.Database = getDb()
): number {
  const result = db.prepare(`
    UPDATE desk_segments
    SET attributed_thread_id = NULL, matcher_id = NULL, attribution_confidence = 0,
        attribution_state = 'unresolved', attributed_at = NULL
    WHERE resource_signature = ? AND attributed_thread_id = ?
  `).run(filter.signature, filter.threadId)
  return result.changes
}

export function listUnresolvedSegments(
  opts: { limit?: number; nowIso?: string; since?: string } = {},
  db: Database.Database = getDb()
): DeskSegment[] {
  const ts = opts.nowIso ?? now()
  // Newest first: if there is a queue, the work you just did matters more than
  // the work you did yesterday, and each labelled segment costs a model call.
  return (db.prepare(`
    SELECT * FROM desk_segments
    WHERE attribution_state IN ('unresolved', 'failed')
      AND (retry_at IS NULL OR retry_at <= ?)
      AND (? IS NULL OR started_at >= ?)
    ORDER BY started_at DESC
    LIMIT ?
  `).all(ts, opts.since ?? null, opts.since ?? null, opts.limit ?? 40) as SegmentRow[]).map(toSegment)
}

export function markSegmentsQueued(ids: string[], db: Database.Database = getDb()): void {
  if (ids.length === 0) return
  const stmt = db.prepare("UPDATE desk_segments SET attribution_state = 'queued' WHERE id = ?")
  for (const id of ids) stmt.run(id)
}

/**
 * A failed model call is retryable without rewinding segmentation. Backoff is
 * bounded so a permanently-unclassifiable segment doesn't spin forever.
 */
export function markSegmentFailed(id: string, retryAt: string | null, db: Database.Database = getDb()): void {
  db.prepare(
    "UPDATE desk_segments SET attribution_state = 'failed', inference_attempts = inference_attempts + 1, retry_at = ? WHERE id = ?"
  ).run(retryAt, id)
}

/**
 * Return segments stranded mid-batch to the queue.
 *
 * `markSegmentsQueued` moves a batch out of `listUnresolvedSegments`' reach so
 * two overlapping runs can't classify the same segment twice. If the daemon
 * dies (or a provider call never returns) between that write and the batch
 * completing, those rows sit in `queued` forever — invisible to the sweep and
 * to any retry. Same failure and same fix as `requeueStale` in
 * `sense/worker.ts`; called on worker start.
 */
/**
 * Blocks that have been left and still want a re-entry note.
 *
 * A query rather than a callback, because a block departs by four different
 * routes — a smoothed switch, an accepted Ask, an expired Ask, a manual start —
 * and threading a hook through each one is how a path gets missed.
 *
 * Below the noise floor there is nothing to re-enter: you were looking
 * something up, not working. `edited` and `ready` are already spoken for.
 */
export function listBlocksAwaitingNote(
  opts: { noiseFloorSeconds?: number; limit?: number; now?: string } = {},
  db: Database.Database = getDb()
): DeskBlock[] {
  const nowIso = opts.now ?? now()
  return (db.prepare(`
    SELECT * FROM desk_blocks
    WHERE ended_at IS NOT NULL
      AND thread_id IS NOT NULL
      AND state != 'dismissed'
      AND presence_seconds >= ?
      AND (
        note_status = 'none'
        OR (note_status = 'failed' AND note_retry_at IS NOT NULL AND note_retry_at <= ?)
      )
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(opts.noiseFloorSeconds ?? 180, nowIso, opts.limit ?? 3) as BlockRow[]).map(toBlock)
}

/**
 * Mark a block's re-entry note failed — unless the user edited it while the
 * model was thinking, in which case their write wins and nothing changes. A
 * transient failure (`transient: true`, e.g. a provider outage) is scheduled to
 * retry with backoff until `maxAttempts`; a permanent one (no evidence,
 * redaction) leaves `note_retry_at` NULL and is terminal.
 */
export function failBlockNote(
  id: string,
  opts: { transient: boolean; retryMinutes?: number[]; maxAttempts?: number; now?: string },
  db: Database.Database = getDb()
): void {
  const row = db.prepare('SELECT note_status, note_attempts FROM desk_blocks WHERE id = ?').get(id) as
    { note_status: string; note_attempts: number } | undefined
  if (!row || row.note_status === 'edited') return
  const attempts = Number(row.note_attempts ?? 0) + 1
  const retryMinutes = opts.retryMinutes ?? [10, 30, 60]
  const maxAttempts = opts.maxAttempts ?? 4
  const ts = opts.now ?? now()
  let retryAt: string | null = null
  if (opts.transient && attempts < maxAttempts) {
    const mins = retryMinutes[Math.min(attempts - 1, retryMinutes.length - 1)]
    retryAt = new Date(Date.parse(ts) + mins * 60_000).toISOString()
  }
  db.prepare(`
    UPDATE desk_blocks
    SET note_status = 'failed', note_attempts = ?, note_retry_at = ?, updated_at = ?
    WHERE id = ?
  `).run(attempts, retryAt, ts, id)
}

export function requeueStaleSegments(db: Database.Database = getDb()): number {
  return db.prepare(
    "UPDATE desk_segments SET attribution_state = 'unresolved' WHERE attribution_state = 'queued'"
  ).run().changes
}

/**
 * Is there real unknown work waiting — an unresolved segment that has already
 * accumulated past the noise floor? Below the floor you were looking something
 * up; at or above it, this is work the immediate inference path should classify
 * now rather than making the three-minute Ask wait for the 15-minute sweep.
 */
export function hasUnknownWorkPastFloor(
  opts: { noiseFloorSeconds?: number; now?: string } = {},
  db: Database.Database = getDb()
): boolean {
  const nowIso = opts.now ?? now()
  const row = db.prepare(`
    SELECT 1 FROM desk_segments
    WHERE attribution_state IN ('unresolved', 'failed')
      AND presence_seconds >= ?
      AND (retry_at IS NULL OR retry_at <= ?)
    LIMIT 1
  `).get(opts.noiseFloorSeconds ?? 180, nowIso)
  return !!row
}

export function countUnresolvedSegments(db: Database.Database = getDb()): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM desk_segments WHERE attribution_state IN ('unresolved', 'failed', 'queued')"
  ).get() as { n: number }).n
}

export function linkCapture(segmentId: string, captureId: string, db: Database.Database = getDb()): void {
  db.prepare('INSERT OR IGNORE INTO desk_capture_links (segment_id, capture_id) VALUES (?, ?)').run(segmentId, captureId)
}

/**
 * The last 30 minutes of linked, already-redacted capture text for a block.
 * TaCoS (ICSE 2026) found only the last 30 minutes of activity was worth
 * retaining as relevant resumption context.
 */
export function recentBlockText(
  blockId: string,
  opts: { minutes?: number; limit?: number } = {},
  db: Database.Database = getDb()
): { capturedAt: string; appName: string | null; text: string }[] {
  const cutoff = new Date(Date.now() - (opts.minutes ?? 30) * 60_000).toISOString()
  return db.prepare(`
    SELECT c.captured_at, c.app_name, c.text_content
    FROM desk_capture_links l
    JOIN desk_segments s ON s.id = l.segment_id
    JOIN sense_captures c ON c.id = l.capture_id
    WHERE s.block_id = ? AND c.captured_at >= ? AND c.text_content IS NOT NULL
    ORDER BY c.captured_at DESC
    LIMIT ?
  `).all(blockId, cutoff, opts.limit ?? 12).map((r: unknown) => {
    const row = r as { captured_at: string; app_name: string | null; text_content: string }
    return { capturedAt: row.captured_at, appName: row.app_name, text: row.text_content }
  })
}

// --- runtime (the singleton) ---

export interface DeskRuntime {
  processedCaptureAt: string | null
  processedCaptureId: string | null
  currentBlockId: string | null
  candidateThreadId: string | null
  candidateMatcherId: string | null
  candidateResourceSignature: string | null
  candidateSince: string | null
  candidatePresenceSeconds: number
  lastAssertionAt: string | null
  running: boolean
  updatedAt: string
}

const RUNTIME_DEFAULTS: DeskRuntime = {
  processedCaptureAt: null,
  processedCaptureId: null,
  currentBlockId: null,
  candidateThreadId: null,
  candidateMatcherId: null,
  candidateResourceSignature: null,
  candidateSince: null,
  candidatePresenceSeconds: 0,
  lastAssertionAt: null,
  running: false,
  updatedAt: '',
}

export function getRuntime(db: Database.Database = getDb()): DeskRuntime {
  const row = db.prepare('SELECT * FROM desk_runtime WHERE singleton = 1').get() as Record<string, unknown> | undefined
  if (!row) {
    const ts = now()
    db.prepare('INSERT OR IGNORE INTO desk_runtime (singleton, updated_at) VALUES (1, ?)').run(ts)
    return { ...RUNTIME_DEFAULTS, updatedAt: ts }
  }
  return {
    processedCaptureAt: (row.processed_capture_at as string) ?? null,
    processedCaptureId: (row.processed_capture_id as string) ?? null,
    currentBlockId: (row.current_block_id as string) ?? null,
    candidateThreadId: (row.candidate_thread_id as string) ?? null,
    candidateMatcherId: (row.candidate_matcher_id as string) ?? null,
    candidateResourceSignature: (row.candidate_resource_signature as string) ?? null,
    candidateSince: (row.candidate_since as string) ?? null,
    candidatePresenceSeconds: Number(row.candidate_presence_seconds ?? 0),
    lastAssertionAt: (row.last_assertion_at as string) ?? null,
    running: Number(row.running ?? 0) === 1,
    updatedAt: (row.updated_at as string) ?? '',
  }
}

const RUNTIME_COLUMNS: Record<keyof Omit<DeskRuntime, 'updatedAt'>, string> = {
  processedCaptureAt: 'processed_capture_at',
  processedCaptureId: 'processed_capture_id',
  currentBlockId: 'current_block_id',
  candidateThreadId: 'candidate_thread_id',
  candidateMatcherId: 'candidate_matcher_id',
  candidateResourceSignature: 'candidate_resource_signature',
  candidateSince: 'candidate_since',
  candidatePresenceSeconds: 'candidate_presence_seconds',
  lastAssertionAt: 'last_assertion_at',
  running: 'running',
}

export function setRuntime(patch: Partial<DeskRuntime>, db: Database.Database = getDb()): DeskRuntime {
  getRuntime(db) // ensure the row exists
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, column] of Object.entries(RUNTIME_COLUMNS)) {
    if (!(key in patch)) continue
    const value = (patch as Record<string, unknown>)[key]
    sets.push(`${column} = ?`)
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  if (sets.length === 0) return getRuntime(db)
  sets.push('updated_at = ?')
  values.push(now())
  db.prepare(`UPDATE desk_runtime SET ${sets.join(', ')} WHERE singleton = 1`).run(...values)
  return getRuntime(db)
}

/**
 * The rule-set generation (Phase 2). Bumped on any user rule change or thread
 * merge/rename/archive; a segment whose cache was derived under an older version
 * is stale and the background sweep re-derives it. This is what makes correction
 * retroactive without a migration.
 */
export function getRulesVersion(db: Database.Database = getDb()): number {
  getRuntime(db) // ensure the row exists
  const row = db.prepare('SELECT rules_version FROM desk_runtime WHERE singleton = 1').get() as
    { rules_version: number } | undefined
  return row?.rules_version ?? 1
}

export function bumpRulesVersion(db: Database.Database = getDb()): number {
  getRuntime(db)
  db.prepare('UPDATE desk_runtime SET rules_version = rules_version + 1, updated_at = ? WHERE singleton = 1')
    .run(now())
  return getRulesVersion(db)
}

/** Segments whose cached attribution predates the current rules version. */
export function listStaleAttributions(
  opts: { limit?: number; rulesVersion: number },
  db: Database.Database = getDb()
): DeskSegment[] {
  return (db.prepare(`
    SELECT * FROM desk_segments
    WHERE derived_rules_version < ?
      AND attribution_state IN ('resolved', 'unresolved', 'failed')
    ORDER BY started_at DESC
    LIMIT ?
  `).all(opts.rulesVersion, opts.limit ?? 50) as SegmentRow[]).map(toSegment)
}

/** Stamp the cache's derived-version after a (re-)derivation. */
export function stampDerivedVersion(segmentId: string, rulesVersion: number, db: Database.Database = getDb()): void {
  db.prepare('UPDATE desk_segments SET derived_rules_version = ? WHERE id = ?').run(rulesVersion, segmentId)
}

/** Forget the in-flight candidate without touching the committed block. */
export function clearCandidate(db: Database.Database = getDb()): void {
  setRuntime({
    candidateThreadId: null,
    candidateMatcherId: null,
    candidateResourceSignature: null,
    candidateSince: null,
    candidatePresenceSeconds: 0,
  }, db)
}
