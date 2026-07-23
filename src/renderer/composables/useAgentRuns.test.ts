import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { AgentRun } from '../../shared/agent-runs'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/agents'
import { resetAgentRunsForTest, useAgentRuns, type AgentRunSurface } from './useAgentRuns'

function run(id: string, status: AgentRun['status']): AgentRun {
  const now = new Date().toISOString()
  return {
    id, idempotencyKey: id, agent: 'felix', agentLabel: 'Felix', verb: 'critique', brief: id, paths: [],
    workspace: { repoRoot: '/repo', isolation: 'in-place', branch: null, readOnly: true }, workspaceState: { status: 'ready', createdAt: null, retainedAt: null, discardedAt: null },
    baseSha: null, allowedPaths: [], settings: DEFAULT_AGENT_SETTINGS, agentDefinitionVersion: 'v1', commandPolicyVersion: 'v1', acceptanceChecks: [],
    resourceCaps: { wallClockSeconds: 300, maxOutputChars: 1000 }, checkpoint: null, summary: null, status, result: null, errorClass: null, errorMessage: null,
    recoveryCount: 0, attemptCount: 0, retryCount: 0, nextRetryAt: null, completionMessageId: null, completionInsertedAt: null,
    createdAt: now, updatedAt: now, startedAt: null, completedAt: null, cancelledAt: null,
  }
}

afterEach(resetAgentRunsForTest)

describe('agent run renderer store', () => {
  it('reconciles multiple runs and applies pushed durable snapshots', async () => {
    let listener!: (chunk: any) => void
    let first = run('one', 'running')
    const second = run('two', 'needs-input')
    const surface = {
      listAgentRuns: vi.fn(async () => ({ runs: [first, second] })),
      getAgentRun: vi.fn(async (id: string) => ({ run: id === first.id ? first : second, events: [], questions: [], publication: null })),
      onChunk: vi.fn((fn: typeof listener) => { listener = fn; return () => {} }),
      cancelAgentRun: vi.fn(), answerAgentRunQuestion: vi.fn(), discardAgentRunWorkspace: vi.fn(),
    } as unknown as AgentRunSurface
    const store = useAgentRuns(surface)
    await store.reconcile()
    expect(store.activeRuns.value.map(item => item.id).sort()).toEqual(['one', 'two'])

    first = { ...first, status: 'succeeded' }
    listener({ kind: 'agent_run_changed', run: first })
    await nextTick()
    expect(store.runs.value.find(item => item.id === 'one')?.status).toBe('succeeded')
  })
})
