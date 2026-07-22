import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'
import { closeDb, getDb } from '../../db'
import { setDataDir } from '../../paths'
import { setSetting } from '../../settings'
import { classifyMergedPaths, createMergeUpdateCoordinator, type BondUpdateDriver } from './merge-updates'
import {
  createAgentRunPublication,
  createAgentRunRecord,
  getAgentRunUpdate,
  listAgentRunEvents,
  markAgentRunPublished,
  recordAgentRunMerge,
  transitionAgentRun,
} from './store'

let dir: string
const sha = 'b'.repeat(40)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bond-merge-update-'))
  setDataDir(dir)
  getDb()
  setSetting('agents.bondRepoRoot', dir)
  setSetting('agents.bondBaseRef', 'main')
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
  setDataDir(null as never)
})

function publishedRun(id = 'run-1') {
  const run = createAgentRunRecord({
    id, idempotencyKey: id, agent: 'mathis', agentLabel: 'Mathis', verb: 'build', brief: 'Build it.', paths: [dir],
    workspace: { repositoryId: 'bond', repoRoot: dir, isolation: 'worktree', branch: `bond-agent/${id}`, baseRef: 'main', worktreePath: join(dir, 'worktree', id), readOnly: false },
    baseSha: 'a'.repeat(40), allowedPaths: [dir], settings: { ...DEFAULT_AGENT_SETTINGS, workspace: 'write' },
    agentDefinitionVersion: 'v1', commandPolicyVersion: 'v1', acceptanceChecks: [], resourceCaps: { wallClockSeconds: 60, maxOutputChars: 1000 },
  }).run
  transitionAgentRun(id, 'preparing-workspace', { eventType: 'preparing' })
  transitionAgentRun(id, 'running', { eventType: 'running' })
  transitionAgentRun(id, 'succeeded', { eventType: 'done', result: 'done' })
  createAgentRunPublication({ runId: id, baseRef: 'main', headRef: `bond-agent/${id}`, idempotencyKey: `publish-${id}`, qReviewRequired: false })
  markAgentRunPublished(id, { number: 12, nodeId: 'PR12', url: 'https://github.com/shaunandrews/bond/pull/12' })
  return run
}

function driver(overrides: Partial<BondUpdateDriver> = {}): BondUpdateDriver {
  return {
    inspect: vi.fn(async () => ({ root: dir, branch: 'main', porcelain: '', remoteUrl: 'https://github.com/shaunandrews/bond.git', canFastForward: true })),
    fastForward: vi.fn(async () => {}), reloadRenderer: vi.fn(async () => {}), buildDaemon: vi.fn(async () => {}),
    restartDaemon: vi.fn(async () => {}), awaitReconnect: vi.fn(async () => {}), ...overrides,
  }
}

