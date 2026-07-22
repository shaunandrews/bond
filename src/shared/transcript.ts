import type { AttachedImage } from './session'

export type TranscriptRole = 'user' | 'bond' | 'meta'
export type TurnStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface TranscriptMessage {
  id: string
  epochId?: string | null
  turnId?: string | null
  /** null/absent means the main conversation. */
  threadId?: string | null
  seq?: number
  role: TranscriptRole
  kind?: string | null
  text?: string | null
  data?: Record<string, unknown> | null
  images?: AttachedImage[]
  imageIds?: string[]
  createdAt?: string
  updatedAt?: string
}

export interface InsertTurnStartInput {
  epochId?: string | null
  /** null/absent means the main conversation; must match the epoch's own scope. */
  threadId?: string | null
  turnId: string
  userMessageId: string
  assistantMessageId: string
  activityMessageId: string
  text: string
  model?: string | null
  imageIds?: string[]
  activityData?: Record<string, unknown>
  now?: string
}

export interface CompleteTurnInput {
  turnId: string
  status: TurnStatus
  contextTokens?: number | null
  contextWindow?: number | null
  completedAt?: string
}

export interface TranscriptPage {
  messages: TranscriptMessage[]
  nextBeforeSeq: number | null
}
