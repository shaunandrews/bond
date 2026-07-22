import type { AttachedImage, EditMode } from './session'
import type { QuestionAnswer, QuestionOption } from './questions'
import type { ConversationScope } from './threads'

export interface BondSendInput {
  /** Omitted means the main conversation — see ConversationScope in shared/threads.ts. */
  scope?: ConversationScope
  text: string
  images?: AttachedImage[]
  turnId: string
  userMessageId: string
  assistantMessageId: string
  activityMessageId: string
  editMode?: EditMode
}

export type BondStreamChunk =
  | { kind: 'assistant_text'; text: string; assistantMessageId?: string }
  | { kind: 'thinking_text'; text: string }
  | { kind: 'assistant_tool'; name: string; summary?: string; input?: Record<string, unknown>; toolUseId?: string }
  | { kind: 'tool_result'; toolName: string; toolUseId: string; output?: string; isError?: boolean }
  | { kind: 'system'; subtype: string; text?: string }
  | { kind: 'auth_status'; authenticating: boolean; lines: string[]; error?: string }
  | { kind: 'result'; subtype: string; result?: string; errors?: string[] }
  | { kind: 'tool_approval'; requestId: string; toolName: string; input: Record<string, unknown>; title?: string; description?: string }
  | { kind: 'raw_error'; message: string }
  | { kind: 'usage_update'; inputTokens: number; contextWindow: number; costUsd: number }
  | { kind: 'query_start' }
  | { kind: 'query_end'; succeeded: boolean }
  | { kind: 'queue_update'; queuedTurnIds: string[]; turns: Array<{ turnId: string; text: string; imageIds?: string[] }> }
  /** UI side-effect: open a side panel (onboarding tour's show_panel tool). */
  | { kind: 'show_panel'; panel: 'collections' | 'sense' | 'library' | 'memory' }
  /**
   * UI side-effect: reveal the Desk notch panel (the `open_desk` tool).
   * Not a `show_panel` — Desk is a separate non-activating window owned by
   * main, and `queued` means back-fill is still catching up so main should
   * wait for a populated `desk.status` rather than opening an empty panel.
   */
  | { kind: 'open_desk'; queued: boolean; senseEnabled: boolean }
  /** Tool-generated image(s) persisted to the Bond image store (codex_generate_image). */
  | { kind: 'generated_image'; imageIds: string[]; alt?: string }
  /** A turn began — carries the sender's message ids so other live viewers can mirror the user message and activity row instead of minting duplicates. */
  | { kind: 'turn_start'; turnId: string; userMessageId: string; assistantMessageId: string; activityMessageId: string; text: string; imageIds?: string[] }
  /** A pending tool approval was answered (possibly by another client). */
  | { kind: 'approval_resolved'; requestId: string; approved: boolean }
  /** The global edit mode setting changed (possibly on another device). */
  | { kind: 'edit_mode_changed'; editMode: EditMode }
  /** The agent asked a structured question and is parked until it's answered. */
  | { kind: 'user_question'; questionId: string; question: string; header?: string; options: QuestionOption[] }
  /** A pending question was answered (possibly by another client or the CLI). */
  | { kind: 'question_resolved'; questionId: string; answer: QuestionAnswer }

/** Chunk tagged with global turn/epoch metadata for renderer routing. */
export type TaggedChunk = BondStreamChunk & {
  epochId?: string
  turnId?: string
  /** @deprecated Legacy per-chat routing field. Continuous transcript clients should ignore it. */
  sessionId?: string
  /**
   * Omitted/main means the main conversation. Every turn-scoped chunk (see
   * the four multi-device sync chunks below) carries this so a renderer
   * conversation instance can accept only its own scope's chunks. Truly
   * global events (connection status, edit_mode_changed) omit it.
   */
  scope?: ConversationScope
}
