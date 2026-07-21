/**
 * ask_user_question shared contract — daemon-minted option ids, the typed
 * answer union, and the parked-question snapshot served to CLI/renderer.
 */

export interface QuestionOption {
  /** "<questionId>:<index>" — daemon-minted, stable. */
  id: string
  /** 1-based display number. */
  number: number
  label: string
  description: string
}

export type QuestionAnswer =
  | { kind: 'option'; optionId: string; label: string; number: number }
  | { kind: 'custom'; text: string }
  | { kind: 'cancelled' }

export interface PendingQuestion {
  questionId: string
  turnId: string
  question: string
  header?: string
  options: QuestionOption[]
}

/** Validate an answer off the wire. Throws on garbage — callers turn that into RPC_INVALID_PARAMS. */
export function parseQuestionAnswer(value: unknown): QuestionAnswer {
  if (!value || typeof value !== 'object') throw new Error('answer must be an object')
  const v = value as Record<string, unknown>

  if (v.kind === 'option') {
    if (typeof v.optionId !== 'string' || !v.optionId) throw new Error('option answer requires optionId')
    if (typeof v.label !== 'string' || !v.label) throw new Error('option answer requires label')
    if (typeof v.number !== 'number' || !Number.isFinite(v.number)) throw new Error('option answer requires number')
    return { kind: 'option', optionId: v.optionId, label: v.label, number: v.number }
  }
  if (v.kind === 'custom') {
    if (typeof v.text !== 'string' || !v.text.trim()) throw new Error('custom answer requires text')
    return { kind: 'custom', text: v.text }
  }
  if (v.kind === 'cancelled') return { kind: 'cancelled' }

  throw new Error(`unknown answer kind: ${String(v.kind)}`)
}
