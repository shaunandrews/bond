import { describe, it, expect } from 'vitest'
import { registerQuestion, resolveQuestion, clearTurnQuestions, currentPendingQuestion, pendingQuestionTurnIds } from './questions'
import type { PendingQuestion } from '../shared/questions'

function snapshot(questionId: string, turnId: string): PendingQuestion {
  return {
    questionId,
    turnId,
    question: 'Which approach?',
    options: [
      { id: `${questionId}:0`, number: 1, label: 'Balanced', description: 'Middle ground' },
      { id: `${questionId}:1`, number: 2, label: 'Aggressive', description: 'Faster but riskier' },
    ],
  }
}

describe('questions registry', () => {
  it('resolves a registered question by id', async () => {
    const parked = registerQuestion('q-1', 'turn-a', snapshot('q-1', 'turn-a'))
    expect(pendingQuestionTurnIds()).toContain('turn-a')

    const answer = { kind: 'option' as const, optionId: 'q-1:0', label: 'Balanced', number: 1 }
    expect(resolveQuestion('q-1', answer)).toBe(true)
    await expect(parked).resolves.toEqual(answer)
    expect(pendingQuestionTurnIds()).not.toContain('turn-a')
  })

  it('returns false for unknown question ids and double resolution', () => {
    registerQuestion('q-3', 'turn-a', snapshot('q-3', 'turn-a'))
    expect(resolveQuestion('nope', { kind: 'cancelled' })).toBe(false)
    expect(resolveQuestion('q-3', { kind: 'cancelled' })).toBe(true)
    expect(resolveQuestion('q-3', { kind: 'cancelled' })).toBe(false)
  })

  it('clearTurnQuestions cancels every pending question for that turn only', async () => {
    const a1 = registerQuestion('q-a1', 'turn-a', snapshot('q-a1', 'turn-a'))
    const a2 = registerQuestion('q-a2', 'turn-a', snapshot('q-a2', 'turn-a'))
    const b1 = registerQuestion('q-b1', 'turn-b', snapshot('q-b1', 'turn-b'))

    clearTurnQuestions('turn-a')

    await expect(a1).resolves.toEqual({ kind: 'cancelled' })
    await expect(a2).resolves.toEqual({ kind: 'cancelled' })
    expect(pendingQuestionTurnIds()).toEqual(['turn-b'])

    // The other turn's question is still answerable.
    const answer = { kind: 'custom' as const, text: 'do X instead' }
    resolveQuestion('q-b1', answer)
    await expect(b1).resolves.toEqual(answer)
  })

  it('currentPendingQuestion serves the snapshot without touching the transcript', () => {
    expect(currentPendingQuestion()).toBeNull()
    registerQuestion('q-5', 'turn-c', snapshot('q-5', 'turn-c'))
    expect(currentPendingQuestion()).toEqual(snapshot('q-5', 'turn-c'))
    resolveQuestion('q-5', { kind: 'cancelled' })
    expect(currentPendingQuestion()).toBeNull()
  })
})
