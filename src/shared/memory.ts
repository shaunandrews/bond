import type { TranscriptMessage } from './transcript'

export type MemoryItemKind = 'fact' | 'preference' | 'decision' | 'thread'
export type MemorySource = 'user' | 'assistant' | 'debrief' | 'system'

export interface MemoryItem {
  id: string
  kind: MemoryItemKind
  text: string
  source: MemorySource
  projectId: string | null
  tags: string[]
  confidence: number
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface MemoryItemInput {
  id?: string
  kind?: MemoryItemKind
  text: string
  source?: MemorySource
  projectId?: string | null
  tags?: string[]
  confidence?: number
  active?: boolean
  createdAt?: string
  updatedAt?: string
}

export type WorkingArtifactKind = 'file' | 'library' | 'issue' | 'url'

/**
 * A thing Bond is working ON. Captured deterministically from the tool-event
 * stream, never inferred by a model: Bond wrote the file, so Bond knows the
 * path. The observer is structurally blind to tool activity — it only ever
 * sees user/bond text — so an artifact could previously enter working memory
 * only if someone typed its path into chat.
 */
export interface WorkingArtifact {
  kind: WorkingArtifactKind
  /** Absolute path, issue key (STU-2085), or url. */
  ref: string
  label?: string
  lastTouchedAt: string
}

export interface WorkingState {
  sessionId: string | null
  projectId: string | null
  goal: string
  facts: string[]
  preferences: string[]
  decisions: string[]
  openThreads: string[]
  /** Deterministic-only. LRU by lastTouchedAt. */
  artifacts: WorkingArtifact[]
  /** Deterministic-only: set by a SKILL.md read. */
  activeSkill: string | null
  /** LLM-writable: "audit item 8 of 18 filed; next 9". */
  checkpoint: string | null
  updatedAt: string
}

export interface CoreMemory {
  version: 1
  facts: string[]
  preferences: string[]
  decisions: string[]
  updatedAt: string
}

export interface RetrievedMemory {
  item: MemoryItem
  score: number
}

export interface MemorySourcesResult {
  sourceIds: string[]
  messages: TranscriptMessage[]
}

export type MemoryRunKind = 'observer' | 'reflector'
export type MemoryRunOutcome = 'ok' | 'partial' | 'parse_failed' | 'transport_failed' | 'empty'

export interface MemoryRunSummary {
  kind: MemoryRunKind
  outcome: MemoryRunOutcome
  rangeFrom: number
  rangeTo: number
  persistedCount: number
  skippedCount: number
  reason: string | null
  ranAt: string
}

/**
 * Anything that can degrade must be able to report that it is degrading — to
 * the user, to the CLI, and to Bond in-band. On 2026-07-21 thirty-six memory
 * failures over five hours produced zero signal anywhere; the user noticed
 * before the system did.
 */
export interface MemoryHealth {
  workingUpdatedAt: string | null
  coreUpdatedAt: string | null
  coreItems: number
  maxSeq: number
  observedThroughSeq: number
  reflectedThroughSeq: number
  observerLagSeqs: number
  consecutiveObserverFailures: number
  consecutiveReflectorFailures: number
  lastError: string | null
  lastRuns: MemoryRunSummary[]
}
