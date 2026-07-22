import { mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'
import { closeDb, getDb } from '../../db'
import { setDataDir } from '../../paths'
import { runAgentRetentionSweep } from './retention'
import { createAgentRunPublication, createAgentRunRecord, getAgentRun, markAgentRunPublished, transitionAgentRun } from './store'

let root: string
const old = '2025-01-01T00:00:00.000Z'

beforeEach(() => {
  root = join(process.cwd(), '.test-tmp', `agent-retention-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  setDataDir(root)
  getDb()
})
afterEach(() => { closeDb(); setDataDir(null as never); rmSync(root, { recursive: true, force: true }) })

function terminal(id: string, mode: 'read' | 'write') {
  const worktree = join(root, 'worktrees', id)
  const run = createAgentRunRecord({
    id, idempotencyKey: id, agent: mode === 'write' ? 'mathis' : 'felix', agentLabel: mode === 'write' ? 'Mathis' : 'Felix',
    verb: 'build', brief: 'old run', paths: [],
    workspace: mode === 'write'
      ? { repoRoot: root, isolation: 'worktree' as const, branch: `bond-agent/${id}`, baseRef: 'main', worktreePath: worktree, readOnly: false as const }
      : { repoRoot: root, isolation: 'in-place' as const, branch: null, readOnly: true as const },
    workspaceState: { status: mode === 'write' ? 'retained' : 'ready', createdAt: old, retainedAt: old, discardedAt: null },
    baseSha: 'a'.repeat(40), allowedPaths: [], settings: { ...DEFAULT_AGENT_SETTINGS, workspace: mode === 'write' ? 'write' : 'read-only' },
    agentDefinitionVersion: 'v1', commandPolicyVersion: 'v1', acceptanceChecks: [], resourceCaps: { wallClockSeconds: 60, maxOutputChars: 1000 }, now: old,
  }).run
  transitionAgentRun(id, 'preparing-workspace', { eventType: 'preparing', now: old })
  transitionAgentRun(id, 'running', { eventType: 'started', now: old })
  return transitionAgentRun(id, 'succeeded', { eventType: 'succeeded', result: 'done', now: old })
}

describe('agent retention', () => {
  it('discards published worktrees and prunes only safe old logs', async () => {
    const published = terminal('published', 'write')
    createAgentRunPublication({ runId: published.id, baseRef: 'main', headRef: published.workspace.isolation === 'worktree' ? published.workspace.branch : '', idempotencyKey: 'pub', qReviewRequired: false }, old)
    markAgentRunPublished(published.id, { number: 1, nodeId: 'PR1', url: 'https://github.com/shaunandrews/bond/pull/1' }, old)
    terminal('read-only', 'read')
    terminal('unpublished', 'write')
    const discard = vi.fn(async () => {})

    const result = await runAgentRetentionSweep({ now: Date.parse('2026-01-01T00:00:00.000Z'), worktreeDays: 30, logDays: 180, discard })

    expect(result).toMatchObject({ discarded: 1, deleted: 2 })
    expect(discard).toHaveBeenCalledWith(expect.objectContaining({ id: 'published' }))
    expect(getAgentRun('published')).toBeNull()
    expect(getAgentRun('read-only')).toBeNull()
    expect(getAgentRun('unpublished')).toMatchObject({ workspaceState: { status: 'retained' } })
  })

  it('never removes a terminal record with an unresolved question', async () => {
    terminal('question', 'read')
    getDb().prepare(`INSERT INTO agent_run_questions
      (id, run_id, kind, command_argv_json, reason, proposed_allowlist_addition, status, created_at)
      VALUES ('q1', 'question', 'command-allowlist', '["node","x.mjs"]', 'why', 'exact', 'pending', ?)`
      ).run(old)
    await runAgentRetentionSweep({ now: Date.parse('2026-01-01T00:00:00.000Z'), worktreeDays: 1, logDays: 1, discard: vi.fn() })
    expect(getAgentRun('question')).not.toBeNull()
  })
})
