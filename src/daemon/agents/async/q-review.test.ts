import { describe, expect, it, vi } from 'vitest'

const { consult } = vi.hoisted(() => ({ consult: vi.fn(async () => 'VERDICT: clean.') }))
vi.mock('../run-agent', () => ({ runAgentConsult: consult }))
vi.mock('../context-docs', () => ({ resolveContextDocs: vi.fn(() => ({ root: '/worktree', docs: {} })) }))
vi.mock('../registry', async importOriginal => {
  const actual = await importOriginal<any>()
  return { ...actual, effectiveAgentSettings: vi.fn((definition: any) => definition.defaults) }
})

import { qAgentRunReviewer } from './q-review'
import { findAgent } from '../registry'
import type { AgentRun, AgentRunPublication } from '../../../shared/agent-runs'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'

describe('Q agent-run reviewer', () => {
  it('uses only Q\'s read-only consult scoped to the retained worktree', async () => {
    const now = new Date().toISOString()
    const run = {
      id: 'run-q', agent: 'mathis', workspace: { isolation: 'worktree', worktreePath: '/worktree', branch: 'bond-agent/run-q', baseRef: 'main' },
      baseSha: 'a'.repeat(40),
    } as AgentRun
    const publication = { runId: run.id, prNumber: 12 } as AgentRunPublication
    await qAgentRunReviewer.review({ run, publication, changedPaths: ['src/daemon/server.ts'] })
    expect(consult).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({ name: 'q' }),
      verb: expect.objectContaining({ name: 'review' }),
      cwd: '/worktree',
      allowedRoot: '/worktree',
      paths: ['/worktree/src/daemon/server.ts'],
      evidence: [],
    }))
    expect(findAgent('q')?.defaults).toMatchObject({ workspace: 'read-only' })
    expect(DEFAULT_AGENT_SETTINGS.workspace).toBe('read-only')
    expect(now).toBeTruthy()
  })
})
