import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'
import { ensureAgentRunSchema } from './schema'
import {
  createAgentRunRecord,
  createAgentRunPublication,
  getAgentRun,
  getAgentRunPublication,
  listAgentRunEvents,
  transitionAgentRun,
  markAgentRunPublished,
  markAgentRunPublishing,
  markAgentRunPublishFailed,
  markAgentRunQReview,
} from './store'

function input(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    idempotencyKey: 'dispatch-1',
    agent: 'felix',
    agentLabel: 'Felix',
    verb: 'critique',
    brief: 'Read the surface and report.',
    paths: ['/repo/src'],
    workspace: { repoRoot: '/repo', isolation: 'in-place' as const, branch: null, readOnly: true as const },
    baseSha: 'a'.repeat(40),
    allowedPaths: ['/repo/src'],
    settings: DEFAULT_AGENT_SETTINGS,
    agentDefinitionVersion: 'definition-v1',
    commandPolicyVersion: 'phase0-readonly-no-shell-v1',
    acceptanceChecks: [],
    resourceCaps: { wallClockSeconds: 300, maxOutputChars: 100_000 },
    now: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function memoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  ensureAgentRunSchema(db)
  return db
}

describe('agent run store', () => {
  it('creates an immutable dispatch and returns it for an identical idempotent retry', () => {
    const db = memoryDb()
    const first = createAgentRunRecord(input(), db)
    const retry = createAgentRunRecord(input({ id: 'different-id' }), db)

    expect(first.created).toBe(true)
    expect(retry.created).toBe(false)
    expect(retry.run.id).toBe('run-1')
    expect(listAgentRunEvents('run-1', db).map(event => event.type)).toEqual(['dispatched'])
    expect(() => createAgentRunRecord(input({ brief: 'different contract' }), db)).toThrow('different agent run')
    expect(() => db.prepare("UPDATE agent_runs SET task_brief = 'changed' WHERE id = 'run-1'").run()).toThrow('immutable')
    db.close()
  })

  it('validates transitions and persists the event before the new snapshot', () => {
    const db = memoryDb()
    createAgentRunRecord(input(), db)
    expect(() => transitionAgentRun('run-1', 'succeeded', { eventType: 'bad' }, db)).toThrow('queued -> succeeded')

    transitionAgentRun('run-1', 'preparing-workspace', { eventType: 'workspace_preparing' }, db)
    transitionAgentRun('run-1', 'running', { eventType: 'started', checkpoint: { phase: 'started' } }, db)
    const done = transitionAgentRun('run-1', 'succeeded', { eventType: 'succeeded', result: 'report' }, db)

    expect(done.status).toBe('succeeded')
    expect(done.result).toBe('report')
    expect(done.checkpoint).toEqual({ phase: 'started' })
    expect(listAgentRunEvents('run-1', db).map(event => [event.fromState, event.toState]))
      .toEqual([[null, 'queued'], ['queued', 'preparing-workspace'], ['preparing-workspace', 'running'], ['running', 'succeeded']])
    expect(getAgentRun('run-1', db)?.completedAt).not.toBeNull()
    db.close()
  })

  it('enforces append-only events in SQLite', () => {
    const db = memoryDb()
    createAgentRunRecord(input(), db)
    expect(() => db.prepare("UPDATE agent_run_events SET type = 'rewritten'").run()).toThrow('append-only')
    expect(() => db.prepare('DELETE FROM agent_run_events').run()).toThrow('append-only')
    db.close()
  })

  it('persists one idempotent publication contract and its PR/Q outcomes', () => {
    const db = memoryDb()
    createAgentRunRecord(input(), db)
    const contract = { runId: 'run-1', baseRef: 'main', headRef: 'bond-agent/run-1', idempotencyKey: 'publish-run-1', qReviewRequired: true }
    expect(createAgentRunPublication(contract, undefined, db)).toMatchObject({ status: 'pending', qReviewStatus: 'pending' })
    expect(createAgentRunPublication(contract, undefined, db)).toMatchObject({ status: 'pending' })
    expect(() => createAgentRunPublication({ ...contract, headRef: 'other' }, undefined, db)).toThrow('immutable')

    markAgentRunPublishing('run-1', undefined, db)
    markAgentRunPublished('run-1', { number: 42, nodeId: 'PR_node', url: 'https://github.com/shaunandrews/bond/pull/42' }, undefined, db)
    markAgentRunQReview('run-1', { status: 'posted', commentId: 9, commentUrl: 'https://github.com/shaunandrews/bond/pull/42#issuecomment-9' }, undefined, db)
    expect(getAgentRunPublication('run-1', db)).toMatchObject({
      status: 'published', prNumber: 42, qReviewStatus: 'posted', qCommentId: 9,
    })
    expect(listAgentRunEvents('run-1', db).map(event => event.type)).toEqual(expect.arrayContaining([
      'github_publish_queued', 'github_publish_started', 'github_draft_published', 'q_review_posted',
    ]))
    db.close()
  })

  it('persists actionable publish failures', () => {
    const db = memoryDb()
    createAgentRunRecord(input(), db)
    createAgentRunPublication({ runId: 'run-1', baseRef: 'main', headRef: 'branch', idempotencyKey: 'p1', qReviewRequired: false }, undefined, db)
    expect(markAgentRunPublishFailed('run-1', 'credential', 'Configure the scoped credential.', undefined, db)).toMatchObject({
      status: 'failed', errorClass: 'credential', errorMessage: 'Configure the scoped credential.',
    })
    db.close()
  })
})
