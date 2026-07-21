/**
 * ask_user_question — Bond's own Pi tool for pausing a turn on one
 * structured, numbered multiple-choice question and resuming with a typed
 * answer.
 *
 * Pi's own ctx.ui question examples bail unless running in a TUI with a real
 * stdin/stdout — Bond runs Pi inside the daemon with no terminal. This
 * clones the tool_approval pattern instead: emit a chunk, park a promise in
 * the questions registry, resume the turn on resolution. `clearTurnQuestions`
 * (wired at every turn-abort site, same as clearTurnApprovals) is the primary
 * cancellation path; the abort listener here is defence in depth for a
 * registered turnId that never reaches that plumbing (e.g. a direct test).
 */

import { randomUUID } from 'node:crypto'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { BondStreamChunk } from '../../shared/stream'
import type { PendingQuestion, QuestionAnswer, QuestionOption } from '../../shared/questions'
import { registerQuestion, resolveQuestion } from '../questions'

export const QUESTION_TOOL_NAMES = ['ask_user_question']

export interface QuestionToolOptions {
  turnId?: string
  onChunk?: (chunk: BondStreamChunk) => void
  abortSignal?: AbortSignal
}

function resultText(answer: QuestionAnswer, options: QuestionOption[]): string {
  if (answer.kind === 'option') {
    const description = options.find(o => o.id === answer.optionId)?.description
    return `User selected option ${answer.number}: ${answer.label}${description ? ` — ${description}` : ''}`
  }
  if (answer.kind === 'custom') return `User wrote a custom answer: ${answer.text}`
  return 'User dismissed the question without answering. Do not ask again — proceed with your best judgment or ask in plain prose.'
}

export function registerQuestionTools(pi: ExtensionAPI, options: QuestionToolOptions = {}): void {
  pi.registerTool({
    name: 'ask_user_question',
    label: 'Ask User Question',
    executionMode: 'sequential',
    description: 'Ask the user one multiple-choice question and wait for their answer. Use when a decision is genuinely the user\'s to make and you cannot resolve it from the request, the code, or a sensible default.',
    promptSnippet: 'Ask the user one structured multiple-choice question and wait for the answer',
    promptGuidelines: [
      'Use ask_user_question only when the answer changes what you do next — never for choices with an obvious default or facts you can look up yourself.',
      'Give ask_user_question 2-4 options. Each option needs a short label and a description that names the trade-off.',
      'Put the recommended option first and suffix its label with "(Recommended)".',
      'Never add an "Other" option to ask_user_question — the user can always type a custom answer.',
      'Ask at most one ask_user_question per turn; if the user dismisses it, proceed with your best judgment instead of asking again.',
    ],
    parameters: Type.Object({
      question: Type.String({ description: 'The full question, ending in "?"' }),
      header: Type.Optional(Type.String({ description: 'Short chip label, 12 chars max' })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: '1-5 word display text' }),
          description: Type.String({ description: 'What this choice means or implies' }),
        }),
        { minItems: 2, maxItems: 6, description: 'Choices for the user' },
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const abortSignal = signal ?? options.abortSignal
      const turnId = options.turnId ?? ''
      const questionId = randomUUID()
      const questionOptions: QuestionOption[] = params.options.map((opt, index) => ({
        id: `${questionId}:${index}`,
        number: index + 1,
        label: opt.label,
        description: opt.description,
      }))
      const snapshot: PendingQuestion = {
        questionId,
        turnId,
        question: params.question,
        header: params.header,
        options: questionOptions,
      }

      options.onChunk?.({ kind: 'user_question', questionId, question: params.question, header: params.header, options: questionOptions })

      const parked = registerQuestion(questionId, turnId, snapshot)
      const onAbort = () => resolveQuestion(questionId, { kind: 'cancelled' })
      abortSignal?.addEventListener('abort', onAbort, { once: true })

      let answer: QuestionAnswer
      try {
        answer = await parked
      } finally {
        abortSignal?.removeEventListener('abort', onAbort)
      }

      return {
        content: [{ type: 'text' as const, text: resultText(answer, questionOptions) }],
        details: answer,
      }
    },
  })
}

export function createQuestionExtensionFactory(options: QuestionToolOptions = {}) {
  return (pi: ExtensionAPI) => registerQuestionTools(pi, options)
}
