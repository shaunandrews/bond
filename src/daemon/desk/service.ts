/**
 * The RPC-facing Desk service.
 *
 * Everything the `desk.*` methods, the `bond desk` CLI, and (later) the notch
 * panel talk to. Composes the store, matchers, segmenter, questions, Today, and
 * stats into the handful of operations a surface actually performs — and owns
 * the `desk.changed` broadcast so the notch, the right panel, and a second
 * window stay in lockstep.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import {
  archiveThread as archiveThreadRow,
  clearCandidate,
  createBlock,
  createThread,
  getBlock,
  getBlockDetail,
  getRuntime,
  getThread,
  listBlocks,
  listInFlight,
  listThreads,
  listSegmentsForBlock,
  renameThread as renameThreadRow,
  setRuntime,
  updateBlock,
  countUnresolvedSegments,
} from './store'
import {
  confirmMatcher,
  deleteMatcher as deleteMatcherRow,
  listMatchers,
  repointMatcherByUser,
  setMatcherEnabled,
} from './matchers'
import { mergeThreads as mergeThreadsTxn, type MergeResult } from './merge'
import { acceptQuestion, getPendingQuestion, rejectQuestion } from './questions'
import { computeStats } from './stats'
import { carryTodo, ensureToday, linkTodo, listToday, unlinkTodo } from './today'
import { isGenericBundle, normalizePattern } from './signature'
import type {
  DeskBlockDetail,
  DeskMatcher,
  DeskMatcherField,
  DeskMatcherOperator,
  DeskStats,
  DeskStatus,
  DeskThread,
} from '../../shared/desk'
import type { CollectionItem } from '../../shared/session'

// --- change broadcast ---

type ChangeListener = () => void
let listeners: ChangeListener[] = []

export function onDeskChanged(fn: ChangeListener): () => void {
  listeners.push(fn)
  return () => { listeners = listeners.filter(l => l !== fn) }
}

export function emitDeskChanged(): void {
  for (const fn of listeners) {
    try { fn() } catch (error) { console.error('[desk] change listener failed:', error) }
  }
}

/** Test seam — the daemon never needs to drop its own listeners. */
export function resetDeskListenersForTest(): void {
  listeners = []
  senseStateProvider = null
}

// --- Sense state ---

/**
 * Desk reads Sense; Sense never knows Desk exists. The controller itself lives
 * in `server.ts`, so the daemon registers a reader here rather than Desk
 * importing the server (and the whole RPC surface with it).
 *
 * With no provider registered — the CLI, a test — Desk reports Sense disabled
 * and shows historical threads only, which is exactly the documented behaviour.
 */
export type SenseStateProvider = () => { state: DeskStatus['senseState']; enabled: boolean }
let senseStateProvider: SenseStateProvider | null = null

export function setSenseStateProvider(provider: SenseStateProvider | null): void {
  senseStateProvider = provider
}

// --- status ---

export function getStatus(db: Database.Database = getDb()): DeskStatus {
  const runtime = getRuntime(db)
  let senseState: DeskStatus['senseState'] = 'disabled'
  let senseEnabled = false
  try {
    const sense = senseStateProvider?.()
    if (sense) {
      senseState = sense.state
      senseEnabled = sense.enabled
    }
  } catch {
    // A Sense read must never take Desk's status down with it.
  }

  const currentBlock = runtime.currentBlockId ? getBlockDetail(runtime.currentBlockId, db) : null
  return {
    running: runtime.running,
    senseState,
    senseEnabled,
    currentBlock,
    presenceSeconds: currentBlock?.presenceSeconds ?? 0,
    pendingQuestion: getPendingQuestion({ db }),
    lastAssertionAt: runtime.lastAssertionAt,
    // Back-fill is "still catching up" until the checkpoint has reached the
    // newest eligible capture. An empty panel on first open is the failure mode.
    backfilling: isBackfilling(db),
    unresolvedSegments: countUnresolvedSegments(db),
  }
}

function isBackfilling(db: Database.Database): boolean {
  const newest = db.prepare(
    "SELECT captured_at FROM sense_captures WHERE (image_path IS NOT NULL OR image_purged_at IS NOT NULL) ORDER BY captured_at DESC LIMIT 1"
  ).get() as { captured_at: string } | undefined
  if (!newest) return false
  const runtime = getRuntime(db)
  if (!runtime.processedCaptureAt) return true
  // Within a couple of minutes of the newest capture counts as caught up.
  return Date.parse(newest.captured_at) - Date.parse(runtime.processedCaptureAt) > 120_000
}