describe('merged PR updates', () => {
  it('classifies renderer, daemon, and broad contract changes deterministically', () => {
    expect(classifyMergedPaths(['src/renderer/App.vue']).risk).toBe('renderer')
    expect(classifyMergedPaths(['src/daemon/turns.ts']).risk).toBe('daemon')
    expect(classifyMergedPaths(['src/daemon/turns.ts', 'src/renderer/App.vue']).risk).toBe('scheduled')
    expect(classifyMergedPaths(['src/shared/rpc-schema.ts']).risk).toBe('scheduled')
    expect(classifyMergedPaths(['src/daemon/agents/async/schema.ts']).risk).toBe('scheduled')
  })

  it('polls merged GitHub state and records it only once', async () => {
    publishedRun()
    const reader = { getPullRequest: vi.fn(async () => ({ merged: true, mergeCommitSha: sha, mergedAt: '2026-07-22T12:00:00.000Z', changedPaths: ['src/renderer/App.vue'] })) }
    const coordinator = createMergeUpdateCoordinator({ reader: async () => reader, driver: driver() })
    expect(await coordinator.poll()).toHaveLength(1)
    expect(await coordinator.poll()).toHaveLength(0)
    expect(reader.getPullRequest).toHaveBeenCalledOnce()
    expect(getAgentRunUpdate('run-1')).toMatchObject({ risk: 'renderer', status: 'detected', mergeCommitSha: sha })
    expect(listAgentRunEvents('run-1').filter(event => event.type === 'github_merge_detected')).toHaveLength(1)
  })

  it('defers during a user turn and resumes the same durable update', async () => {
    publishedRun()
    recordAgentRunMerge({ runId: 'run-1', prNumber: 12, mergeCommitSha: sha, mergedAt: new Date().toISOString(), changedPaths: ['src/renderer/App.vue'], ...classifyMergedPaths(['src/renderer/App.vue']) })
    let active = true
    const local = driver()
    const coordinator = createMergeUpdateCoordinator({ reader: async () => ({ getPullRequest: vi.fn() }), driver: local, activeTurn: () => active })
    expect(await coordinator.apply('run-1')).toMatchObject({ status: 'deferred' })
    expect(local.fastForward).not.toHaveBeenCalled()
    active = false
    expect(await coordinator.apply('run-1')).toMatchObject({ status: 'applied' })
    expect(local.fastForward).toHaveBeenCalledWith(sha)
    expect(local.reloadRenderer).toHaveBeenCalledOnce()
  })

  it.each([
    [{ porcelain: ' M src/a.ts' }, 'local changes'],
    [{ branch: 'feature' }, 'expected main'],
    [{ canFastForward: false }, 'cannot fast-forward'],
    [{ remoteUrl: 'git@github.com:other/repo.git' }, 'origin must be exactly'],
  ])('refuses unsafe checkout preflight %#', async (inspection, message) => {
    publishedRun()
    recordAgentRunMerge({ runId: 'run-1', prNumber: 12, mergeCommitSha: sha, mergedAt: new Date().toISOString(), changedPaths: ['src/renderer/App.vue'], ...classifyMergedPaths(['src/renderer/App.vue']) })
    const local = driver({ inspect: vi.fn(async () => ({ root: dir, branch: 'main', porcelain: '', remoteUrl: 'https://github.com/shaunandrews/bond.git', canFastForward: true, ...inspection })) })
    const result = await createMergeUpdateCoordinator({ reader: async () => ({ getPullRequest: vi.fn() }), driver: local }).apply('run-1')
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.errorMessage).toContain(message)
    expect(local.fastForward).not.toHaveBeenCalled()
  })

  it('requires confirmation for scheduled updates and runs the daemon recovery sequence in order', async () => {
    publishedRun()
    recordAgentRunMerge({ runId: 'run-1', prNumber: 12, mergeCommitSha: sha, mergedAt: new Date().toISOString(), changedPaths: ['src/shared/rpc-schema.ts'], ...classifyMergedPaths(['src/shared/rpc-schema.ts']) })
    const local = driver()
    const coordinator = createMergeUpdateCoordinator({ reader: async () => ({ getPullRequest: vi.fn() }), driver: local })
    await expect(coordinator.apply('run-1')).rejects.toThrow('scheduled confirmation')
    expect(await coordinator.apply('run-1', true)).toMatchObject({ status: 'applied' })
    expect(local.buildDaemon).not.toHaveBeenCalled()
  })

  it('records build/restart/reconnect failures with recovery instructions', async () => {
    publishedRun()
    recordAgentRunMerge({ runId: 'run-1', prNumber: 12, mergeCommitSha: sha, mergedAt: new Date().toISOString(), changedPaths: ['src/daemon/turns.ts'], ...classifyMergedPaths(['src/daemon/turns.ts']) })
    const local = driver({ restartDaemon: vi.fn(async () => { throw new Error('restart failed') }) })
    const result = await createMergeUpdateCoordinator({ reader: async () => ({ getPullRequest: vi.fn() }), driver: local }).apply('run-1')
    expect(result).toMatchObject({ status: 'failed', errorMessage: 'restart failed' })
    expect(result.recoveryInstructions).toContain('never reset')
    expect(local.buildDaemon).toHaveBeenCalledOnce()
    expect(local.awaitReconnect).not.toHaveBeenCalled()
  })
})
