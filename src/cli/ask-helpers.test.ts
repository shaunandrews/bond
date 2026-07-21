import { describe, it, expect } from 'vitest'
import { answerFromArgs, formatQuestionBlock, parseAnswerLine, parseAskArgs } from './ask-helpers'
import type { PendingQuestion, QuestionOption } from '../shared/questions'

const OPTIONS: QuestionOption[] = [
  { id: 'q-1:0', number: 1, label: 'Balanced', description: 'Middle ground' },
  { id: 'q-1:1', number: 2, label: 'Aggressive', description: 'Faster but riskier' },
]

describe('parseAskArgs', () => {
  it('recognizes --json', () => {
    expect(parseAskArgs(['--json'])).toEqual({ mode: 'json' })
  })

  it('recognizes --cancel', () => {
    expect(parseAskArgs(['--cancel'])).toEqual({ mode: 'cancel' })
  })

  it('recognizes --text with a multi-word value', () => {
    expect(parseAskArgs(['--text', 'do', 'X', 'instead'])).toEqual({ mode: 'text', text: 'do X instead' })
  })

  it('recognizes a bare integer as an option number', () => {
    expect(parseAskArgs(['2'])).toEqual({ mode: 'option', number: 2 })
  })

  it('falls back to show for no args or unrecognized input', () => {
    expect(parseAskArgs([])).toEqual({ mode: 'show' })
    expect(parseAskArgs(['nope'])).toEqual({ mode: 'show' })
  })
})

describe('answerFromArgs', () => {
  it('cancel always resolves', () => {
    expect(answerFromArgs({ mode: 'cancel' }, OPTIONS)).toEqual({ kind: 'cancelled' })
  })

  it('text resolves to a custom answer, or null when empty', () => {
    expect(answerFromArgs({ mode: 'text', text: 'do X' }, OPTIONS)).toEqual({ kind: 'custom', text: 'do X' })
    expect(answerFromArgs({ mode: 'text', text: '' }, OPTIONS)).toBeNull()
  })

  it('option resolves against the pending options by number, or null when out of range', () => {
    expect(answerFromArgs({ mode: 'option', number: 2 }, OPTIONS)).toEqual({ kind: 'option', optionId: 'q-1:1', label: 'Aggressive', number: 2 })
    expect(answerFromArgs({ mode: 'option', number: 9 }, OPTIONS)).toBeNull()
  })

  it('show falls through with null', () => {
    expect(answerFromArgs({ mode: 'show' }, OPTIONS)).toBeNull()
  })
})

describe('formatQuestionBlock', () => {
  it('renders the header, question, and numbered options', () => {
    const pending: PendingQuestion = { questionId: 'q-1', turnId: 't-1', question: 'Which approach?', header: 'Decision', options: OPTIONS }
    const block = formatQuestionBlock(pending)
    expect(block).toContain('[Decision]')
    expect(block).toContain('Which approach?')
    expect(block).toContain('1. Balanced — Middle ground')
    expect(block).toContain('2. Aggressive — Faster but riskier')
  })

  it('omits the header line when absent', () => {
    const pending: PendingQuestion = { questionId: 'q-1', turnId: 't-1', question: 'Which?', options: OPTIONS }
    expect(formatQuestionBlock(pending)).not.toContain('[')
  })
})

describe('parseAnswerLine', () => {
  it('a bare in-range number selects that option', () => {
    expect(parseAnswerLine('2', OPTIONS)).toEqual({ kind: 'option', optionId: 'q-1:1', label: 'Aggressive', number: 2 })
  })

  it('an out-of-range number falls through to a custom answer', () => {
    expect(parseAnswerLine('9', OPTIONS)).toEqual({ kind: 'custom', text: '9' })
  })

  it('empty input cancels', () => {
    expect(parseAnswerLine('', OPTIONS)).toEqual({ kind: 'cancelled' })
    expect(parseAnswerLine('   ', OPTIONS)).toEqual({ kind: 'cancelled' })
  })

  it('free text becomes a custom answer', () => {
    expect(parseAnswerLine('actually, do X instead', OPTIONS)).toEqual({ kind: 'custom', text: 'actually, do X instead' })
  })
})
