import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { AgentRun, AgentRunDetail } from '../../shared/agent-runs'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/agents'
import { resetAgentRunsForTest } from '../composables/useAgentRuns'
import TasksView from './TasksView.vue'

function run(id: string, status: AgentRun['status']): AgentRun {
  const now = '2026-07-22T12:00:00.000Z'
  return {
    id, idempotencyKey: id, agent: id === 'question' ? 'mathis' : 'felix', agentLabel: id === 'question' ? 'Mathis' : 'Felix', verb: 'build', brief: `Brief ${id}`, paths: [],
    workspace: id === 'question' ? { repoRoot: '/repo', isolation: 'worktree', branch: `bond-agent/${id}`, baseRef: 'main', worktreePath: `/worktrees/${id}`, readOnly: false } : { repoRoot: '/repo', isolation: 'in-place', branch: null, readOnly: true },
    workspaceState: { status: id === 'question' ? 'retained' : 'ready', createdAt: now, retainedAt: id === 'question' ? now : null, discardedAt: null },
    baseSha: 'a'.repeat(40), allowedPaths: [], settings: DEFAULT_AGENT_SETTINGS, agentDefinitionVersion: 'v1', commandPolicyVersion: 'v1', acceptanceChecks: [],
    resourceCaps: { budgetPreset: 'standard', wallClockSeconds: 300, maxOutputChars: 1000 }, checkpoint: null, summary: null, status, result: null, errorClass: null, errorMessage: null,
    recoveryCount: 0, attemptCount: 1, retryCount: 0, nextRetryAt: null, completionMessageId: null, completionInsertedAt: null,
    createdAt: now, updatedAt: now, startedAt: now, completedAt: status === 'succeeded' ? now : null, cancelledAt: null,
  }
}

function detail(value: AgentRun): AgentRunDetail {
  return {
    run: value,
    events: [{ id: 1, runId: value.id, sequence: 1, type: 'command_completed', fromState: 'running', toState: 'running', data: { argv: ['npm', 'test'], exitCode: 0 }, rawPayloadAvailable: true, createdAt: value.updatedAt }],
    questions: value.status === 'needs-input' ? [{ id: 'q1', runId: value.id, kind: 'command-allowlist', argv: ['node', 'check.mjs'], reason: 'Run the check', proposedAllowlistAddition: 'Allow exact argv', status: 'pending', response: null, createdAt: value.updatedAt, answeredAt: null }] : [],
    publication: null,
  }
}

describe('TasksView', () => {
  const running = run('running', 'running')
  const question = run('question', 'needs-input')
  const bond = {
    listAgentRuns: vi.fn(async () => ({ runs: [running, question] })),
    getAgentRun: vi.fn(async (id: string) => detail(id === running.id ? running : question)),
    onChunk: vi.fn(() => () => {}),
    cancelAgentRun: vi.fn(async () => ({ ...running, status: 'cancelled' as const })),
    answerAgentRunQuestion: vi.fn(async () => ({ run: { ...question, status: 'running' as const } })),
    discardAgentRunWorkspace: vi.fn(async () => ({ ...question, workspaceState: { ...question.workspaceState, status: 'discarded' as const } })),
    openExternal: vi.fn(),
  }

  beforeEach(() => {
    resetAgentRunsForTest()
    vi.clearAllMocks()
    ;(window as unknown as { bond: unknown }).bond = bond
  })
  afterEach(resetAgentRunsForTest)

  it('renders multiple active runs, keeps raw logs collapsed, and supports keyboard selection', async () => {
    const wrapper = mount(TasksView)
    await flushPromises()
    expect(wrapper.findAll('.tasks-row')).toHaveLength(2)
    expect(wrapper.find('.tasks-badge').text()).toBe('2')
    expect(wrapper.find('details.tasks-event--raw').attributes('open')).toBeUndefined()
    await wrapper.find('.tasks-row').trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.findAll('.tasks-row')[1].attributes('aria-selected')).toBe('true')
  })

  it('answers a run-scoped question and cancels an active run through durable APIs', async () => {
    const wrapper = mount(TasksView, { props: { focusRunId: question.id } })
    await flushPromises()
    const buttons = wrapper.findAll('.tasks-question button')
    await buttons[0].trigger('click')
    expect(bond.answerAgentRunQuestion).toHaveBeenCalledWith(question.id, 'q1', true, '')

    await wrapper.findAll('.tasks-row')[0].trigger('click')
    await wrapper.find('.tasks-actions .bond-btn--danger').trigger('click')
    expect(bond.cancelAgentRun).toHaveBeenCalledWith(running.id)
  })
})
