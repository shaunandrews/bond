import { describe, expect, it } from 'vitest'
import { parseQuestionAnswer } from './questions'

describe('parseQuestionAnswer', () => {
  it('parses an option answer', () => {
    expect(parseQuestionAnswer({ kind: 'option', optionId: 'q1:0', label: 'Balanced', number: 1 }))
      .toEqual({ kind: 'option', optionId: 'q1:0', label: 'Balanced', number: 1 })
  })

  it('parses a custom answer', () => {
    expect(parseQuestionAnswer({ kind: 'custom', text: 'do X instead' }))
      .toEqual({ kind: 'custom', text: 'do X instead' })
  })

  it('parses a cancelled answer', () => {
    expect(parseQuestionAnswer({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' })
  })

  it('rejects non-objects', () => {
    expect(() => parseQuestionAnswer(null)).toThrow()
    expect(() => parseQuestionAnswer('nope')).toThrow()
  })

  it('rejects an option answer missing fields', () => {
    expect(() => parseQuestionAnswer({ kind: 'option', label: 'x' })).toThrow('optionId')
    expect(() => parseQuestionAnswer({ kind: 'option', optionId: 'q1:0', label: 'x' })).toThrow('number')
  })

  it('rejects a custom answer with blank text', () => {
    expect(() => parseQuestionAnswer({ kind: 'custom', text: '  ' })).toThrow('text')
  })

  it('rejects an unknown kind', () => {
    expect(() => parseQuestionAnswer({ kind: 'nope' })).toThrow('unknown answer kind')
  })
})
