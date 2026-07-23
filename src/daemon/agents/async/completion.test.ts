import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'
import { closeDb, getDb } from '../../db'
import { setDataDir } from '../../paths'
import { listMessages } from '../../transcript'
import { createAgentRunCompletionCoordinator } from './completion'
import { createAgentRunPublication, createAgentRunRecord, getAgentRun, markAgentRunPublished, markAgentRunQReview, parkAgentRunForCommand, transitionAgentRun } from './store'

let dir: string

function terminalRun(id: string) {
  const run = createAgentRunRecord({
    id,
    idempotencyKey: id,
    agent: 'felix',
    agentLabel: 'Felix',
    verb: 'critique',
    brief: 'brief',
    paths: [],
    workspace: { repoRoot: '/repo', isolation: 'in-place', branch: null, readOnly: true },
    baseSha: null,
    allowedPaths: [],
    settings: DEFAULT_AGENT_SETTINGS,
    agentDefinitionVersion: 'v1',
    commandPolicyVersion: 'phase0-readonly-no-shell-v1',
    acceptanceChecks: [],
    resourceCaps: { wallClockSeconds: 300, maxOutputChars: 100_000 },
  }).run
  transitionAgentRun(run.id, 'preparing-workspace', { eventType: 'workspace_preparing' })
  transitionAgentRun(run.id, 'running', { eventType: 'started' })
  return transitionAgentRun(run.id, 'succeeded', { eventType: 'succeeded', result: 'A concise durable report.' })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bond-agent-completion-'))
  setDataDir(dir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
  setDataDir(null as never)
})

describe('agent run completion insertion', () => {
  it('inserts one stable progress card only after the active turn settles, then updates it in place', () => {
    const run = createAgentRunRecord({
      id: 'progress-card', idempotencyKey: 'progress-card', agent: 'felix', agentLabel: 'Felix', verb: 'critique', brief: 'brief', paths: [],
      workspace: { repoRoot: '/repo', isolation: 'in-place', branch: null, readOnly: true }, baseSha: null, allowedPaths: [], settings: DEFAULT_AGENT_SETTINGS,
      agentDefinitionVersion: 'v1', commandPolicyVersion: 'v1', acceptanceChecks: [], resourceCaps: { wallClockSeconds: 300, maxOutputChars: 100_000 },
    }).run
    const deferred: Array<() => void> = []
    const coordinator = createAgentRunCompletionCoordinator({ deferUntilTurnsIdle: task => deferred.push(task) })
    coordinator.track(run)
    coordinator.track(run)
    expect(listMessages().messages).toHaveLength(0)
    expect(deferred).toHaveLength(1)

    deferred[0]()
    const message = listMessages().messages[0]
    expect(message).toMatchObject({ id: 'agent-run:progress-card:activity', kind: 'agent-run', data: { status: 'queued' } })
    const preparing = transitionAgentRun(run.id, 'preparing-workspace', { eventType: 'preparing' })
    coordinator.refresh(preparing)
    deferred[1]()
    expect(listMessages().messages).toHaveLength(1)
    expect(listMessages().messages[0]).toMatchObject({ id: message.id, data: { status: 'preparing-workspace' } })
  })

  it('queues while a turn is active and inserts exactly once after settlement', () => {
    const run = terminalRun('complete-later')
    const deferred: Array<() => void> = []
    const changed = vi.fn()
    const coordinator = createAgentRunCompletionCoordinator({
      deferUntilTurnsIdle: task => deferred.push(task),
      onChanged: changed,
    })

    coordinator.enqueue(run)
    coordinator.enqueue(run)
    expect(listMessages().messages).toHaveLength(0)
    expect(deferred).toHaveLength(1)

    deferred[0]()
    const messages = listMessages().messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'meta', kind: 'agent-run' })
    expect(messages[0].text).toContain('Felix finished')
    expect(getAgentRun(run.id)?.completionMessageId).toBe(messages[0].id)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('reconciles an uninjected terminal run after restart', () => {
    const run = terminalRun('restart-completion')
    const coordinator = createAgentRunCompletionCoordinator()

    coordinator.reconcile()
    coordinator.reconcile()

    expect(listMessages().messages.filter(message => message.kind === 'agent-run')).toHaveLength(1)
    expect(getAgentRun(run.id)?.completionInsertedAt).not.toBeNull()
  })

  it('queues a run-scoped command question outside an active turn', () => {
    const run = createAgentRunRecord({
      id: 'question-card', idempotencyKey: 'question-card', agent: 'mathis', agentLabel: 'Mathis', verb: 'build', brief: 'brief', paths: [],
      workspace: { repoRoot: '/repo', isolation: 'in-place', branch: null, readOnly: true }, baseSha: null, allowedPaths: [],
      settings: DEFAULT_AGENT_SETTINGS, agentDefinitionVersion: 'v1', commandPolicyVersion: 'v1', acceptanceChecks: [],
      resourceCaps: { wallClockSeconds: 300, maxOutputChars: 100_000 },
    }).run
    transitionAgentRun(run.id, 'preparing-workspace', { eventType: 'preparing' })
    transitionAgentRun(run.id, 'running', { eventType: 'started' })
    const parked = parkAgentRunForCommand(run.id, {
      argv: ['node', 'check.mjs'], reason: 'Needed for the confirmed task.', proposedAllowlistAddition: 'Allow exact argv.',
    }, { phase: 'awaiting-command-approval' })
    const deferred: Array<() => void> = []
    const coordinator = createAgentRunCompletionCoordinator({ deferUntilTurnsIdle: task => deferred.push(task) })

    coordinator.enqueueQuestion(parked.run, parked.question)
    expect(listMessages().messages).toHaveLength(0)
    deferred[0]()
    expect(listMessages().messages[0]).toMatchObject({
      role: 'meta', kind: 'agent-run', data: { runId: run.id, questionId: parked.question.id, status: 'needs-input' },
    })
    expect(listMessages().messages[0].text).toContain('Allow exact argv')
  })

  it('renders the durable draft PR and Q advisory links in completion', () => {
    const run = terminalRun('published-completion')
    createAgentRunPublication({ runId: run.id, baseRef: 'main', headRef: 'bond-agent/published', idempotencyKey: 'publish-card', qReviewRequired: true })
    markAgentRunPublished(run.id, { number: 42, nodeId: 'PR42', url: 'https://github.com/shaunandrews/bond/pull/42' })
    markAgentRunQReview(run.id, { status: 'posted', commentId: 8, commentUrl: 'https://github.com/shaunandrews/bond/pull/42#issuecomment-8' })
    const coordinator = createAgentRunCompletionCoordinator()
    coordinator.enqueue(run)
    expect(listMessages().messages[0]).toMatchObject({
      data: { prNumber: 42, prUrl: 'https://github.com/shaunandrews/bond/pull/42', qReviewStatus: 'posted' },
    })
    expect(listMessages().messages[0].text).toContain('Draft PR #42')
    expect(listMessages().messages[0].text).toContain('Q review')
  })
})
