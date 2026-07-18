import type { AttachedImage } from './session'

export type TranscriptRole = 'user' | 'bond' | 'meta'
export type TurnStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface TranscriptMessage {
  id: string
  epochId?: string | null
  turnId?: string | null
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
  epochId: string
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
