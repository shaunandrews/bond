import type { QuestionAnswer, QuestionOption } from '../../shared/questions'

export type TurnActivityStatus = 'working' | 'responding' | 'awaiting_approval' | 'awaiting_question' | 'done' | 'failed' | 'cancelled'

export type TurnActivityEvent =
  | { id: string; type: 'thinking'; label: string; ts: number; endTs?: number; text: string }
  | { id: string; type: 'tool'; label: string; ts: number; endTs?: number; toolUseId?: string; toolName: string; input?: Record<string, unknown>; output?: string; failed?: boolean }
  | { id: string; type: 'responding'; label: string; ts: number; endTs?: number }
  | { id: string; type: 'approval'; label: string; ts: number; endTs?: number; requestId: string; toolName: string; input: Record<string, unknown>; title?: string; description?: string; status: 'pending' | 'approved' | 'denied' | 'cancelled' }
  | { id: string; type: 'question'; label: string; ts: number; endTs?: number; questionId: string; question: string; header?: string; options: QuestionOption[]; status: 'pending' | 'answered' | 'cancelled'; answer?: QuestionAnswer }
  | { id: string; type: 'error'; label: string; ts: number; text: string }

export interface TurnActivityData {
  turnId: string
  userMessageId?: string
  assistantMessageId?: string
  status: TurnActivityStatus
  startedAt: number
  endedAt?: number
  expanded?: boolean
  events: TurnActivityEvent[]
}