/**
 * `running` is explicit persisted Desk state, independent of Sense's capture
 * setting. Observed activity alone never turns Desk on.
 */
export function setRunning(running: boolean, db: Database.Database = getDb()): DeskStatus {
  setRuntime({ running }, db)
  emitDeskChanged()
  return getStatus(db)
}

// --- blocks ---

export function getBlocks(
  range: { from?: string; to?: string; limit?: number } = {},
  db: Database.Database = getDb()
): DeskBlockDetail[] {
  return listBlocks(range, db)
}

export function getInFlight(
  opts: { since?: string; limit?: number } = {},
  db: Database.Database = getDb()
): DeskBlockDetail[] {
  return listInFlight(opts, db)
}

// --- thread catalogue ---

export function getThreads(includeArchived = false, db: Database.Database = getDb()): DeskThread[] {
  return listThreads({ includeArchived }, db)
}

export function createUserThread(name: string, db: Database.Database = getDb()): DeskThread {
  const thread = createThread({ name, source: 'user' }, db)
  emitDeskChanged()
  return thread
}

export function renameThread(id: string, name: string, db: Database.Database = getDb()): DeskThread | null {
  const thread = renameThreadRow(id, name, db)
  emitDeskChanged()
  return thread
}

export function archiveThread(id: string, archived: boolean, db: Database.Database = getDb()): DeskThread | null {
  const thread = archiveThreadRow(id, archived, db)
  emitDeskChanged()
  return thread
}

export function mergeThreads(targetId: string, sourceId: string, db: Database.Database = getDb()): MergeResult | null {
  const result = mergeThreadsTxn(targetId, sourceId, db)
  if (result) emitDeskChanged()
  return result
}

// --- reassignment ---

export interface ConfirmedMatcherInput {
  field: DeskMatcherField
  operator: DeskMatcherOperator
  pattern: string
}

export interface ReassignResult {
  block: DeskBlockDetail
  matcher: DeskMatcher | null
  /** What Bond says out loud, once. */
  learned: string
}

/**
 * Any block, one click, reassign. The block updates immediately; the rule write
 * happens behind it.
 *
 * The same gesture confirms a durable rule ONLY when the caller supplies a
 * concrete pattern. Generic apps — Chrome, Terminal, Finder, Slack, VS Code —
 * never become bundle-wide rules merely because a block was corrected.
 */
export function reassignBlock(
  input: { blockId: string; threadId: string; confirmedMatcher?: ConfirmedMatcherInput },
  db: Database.Database = getDb()
): ReassignResult | null {
  const block = getBlock(blockId(input), db)
  if (!block) return null
  const thread = getThread(input.threadId, db)
  if (!thread) return null

  const segments = listSegmentsForBlock(block.id, db)
  const signature = segments[0]?.resourceSignature ?? null
  const evidence = segments[0]?.evidence ?? {}

  const apply = db.transaction((): ReassignResult => {
    updateBlock(block.id, { threadId: input.threadId, source: 'manual', confidence: 1, state: 'committed' }, db)

    for (const segment of segments) {
      db.prepare(`
        UPDATE desk_segments
        SET attributed_thread_id = ?, attribution_confidence = 1, attribution_state = 'resolved', attributed_at = ?
        WHERE id = ?
      `).run(input.threadId, new Date().toISOString(), segment.id)
    }

    let matcher: DeskMatcher | null = null
    let learned = `Moved this block to ${thread.name}.`

    if (input.confirmedMatcher) {
      const rejection = rejectGenericPattern(input.confirmedMatcher, evidence.bundleId ?? null)
      if (rejection) {
        learned = rejection
      } else {
        matcher = confirmMatcher({ ...input.confirmedMatcher, threadId: input.threadId, example: evidence }, db)
        learned = `Got it — ${describeMatcher(input.confirmedMatcher)} will go to ${thread.name}.`
      }
    } else if (signature) {
      // No named pattern: store a one-resource attribution and ask nothing further.
      matcher = repointMatcherByUser(
        { field: 'resource', operator: 'exact', pattern: signature, threadId: input.threadId, example: evidence },
        db
      )
    }

    return { block: getBlockDetail(block.id, db)!, matcher, learned }
  })

  const result = apply()
  emitDeskChanged()
  return result
}

function blockId(input: { blockId: string }): string {
  return input.blockId
}

