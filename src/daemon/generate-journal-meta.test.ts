import { describe, it, expect, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}))

import { generateJournalMeta } from './generate-journal-meta'
import { query } from '@anthropic-ai/claude-agent-sdk'

const mockedQuery = vi.mocked(query)

describe('generateJournalMeta', () => {
  it('returns defaults for empty body', async () => {
    const result = await generateJournalMeta('')
    expect(result).toEqual({ title: 'Untitled', tags: [] })
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('returns defaults for whitespace-only body', async () => {
    const result = await generateJournalMeta('   ')
    expect(result).toEqual({ title: 'Untitled', tags: [] })
  })

  it('parses valid AI response', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: '{"title": "Project Update", "tags": ["work", "progress"]}' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateJournalMeta('Today I made progress on the dashboard redesign.')
    expect(result.title).toBe('Project Update')
    expect(result.tags).toEqual(['work', 'progress'])
  })

  it('lowercases and truncates tags', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: '{"title": "T", "tags": ["UPPER", "Mixed"]}' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateJournalMeta('Test body text')
    expect(result.tags).toEqual(['upper', 'mixed'])
  })

  it('limits to 6 tags', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: '{"title": "T", "tags": ["a","b","c","d","e","f","g","h"]}' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateJournalMeta('Test body')
    expect(result.tags.length).toBeLessThanOrEqual(6)
  })

  it('truncates title to 60 chars', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: `{"title": "${'x'.repeat(100)}", "tags": []}` }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateJournalMeta('Test body')
    expect(result.title.length).toBeLessThanOrEqual(60)
  })

  it('falls back to first line on API error', async () => {
    mockedQuery.mockImplementation(() => { throw new Error('API down') })

    const result = await generateJournalMeta('First line of the entry\nMore content here')
    expect(result.title).toBe('First line of the entry')
    expect(result.tags).toEqual([])
  })

  it('falls back to first line when AI returns non-JSON', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: 'Not valid JSON' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateJournalMeta('My entry title\nBody here')
    expect(result.title).toBe('My entry title')
  })

  it('truncates first-line fallback with ellipsis if > 60 chars', async () => {
    mockedQuery.mockImplementation(() => { throw new Error('API down') })

    const longLine = 'x'.repeat(100)
    const result = await generateJournalMeta(longLine)
    expect(result.title.length).toBeLessThanOrEqual(60)
    expect(result.title).toContain('...')
  })
})
