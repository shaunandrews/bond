/**
 * Desk — the surface that tracks the work threads currently in flight.
 *
 * Desk reads Sense; Sense never knows Desk exists. These are the wire types
 * shared by the daemon, the renderer, and the `bond desk` CLI.
 */
import type { SenseState } from './sense'

export type DeskThreadStatus = 'provisional' | 'established' | 'archived'
export type DeskAuthorSource = 'inferred' | 'user'
export type DeskBlockState = 'candidate' | 'committed' | 'dismissed'
export type DeskBlockSource = 'inferred' | 'confirmed' | 'manual'
export type DeskNoteStatus = 'none' | 'pending' | 'ready' | 'failed' | 'edited'
export type DeskAttributionState = 'unresolved' | 'queued' | 'resolved' | 'failed'
export type DeskMatcherField = 'bundle' | 'title' | 'path' | 'resource'
export type DeskMatcherOperator = 'exact' | 'prefix' | 'contains'
export type DeskQuestionKind = 'thread_switch' | 'todo_started'
export type DeskQuestionState = 'pending' | 'accepted' | 'rejected' | 'auto_accepted' | 'cancelled'

export interface DeskThread {
  id: string
  name: string
  normalizedName: string
  colorSeed: string
  status: DeskThreadStatus
  source: DeskAuthorSource
  userNote: string | null
  userNoteUpdatedAt: string | null
  lastSeenAt: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DeskBlock {
  id: string
  threadId: string | null
  startedAt: string
  endedAt: string | null
  presenceSeconds: number
  state: DeskBlockState
  summary: string | null
  reentryNote: string | null
  noteStatus: DeskNoteStatus
  confidence: number
  source: DeskBlockSource
  createdAt: string
  updatedAt: string
}

/** A block joined with its thread and (optionally) its segments, for display. */
export interface DeskBlockDetail extends DeskBlock {
  thread: DeskThread | null
  segments?: DeskSegment[]
}

/**
 * The evidence snapshot a segment keeps. Every string here has already been
 * through `redact()` — Desk transmits and persists these, unlike Sense which
 * only ever displays them back to their owner.
 */
export interface DeskEvidence {
  appName?: string
  bundleId?: string
  titles?: string[]
  paths?: string[]
}

export interface DeskSegment {
  id: string
  blockId: string | null
  startedAt: string
  endedAt: string | null
  presenceSeconds: number
  resourceSignature: string
  evidence: DeskEvidence
  attributionState: DeskAttributionState
  attributedThreadId: string | null
  matcherId: string | null
  attributionConfidence: number
  attributedAt: string | null
  inferenceAttempts: number
  retryAt: string | null
  createdAt: string
}

export interface DeskMatcher {
  id: string
  threadId: string
  field: DeskMatcherField
  operator: DeskMatcherOperator
  pattern: string
  normalizedPattern: string
  confirmed: boolean
  source: DeskAuthorSource
  confidence: number
  specificity: number
  example: DeskEvidence
  enabled: boolean
  hits: number
  lastSeenAt: string | null
  exampleUpdatedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DeskQuestion {
  id: string
  kind: DeskQuestionKind
  blockId: string | null
  proposedThreadId: string | null
  itemId: string | null
  resourceSignature: string | null
  state: DeskQuestionState
  presentedAt: string | null
  expiresAt: string
  resolvedAt: string | null
  createdAt: string
}

/** A pending question with everything the surface needs to render one line. */
export interface DeskPendingQuestion extends DeskQuestion {
  proposedThreadName: string | null
  itemTitle: string | null
}

export interface DeskStatus {
  running: boolean
  senseState: SenseState
  senseEnabled: boolean
  /** The block Desk currently believes you are in, if any. */
  currentBlock: DeskBlockDetail | null
  /** Summed presence on the current block, in seconds. Never wall-clock span. */
  presenceSeconds: number
  pendingQuestion: DeskPendingQuestion | null
  lastAssertionAt: string | null
  /** True until the first sweep has caught up with existing Sense captures. */
  backfilling: boolean
  unresolvedSegments: number
}

/** Instrumentation the Phase 2 dogfood go/no-go reads through `bond desk stats`. */
export interface DeskStats {
  windowHours: number
  modelCalls: number
  failedCalls: number
  immediateCalls: number
  sweptCalls: number
  segmentsInferred: number
  promptChars: number
  avgLatencyMs: number
  /** Share of segments resolved by a matcher rather than a model call. */
  cacheHitRate: number
  segmentsResolvedByMatcher: number
  segmentsResolvedByModel: number
  unresolvedSegments: number
  /** Median seconds from segment start to attribution, for unknown resources. */
  medianUnknownLatencySeconds: number | null
  blocks: number
  threads: number
  matchers: number
  confirmedMatchers: number
}

/** Coarse, deliberately imprecise duration. `~1h 20m`, never `1h 23m`. */
export function formatApproxDuration(seconds: number): string {
  if (seconds < 60) return '~1m'
  const totalMinutes = Math.round(seconds / 60)
  if (totalMinutes < 60) return `~${Math.max(1, Math.round(totalMinutes / 5) * 5)}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = Math.round((totalMinutes % 60) / 5) * 5
  if (minutes === 0) return `~${hours}h`
  if (minutes === 60) return `~${hours + 1}h`
  return `~${hours}h ${minutes}m`
}

/** Desk's three timescales. Empirically settled; see plans/desk.md. */
export const DESK_TIMING = {
  /** Below this you are looking something up, not switching tasks. */
  noiseFloorSeconds: 180,
  /** The rolling window switch detection smooths over. */
  smoothingWindowSeconds: 180,
  /** Average dwell in one coherent thread — the altitude Desk operates at. */
  workingSphereSeconds: 700,
  /** The evidence-based idle threshold. Not Sense's 60-*second* presence one. */
  sessionGapSeconds: 3600,
  /** One Peek-or-Ask per this many seconds, persisted across restarts. */
  assertionCooldownSeconds: 600,
  /** How long an Ask waits before silence commits the block. */
  questionTtlSeconds: 1200,
} as const

export const DESK_TODAY_COLLECTION_SETTING = 'desk.today_collection_id'
export const DESK_TODAY_PREFIX = 'TODAY'

/**
 * The user's *current* local day. Midnight refreshes the query, never stored
 * dates — an item stays on the day it was filed until explicitly carried.
 */
export function localDay(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