function describeMatcher(matcher: ConfirmedMatcherInput): string {
  if (matcher.field === 'title') return `windows titled "${matcher.pattern}"`
  if (matcher.field === 'path') return `files under ${matcher.pattern}`
  if (matcher.field === 'bundle') return `${matcher.pattern}`
  return `this resource`
}

/**
 * A bundle rule for a generic app would claim every future browser tab or
 * terminal window from one correction. Refuse, and say so plainly.
 */
export function rejectGenericPattern(
  matcher: ConfirmedMatcherInput,
  bundleId: string | null
): string | null {
  if (matcher.field !== 'bundle') return null
  const target = matcher.pattern || bundleId
  if (!isGenericBundle(target)) return null
  return `Moved this block, but ${target} covers too much to become a rule.`
}

// --- notes ---

/**
 * A user edit sets `note_status='edited'`, which inference is never allowed to
 * overwrite and which retention graduates onto the thread.
 */
export function updateNote(blockId: string, note: string, db: Database.Database = getDb()): DeskBlockDetail | null {
  const trimmed = note.trim()
  updateBlock(blockId, {
    reentryNote: trimmed || null,
    noteStatus: trimmed ? 'edited' : 'none',
  }, db)
  emitDeskChanged()
  return getBlockDetail(blockId, db)
}

// --- questions ---

export function answerQuestion(
  questionId: string,
  accepted: boolean,
  context: { db?: Database.Database; now?: () => Date } = {}
) {
  const result = accepted ? acceptQuestion(questionId, context) : rejectQuestion(questionId, context)
  if (result) emitDeskChanged()
  return result
}

// --- the buried rules editor ---

export function getMatchers(confirmedOnly = true, db: Database.Database = getDb()): DeskMatcher[] {
  return listMatchers({ confirmedOnly }, db)
}

export function disableMatcher(id: string, db: Database.Database = getDb()): DeskMatcher | null {
  const matcher = setMatcherEnabled(id, false, db)
  emitDeskChanged()
  return matcher
}

export function deleteMatcher(id: string, db: Database.Database = getDb()): boolean {
  const deleted = deleteMatcherRow(id, db)
  if (deleted) emitDeskChanged()
  return deleted
}

// --- Today ---

export function getToday(now?: Date, db: Database.Database = getDb()) {
  const { collection, items, day } = listToday({ now, db })
  const links = db.prepare('SELECT item_id, thread_id FROM desk_todo_links').all() as
    { item_id: string; thread_id: string | null }[]
  const byItem = new Map(links.map(l => [l.item_id, l.thread_id]))
  return {
    collectionId: collection.id,
    day,
    items: items.map(item => ({ ...item, threadId: byItem.get(item.id) ?? null })),
  }
}

export function linkTodoToThread(itemId: string, threadId: string, db: Database.Database = getDb()) {
  const link = linkTodo(itemId, threadId, db)
  emitDeskChanged()
  return link
}

export function unlinkTodoFromThread(itemId: string, db: Database.Database = getDb()): boolean {
  const removed = unlinkTodo(itemId, db)
  if (removed) emitDeskChanged()
  return removed
}

export function carryTodoForward(itemId: string, now?: Date, db: Database.Database = getDb()): CollectionItem | null {
  const item = carryTodo(itemId, { now, db })
  if (item) emitDeskChanged()
  return item
}

export function ensureTodayCollection(db: Database.Database = getDb()) {
  return ensureToday(db)
}

// --- stats ---

export function getStats(windowHours?: number, db: Database.Database = getDb()): DeskStats {
  return computeStats({ windowHours, db })
}

// --- manual block creation (a user naming work Desk did not observe) ---

export function startBlock(threadId: string, db: Database.Database = getDb()): DeskBlockDetail {
  const runtime = getRuntime(db)
  const now = new Date().toISOString()
  const create = db.transaction(() => {
    if (runtime.currentBlockId) {
      updateBlock(runtime.currentBlockId, { endedAt: now, state: 'committed' }, db)
    }
    const block = createBlock({ threadId, startedAt: now, source: 'manual', confidence: 1 }, db)
    setRuntime({ currentBlockId: block.id }, db)
    clearCandidate(db)
    return block.id
  })
  const id = create()
  emitDeskChanged()
  return getBlockDetail(id, db)!
}

/** Exposed for the CLI's `matchers` output, which prints normalized patterns. */
export { normalizePattern }
