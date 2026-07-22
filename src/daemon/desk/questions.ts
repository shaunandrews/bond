/**
 * Asks — the only thing Desk is allowed to say out loud.
 *
 * Every assertion passes one persisted global budget: one Peek-or-Ask per ten
 * minutes, `last_assertion_at` in `desk_runtime` so a restart cannot reset it.
 *
 * **Silence is local consent.** An ignored Ask retracts and commits *this*
 * block, and teaches nothing. Only an explicit answer moves authority — and
 * rejecting is a real state change, not merely a dismissal: it removes the
 * inferred attribution that produced the suggestion, restores or clears the
 * affected block, and suppresses the pairing.
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import {
  clearCandidate,
  clearSegmentAttribution,
  getBlock,
  getRuntime,
  getThread,
  listSegmentsForBlock,
  setRuntime,
  updateBlock,
} from './store'
import { recordLabel } from './labels'
import { dropInferredMatchersForThread, recordRejection } from './matchers'
import { commitSwitch, type SegmenterContext } from './segmenter'
import { DESK_TIMING, type DeskPendingQuestion, type DeskQuestion, type DeskQuestionKind } from '../../shared/desk'

interface QuestionRow {
  id: string
  kind: string
  block_id: string | null
  proposed_thread_id: string | null
  item_id: string | null
  resource_signature: string | null
  state: string
  presented_at: string | null
  expires_at: string
  resolved_at: string | null
  created_at: string
}

function toQuestion(row: QuestionRow): DeskQuestion {
  return {
    id: row.id,
    kind: row.kind as DeskQuestionKind,
    blockId: row.block_id,
    proposedThreadId: row.proposed_thread_id,
    itemId: row.item_id,
    resourceSignature: row.resource_signature,
    state: row.state as DeskQuestion['state'],
    presentedAt: row.presented_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  }
}

/**
 * SQLite cannot express "exactly one of these foreign keys, depending on
 * `kind`" cleanly, so the data layer validates it instead of pretending a
 * CHECK constraint covers it.
 */
export function validateQuestion(input: {
  kind: DeskQuestionKind
  proposedThreadId?: string | null
  itemId?: string | null
  blockId?: string | null
}): string | null {
  if (input.kind === 'thread_switch') {
    if (!input.proposedThreadId) return 'thread_switch requires proposedThreadId'
    return null
  }
  if (input.kind === 'todo_started') {
    if (!input.itemId) return 'todo_started requires itemId'
    return null
  }
  return `unknown question kind: ${input.kind}`
}

export interface AskContext extends SegmenterContext {
  db?: Database.Database
  now?: () => Date
}

function resolveNow(context: AskContext = {}): { db: Database.Database; nowIso: string; nowMs: number } {
  const db = context.db ?? getDb()
  const now = context.now ? context.now() : new Date()
  return { db, nowIso: now.toISOString(), nowMs: now.getTime() }
}

/** Has the ten-minute global budget elapsed? Persisted, so a restart can't reset it. */
export function assertionAllowed(context: AskContext = {}): boolean {
  const { db, nowMs } = resolveNow(context)
  const last = getRuntime(db).lastAssertionAt
  if (!last) return true
  return nowMs - Date.parse(last) >= DESK_TIMING.assertionCooldownSeconds * 1000
}

export function markAsserted(context: AskContext = {}): void {
  const { db, nowIso } = resolveNow(context)
  setRuntime({ lastAssertionAt: nowIso }, db)
}

export function getPendingQuestion(context: AskContext = {}): DeskPendingQuestion | null {
  const { db, nowIso } = resolveNow(context)
  const row = db.prepare(
    "SELECT * FROM desk_questions WHERE state = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
  ).get(nowIso) as QuestionRow | undefined
  if (!row) return null
  const question = toQuestion(row)
  const item = question.itemId
    ? db.prepare('SELECT data FROM collection_items WHERE id = ?').get(question.itemId) as { data: string } | undefined
    : undefined
  let itemTitle: string | null = null
  if (item) {
    try { itemTitle = (JSON.parse(item.data) as { title?: string }).title ?? null } catch { /* garbage */ }
  }
  return {
    ...question,
    proposedThreadName: question.proposedThreadId ? getThread(question.proposedThreadId, db)?.name ?? null : null,
    itemTitle,
  }
}

export function getQuestion(id: string, db: Database.Database = getDb()): DeskQuestion | null {
  const row = db.prepare('SELECT * FROM desk_questions WHERE id = ?').get(id) as QuestionRow | undefined
  return row ? toQuestion(row) : null
}

export interface CreateQuestionInput {
  kind: DeskQuestionKind
  blockId?: string | null
  proposedThreadId?: string | null
  itemId?: string | null
  resourceSignature?: string | null
  ttlSeconds?: number
}

