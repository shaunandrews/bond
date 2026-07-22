export const MEMORY_ITEM_KINDS = ['fact', 'preference', 'decision', 'thread'] as const
export type MemoryItemKind = typeof MEMORY_ITEM_KINDS[number]

export const MEMORY_SOURCES = ['user', 'assistant', 'debrief', 'system'] as const
export type MemorySource = typeof MEMORY_SOURCES[number]

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

export const WORKING_ARTIFACT_KINDS = ['file', 'library', 'issue', 'url'] as const
export type WorkingArtifactKind = typeof WORKING_ARTIFACT_KINDS[number]

/** Mirrors `WorkingArtifact` in shared/memory.ts — keep the two identical. */
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
  /** Deterministic-only (tool events). The model may not write this. */
  artifacts: WorkingArtifact[]
  /** Deterministic-only: set by a SKILL.md read. */
  activeSkill: string | null
  /** LLM-writable: the user's position in the active work. */
  checkpoint: string | null
  updatedAt: string
}

export function isWorkingArtifactKind(value: unknown): value is WorkingArtifactKind {
  return typeof value === 'string' && (WORKING_ARTIFACT_KINDS as readonly string[]).includes(value)
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

export type MemoryValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] }

export const MEMORY_CAPS = {
  textChars: 2_000,
  tagChars: 48,
  tags: 12,
  workingGoalChars: 1_000,
  workingListItemChars: 500,
  workingFacts: 24,
  workingPreferences: 16,
  workingDecisions: 16,
  workingOpenThreads: 16,
  workingArtifacts: 8,
  artifactRefChars: 500,
  artifactLabelChars: 200,
  checkpointChars: 200,
  activeSkillChars: 100,
  coreFacts: 80,
  corePreferences: 80,
  coreDecisions: 80,
  coreItemChars: 500,
  queryTerms: 8,
  searchLimit: 25,
} as const

export function isMemoryItemKind(value: unknown): value is MemoryItemKind {
  return typeof value === 'string' && (MEMORY_ITEM_KINDS as readonly string[]).includes(value)
}

export function isMemorySource(value: unknown): value is MemorySource {
  return typeof value === 'string' && (MEMORY_SOURCES as readonly string[]).includes(value)
}
