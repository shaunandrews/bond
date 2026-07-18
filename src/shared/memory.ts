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

export interface WorkingState {
  sessionId: string | null
  projectId: string | null
  goal: string
  facts: string[]
  preferences: string[]
  decisions: string[]
  openThreads: string[]
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
