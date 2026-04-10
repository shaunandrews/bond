import { describe, it, expect, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}))

import { generateTitleAndSummary } from './generate-title'
import { query } from '@anthropic-ai/claude-agent-sdk'

const mockedQuery = vi.mocked(query)

describe('generateTitleAndSummary', () => {
  it('returns defaults for empty messages', async () => {
    const result = await generateTitleAndSummary([])
    expect(result).toEqual({ title: 'New chat', summary: '' })
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('returns defaults when all messages have no text', async () => {
    const result = await generateTitleAndSummary([
      { id: '1', role: 'meta', kind: 'tool', name: 'bash' },
    ])
    expect(result).toEqual({ title: 'New chat', summary: '' })
  })

  it('parses valid AI response', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: '{"title": "CSS Bug Fix", "summary": "Fixed layout issues"}' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateTitleAndSummary([
      { id: '1', role: 'user', text: 'Fix the CSS bug' },
      { id: '2', role: 'bond', text: 'I fixed the layout issue' },
    ])
    expect(result.title).toBe('CSS Bug Fix')
    expect(result.summary).toBe('Fixed layout issues')
  })

  it('truncates long titles to 60 chars', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: `{"title": "${'x'.repeat(100)}", "summary": "ok"}` }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateTitleAndSummary([{ id: '1', role: 'user', text: 'test' }])
    expect(result.title.length).toBeLessThanOrEqual(60)
  })

  it('truncates long summaries to 200 chars', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: `{"title": "T", "summary": "${'s'.repeat(300)}"}` }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateTitleAndSummary([{ id: '1', role: 'user', text: 'test' }])
    expect(result.summary.length).toBeLessThanOrEqual(200)
  })

  it('returns defaults on API error', async () => {
    mockedQuery.mockImplementation(() => { throw new Error('API down') })

    const result = await generateTitleAndSummary([
      { id: '1', role: 'user', text: 'Hello' },
    ])
    expect(result).toEqual({ title: 'New chat', summary: '' })
  })

  it('returns defaults when AI returns non-JSON', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: 'I am not JSON' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateTitleAndSummary([{ id: '1', role: 'user', text: 'test' }])
    expect(result).toEqual({ title: 'New chat', summary: '' })
  })

  it('only uses first 10 messages', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: '{"title": "Test", "summary": "ok"}' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      role: i % 2 === 0 ? 'user' : 'bond',
      text: `Message ${i}`,
    }))

    await generateTitleAndSummary(messages)

    // Verify the prompt was built from at most 10 messages
    const callArgs = mockedQuery.mock.calls[0][0] as { prompt: string }
    const lineCount = callArgs.prompt.split('\n').filter(l => l.startsWith('User:') || l.startsWith('Assistant:')).length
    expect(lineCount).toBeLessThanOrEqual(10)
  })
})
