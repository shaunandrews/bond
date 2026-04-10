import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}))

// Need a real DB for getSoul()
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import { generateBondComment } from './generate-journal-comment'
import { query } from '@anthropic-ai/claude-agent-sdk'

const mockedQuery = vi.mocked(query)

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-journal-comment-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('generateBondComment', () => {
  it('returns AI response on success', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: 'Great progress on the dashboard!' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateBondComment('Today I finished the dashboard redesign.', 'Dashboard Update')
    expect(result).toBe('Great progress on the dashboard!')
  })

  it('returns fallback message on empty AI response', async () => {
    const mockAsyncGen = async function* () {
      yield { type: 'result', subtype: 'success', result: '' }
    }
    mockedQuery.mockReturnValue(mockAsyncGen() as any)

    const result = await generateBondComment('Test entry', 'Test')
    expect(result).toContain('couldn\'t formulate a response')
  })

  it('returns error message on API failure', async () => {
    mockedQuery.mockImplementation(() => { throw new Error('Network error') })

    const result = await generateBondComment('Test entry', 'Test')
    expect(result).toContain('hit an error')
  })
})
