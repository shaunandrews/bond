import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./agent', () => ({ runBondTextQuery: vi.fn() }))

import { generateTitleAndSummary } from './generate-title'
import { runBondTextQuery } from './agent'

const mockedRun = vi.mocked(runBondTextQuery)

describe('generateTitleAndSummary', () => {
  beforeEach(() => mockedRun.mockReset())

  it('returns defaults for empty messages', async () => {
    expect(await generateTitleAndSummary([])).toEqual({ title: 'New chat', summary: '' })
    expect(mockedRun).not.toHaveBeenCalled()
  })

  it('parses and bounds a Pi response', async () => {
    mockedRun.mockResolvedValue(`{"title": "${'x'.repeat(100)}", "summary": "${'s'.repeat(300)}"}`)
    const result = await generateTitleAndSummary([{ id: '1', role: 'user', text: 'Fix it' }])
    expect(result.title).toHaveLength(60)
    expect(result.summary).toHaveLength(200)
  })

  it('falls back for errors and invalid JSON', async () => {
    mockedRun.mockRejectedValueOnce(new Error('offline'))
    expect(await generateTitleAndSummary([{ id: '1', role: 'user', text: 'Hello' }]))
      .toEqual({ title: 'New chat', summary: '' })

    mockedRun.mockResolvedValueOnce('not JSON')
    expect(await generateTitleAndSummary([{ id: '1', role: 'user', text: 'Hello' }]))
      .toEqual({ title: 'New chat', summary: '' })
  })

  it('sends no more than ten transcript messages', async () => {
    mockedRun.mockResolvedValue('{"title":"Test","summary":"ok"}')
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: String(i), role: i % 2 === 0 ? 'user' : 'bond', text: `Message ${i}`,
    }))
    await generateTitleAndSummary(messages)
    const prompt = mockedRun.mock.calls[0][0]
    expect(prompt.split('\n').filter(line => line.startsWith('User:') || line.startsWith('Assistant:'))).toHaveLength(10)
  })
})
