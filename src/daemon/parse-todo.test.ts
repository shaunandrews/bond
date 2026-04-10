import { describe, it, expect, vi } from 'vitest'

// Mock the agent SDK before importing
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}))

import { parseTodoInput } from './parse-todo'
import { query } from '@anthropic-ai/claude-agent-sdk'

const mockedQuery = vi.mocked(query)

describe('parseTodoInput', () => {
  it('returns empty fields for empty input', async () => {
    const result = await parseTodoInput('')
    expect(result).toEqual({ title: '', notes: '', group: '' })
  })

  it('returns empty fields for whitespace-only input', async () => {
    const result = await parseTodoInput('   ')
    expect(result).toEqual({ title: '', notes: '', group: '' })
  })

  it('returns short single-line input as-is (no AI)', async () => {
    const result = await parseTodoInput('Buy milk')
    expect(result).toEqual({ title: 'Buy milk', notes: '', group: '' })
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('treats short single-line under 60 chars as simple title', async () => {
    const result = await parseTodoInput('Fix the login bug on the settings page')
    expect(result.title).toBe('Fix the login bug on the settings page')
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('calls AI for multi-line input', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: '{"title": "Fix bug", "notes": "In the login flow", "group": "work"}' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await parseTodoInput('Fix the bug\nIt\'s in the login flow\nHigh priority')
    expect(result.title).toBe('Fix bug')
    expect(result.notes).toBe('In the login flow')
    expect(result.group).toBe('work')
  })

  it('calls AI for long single-line input (>= 60 chars)', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: '{"title": "Review proposal", "notes": "Full review needed", "group": "work"}' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const longInput = 'Review the entire product proposal document and provide detailed feedback on all sections'
    const result = await parseTodoInput(longInput)
    expect(result.title).toBe('Review proposal')
    expect(mockedQuery).toHaveBeenCalled()
  })

  it('falls back to first-line split on API error', async () => {
    mockedQuery.mockImplementation(() => { throw new Error('API down') })

    const result = await parseTodoInput('First line title\nSome extra detail\nMore notes')
    expect(result.title).toBe('First line title')
    expect(result.notes).toBe('Some extra detail\nMore notes')
    expect(result.group).toBe('')
  })

  it('falls back when AI returns non-JSON', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: 'Sorry I cannot parse that' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await parseTodoInput('Some long input\nthat spans multiple lines')
    expect(result.title).toBe('Some long input\nthat spans multiple lines')
  })

  it('truncates title to 120 chars', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: `{"title": "${'x'.repeat(200)}", "notes": "", "group": ""}` }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await parseTodoInput('A very long description\nthat needs parsing')
    expect(result.title.length).toBeLessThanOrEqual(120)
  })

  it('truncates notes to 2000 chars', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: `{"title": "Test", "notes": "${'n'.repeat(3000)}", "group": ""}` }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await parseTodoInput('Test\nwith long content')
    expect(result.notes.length).toBeLessThanOrEqual(2000)
  })

  it('truncates group to 30 chars', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: `{"title": "Test", "notes": "", "group": "${'g'.repeat(50)}"}` }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await parseTodoInput('Test\nwith group')
    expect(result.group.length).toBeLessThanOrEqual(30)
  })
})
