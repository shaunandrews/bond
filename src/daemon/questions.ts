/**
 * The single registry for pending ask_user_question calls.
 *
 * A near-verbatim clone of approvals.ts — same id-space discipline:
 * `questionId` (random UUID minted per question) is the resolution key,
 * `turnId` is the bulk-clear scope. The snapshot is kept alongside the
 * resolver so `question.pending` can serve the CLI without touching the
 * transcript.
 */
import type { PendingQuestion, QuestionAnswer } from '../shared/questions'

type PendingEntry = { turnId: string; snapshot: PendingQuestion; resolve: (answer: QuestionAnswer) => void }

const pending = new Map<string, PendingEntry>()

/** Park a question until a human answers (or the turn is cleared). */
export function registerQuestion(questionId: string, turnId: string, snapshot: PendingQuestion): Promise<QuestionAnswer> {
  return new Promise((resolve) => {
    pending.set(questionId, { turnId, snapshot, resolve })
  })
}

/** Answer a parked question. Returns false when the id is unknown (already resolved or cleared). */
export function resolveQuestion(questionId: string, answer: QuestionAnswer): boolean {
  const entry = pending.get(questionId)
  if (!entry) return false
  pending.delete(questionId)
  entry.resolve(answer)
  return true
}

/** Cancel and drop every question parked by the given turn. */
export function clearTurnQuestions(turnId: string): void {
  for (const [questionId, entry] of pending) {
    if (entry.turnId === turnId) {
      pending.delete(questionId)
      entry.resolve({ kind: 'cancelled' })
    }
  }
}

/** The most recently parked question, for question.pending / the CLI. */
export function currentPendingQuestion(): PendingQuestion | null {
  let last: PendingEntry | undefined
  for (const entry of pending.values()) last = entry
  return last?.snapshot ?? null
}

/** Turn ids with at least one parked question (introspection/tests). */
export function pendingQuestionTurnIds(): string[] {
  return [...new Set([...pending.values()].map((entry) => entry.turnId))]
}

/** The turnId a still-pending question belongs to, without resolving it — lets a resolver look up scope before the entry is gone. */
export function peekQuestionTurnId(questionId: string): string | undefined {
  return pending.get(questionId)?.turnId
}
