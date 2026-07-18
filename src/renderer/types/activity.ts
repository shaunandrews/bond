export type TurnActivityStatus = 'working' | 'responding' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled'

export type TurnActivityEvent =
  | { id: string; type: 'thinking'; label: string; ts: number; endTs?: number; text: string }
  | { id: string; type: 'tool'; label: string; ts: number; endTs?: number; toolUseId?: string; toolName: string; input?: Record<string, unknown>; output?: string; failed?: boolean }
  | { id: string; type: 'responding'; label: string; ts: number; endTs?: number }
  | { id: string; type: 'approval'; label: string; ts: number; endTs?: number; requestId: string; toolName: string; input: Record<string, unknown>; title?: string; description?: string; status: 'pending' | 'approved' | 'denied' | 'cancelled' }
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