export type CreateQuestionResult =
  | { ok: true; question: DeskQuestion }
  | { ok: false; reason: 'budget' | 'already_pending' | 'invalid' | 'deduped'; detail?: string }

/** Local start-of-day for the same-day dedupe window. */
function startOfDay(nowIso: string): string {
  const d = new Date(nowIso)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/**
 * Was this exact (resource, thread) pairing already answered today? Eleven
 * identical auto-accepts in a day is Desk asking the same question twelve times
 * and learning nothing. The persisted `desk_questions` rows are the dedupe key,
 * so a restart cannot forget it.
 */
export function pairingResolvedToday(
  signature: string,
  threadId: string,
  nowIso: string,
  db: Database.Database = getDb()
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM desk_questions
    WHERE kind = 'thread_switch' AND proposed_thread_id = ? AND resource_signature = ?
      AND state IN ('auto_accepted', 'rejected', 'accepted') AND resolved_at >= ?
    LIMIT 1
  `).get(threadId, signature, startOfDay(nowIso))
  return !!row
}

/**
 * Mint one pending Ask, under the budget. Creating it IS the assertion, so the
 * cooldown starts here rather than when the panel happens to render it.
 */
export function createQuestion(input: CreateQuestionInput, context: AskContext = {}): CreateQuestionResult {
  const { db, nowIso, nowMs } = resolveNow(context)
  const invalid = validateQuestion(input)
  if (invalid) return { ok: false, reason: 'invalid', detail: invalid }
  if (getPendingQuestion(context)) return { ok: false, reason: 'already_pending' }
  // Don't re-ask a pairing already answered today — the block is committed
  // optimistically regardless, so this only silences the redundant Ask.
  if (input.kind === 'thread_switch' && input.proposedThreadId && input.resourceSignature &&
      pairingResolvedToday(input.resourceSignature, input.proposedThreadId, nowIso, db)) {
    return { ok: false, reason: 'deduped' }
  }
  if (!assertionAllowed(context)) return { ok: false, reason: 'budget' }

  const id = randomUUID()
  const expiresAt = new Date(nowMs + (input.ttlSeconds ?? DESK_TIMING.questionTtlSeconds) * 1000).toISOString()
  db.prepare(`
    INSERT INTO desk_questions (id, kind, block_id, proposed_thread_id, item_id, resource_signature,
      state, presented_at, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(id, input.kind, input.blockId ?? null, input.proposedThreadId ?? null, input.itemId ?? null,
    input.resourceSignature ?? null, nowIso, expiresAt, nowIso)

  setRuntime({ lastAssertionAt: nowIso }, db)
  return { ok: true, question: getQuestion(id, db)! }
}

export interface AnswerResult {
  question: DeskQuestion
  committedBlockId?: string
  droppedMatchers?: number
  clearedSegments?: number
}

/**
 * Accepting a `thread_switch` commits the switch. Accepting a `todo_started`
 * moves that item to `in_progress`.
 */
export function acceptQuestion(id: string, context: AskContext = {}): AnswerResult | null {
  const { db, nowIso } = resolveNow(context)
  const question = getQuestion(id, db)
  if (!question || question.state !== 'pending') return null

  const apply = db.transaction((): AnswerResult => {
    db.prepare("UPDATE desk_questions SET state = 'accepted', resolved_at = ? WHERE id = ?").run(nowIso, id)

    if (question.kind === 'thread_switch' && question.proposedThreadId) {
      // The block was committed optimistically when the Ask was raised.
      // Accepting *confirms* it — it must never `commitSwitch` a second time
      // from a live `candidateSince` that may belong to a different candidate
      // by now. If the user has since reassigned the block, their write wins.
      if (question.blockId) {
        const block = getBlock(question.blockId, db)
        if (block && block.threadId === question.proposedThreadId && block.source !== 'manual') {
          updateBlock(question.blockId, { source: 'confirmed', confidence: 1, state: 'committed' }, db)
          // Freeze the accepted attribution as USER labels — but promote NO
          // broad matcher. An Ask is backed by a container signature as often as
          // a concrete one, and blindly confirming `title contains "bond"` is
          // the exact failure this plan exists to fix. A durable *rule* comes
          // only from an explicit reassignment with a concrete pattern.
          for (const segment of listSegmentsForBlock(question.blockId, db)) {
            if (segment.attributedThreadId === question.proposedThreadId) {
              recordLabel({ segmentId: segment.id, threadId: question.proposedThreadId, source: 'user', confidence: 1 }, db)
            }
          }
        }
        return { question: getQuestion(id, db)!, committedBlockId: question.blockId }
      }
      // Legacy question with no stamped block: commit once, now.
      const blockId = commitSwitch(
        question.proposedThreadId,
        { sinceIso: question.createdAt, source: 'confirmed', confidence: 1 },
        { ...context, db }
      )
      return { question: getQuestion(id, db)!, committedBlockId: blockId }
    }

    if (question.kind === 'todo_started' && question.itemId) {
      setItemStatus(question.itemId, 'in_progress', db)
    }
    return { question: getQuestion(id, db)! }
  })

  return apply()
}

/**
 * Rejecting is one transaction and a real state change:
 * mark the question rejected; increment the suppression; delete the
 * unconfirmed matcher that pointed at the rejected thread; clear the affected
 * segment attributions; and re-resolve the block to its previous state.
 *
 * Rejecting a `todo_started` changes no attribution — it only suppresses that
 * question for that block.
 */
export function rejectQuestion(id: string, context: AskContext = {}): AnswerResult | null {
  const { db, nowIso } = resolveNow(context)
  const question = getQuestion(id, db)
  if (!question || question.state !== 'pending') return null

  const apply = db.transaction((): AnswerResult => {
    db.prepare("UPDATE desk_questions SET state = 'rejected', resolved_at = ? WHERE id = ?").run(nowIso, id)

    if (question.kind !== 'thread_switch' || !question.proposedThreadId) {
      return { question: getQuestion(id, db)! }
    }

    // Revert the optimistically-committed block FIRST — before any
    // signature-dependent teaching. A NULL-signature question (every question
    // today, until Phase 3 populates the candidate signature) used to
    // short-circuit here and leave the block attributed to the thread the user
    // just rejected. The block fall-back must never be gated on the signature.
    if (question.blockId) {
      const block = getBlock(question.blockId, db)
      if (block?.threadId === question.proposedThreadId && block.source === 'inferred') {
        updateBlock(question.blockId, { threadId: null, confidence: 0 }, db)
      }
    }
    // The candidate that produced this Ask is gone.
    clearCandidate(db)

    // Without a resource signature there is nothing durable to teach — no
    // suppression key, no matcher to drop — but the block is already restored.
    if (!question.resourceSignature) {
      return { question: getQuestion(id, db)! }
    }

    recordRejection(question.resourceSignature, question.proposedThreadId, { at: nowIso }, db)
    const droppedMatchers = dropInferredMatchersForThread(question.resourceSignature, question.proposedThreadId, db)
    const clearedSegments = clearSegmentAttribution(
      { signature: question.resourceSignature, threadId: question.proposedThreadId }, db
    )

    return { question: getQuestion(id, db)!, droppedMatchers, clearedSegments }
  })

  return apply()
}

/**
 * Silence. On expiry the question becomes `auto_accepted` and commits **only
 * that block** — it never promotes a matcher and never creates a reusable rule.
 */
export function expireQuestions(context: AskContext = {}): AnswerResult[] {
  const { db, nowIso } = resolveNow(context)
  const rows = db.prepare("SELECT * FROM desk_questions WHERE state = 'pending' AND expires_at <= ?")
    .all(nowIso) as QuestionRow[]

  const results: AnswerResult[] = []
  for (const row of rows) {
    const question = toQuestion(row)
    const apply = db.transaction((): AnswerResult => {
      db.prepare("UPDATE desk_questions SET state = 'auto_accepted', resolved_at = ? WHERE id = ?")
        .run(nowIso, question.id)

      if (question.kind === 'thread_switch' && question.proposedThreadId) {
        // Silence auto-accepts THIS block only, and the block is already
        // committed (optimistically, `inferred`). Leave it exactly as it is —
        // committing again would re-date it from a stale candidate clock.
        if (question.blockId) {
          return { question: getQuestion(question.id, db)!, committedBlockId: question.blockId }
        }
        // Legacy question with no stamped block: commit once, now.
        const blockId = commitSwitch(
          question.proposedThreadId,
          { sinceIso: question.createdAt, source: 'inferred', confidence: 0.5 },
          { ...context, db }
        )
        return { question: getQuestion(question.id, db)!, committedBlockId: blockId }
      }
      if (question.kind === 'todo_started' && question.itemId) {
        setItemStatus(question.itemId, 'in_progress', db)
      }
      return { question: getQuestion(question.id, db)! }
    })
    results.push(apply())
  }
  return results
}

/** Turn-scoped teardown — a cancelled question resolves nothing. */
export function cancelPendingQuestions(context: AskContext = {}): number {
  const { db, nowIso } = resolveNow(context)
  return db.prepare("UPDATE desk_questions SET state = 'cancelled', resolved_at = ? WHERE state = 'pending'")
    .run(nowIso).changes
}

/**
 * Today items are ordinary collection items, so their status is a key inside
 * the JSON `data` column rather than a column of its own.
 */
function setItemStatus(itemId: string, status: string, db: Database.Database): void {
  const row = db.prepare('SELECT data FROM collection_items WHERE id = ?').get(itemId) as { data: string } | undefined
  if (!row) return
  let data: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.data)
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch { /* replace garbage rather than fail the answer */ }
  data.status = status
  db.prepare('UPDATE collection_items SET data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(data), new Date().toISOString(), itemId)
}
