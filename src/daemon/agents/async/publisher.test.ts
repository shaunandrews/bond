import { mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '../../../shared/agent-runs'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'
import { closeDb, getDb } from '../../db'
import { setDataDir } from '../../paths'
import { appendAgentRunEvent, createAgentRunRecord, getAgentRunPublication, transitionAgentRun, updateAgentRunWorkspaceState } from './store'
import { createAgentRunHandoff, createGitHubDraftTransport, requiresQReview, type AgentRunQReviewer, type GitHubDraftPullRequest, type GitHubDraftTransport, type LocalGitPublisher } from './publisher'

let dataDir: string
let repoRoot: string

beforeEach(() => {
  dataDir = join(process.cwd(), '.test-tmp', `publisher-${randomUUID()}`)
  repoRoot = join(dataDir, 'repo')
  mkdirSync(repoRoot, { recursive: true })
  setDataDir(dataDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  setDataDir(null as never)
})

function successfulRun(id: string = randomUUID(), acceptanceChecks = [JSON.stringify(['npm', 'run', 'typecheck'])], repository?: AgentRun['repository']): AgentRun {
  const baseSha = 'a'.repeat(40)
  let run = createAgentRunRecord({
    id, idempotencyKey: id, agent: 'mathis', agentLabel: 'Mathis', verb: 'build', brief: 'Build the requested change.', paths: [repoRoot],
    workspace: { repositoryId: repository?.id, repoRoot, isolation: 'worktree', branch: `bond-agent/${id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24)}`, baseRef: 'main', worktreePath: join(dataDir, 'worktree'), readOnly: false }, repository,
    baseSha, allowedPaths: [repoRoot], settings: { ...DEFAULT_AGENT_SETTINGS, workspace: 'write' }, agentDefinitionVersion: 'v1', commandPolicyVersion: 'v1',
    acceptanceChecks, resourceCaps: { wallClockSeconds: 100, maxOutputChars: 1000 },
  }).run
  transitionAgentRun(id, 'preparing-workspace', { eventType: 'preparing' })
  transitionAgentRun(id, 'running', { eventType: 'started' })
  appendAgentRunEvent(id, 'command_completed', { argv: ['npm', 'run', 'typecheck'], exitCode: 0 })
  run = transitionAgentRun(id, 'succeeded', { eventType: 'succeeded', result: 'done' })
  return updateAgentRunWorkspaceState(id, { status: 'retained', createdAt: run.createdAt, retainedAt: run.completedAt, discardedAt: null }, 'retained')
}

const cleanInspection = (run: AgentRun, changedPaths = ['src/renderer/App.vue']) => ({
  branch: run.workspace.isolation === 'worktree' ? run.workspace.branch : '', headSha: 'b'.repeat(40), porcelain: '', changedPaths, aheadBy: 1,
  remoteUrl: run.repository?.expectedRemoteUrl ?? 'https://github.com/shaunandrews/bond.git',
})

function pr(run: AgentRun, overrides: Partial<GitHubDraftPullRequest> = {}): GitHubDraftPullRequest {
  if (run.workspace.isolation !== 'worktree') throw new Error('fixture')
  return {
    repository: run.repository?.githubRepository ?? 'shaunandrews/bond', number: 12, nodeId: 'PR_node', url: `https://github.com/${run.repository?.githubRepository ?? 'shaunandrews/bond'}/pull/12`,
    draft: true, baseRef: run.workspace.baseRef, headRef: run.workspace.branch, ...overrides,
  }
}

function fixture(run: AgentRun, options: {
  credential?: Error | string
  inspection?: ReturnType<typeof cleanInspection>
  found?: GitHubDraftPullRequest | null
  pushError?: Error
  reviewer?: AgentRunQReviewer
  qComment?: { id: number; url: string } | null
} = {}) {
  const git: LocalGitPublisher = {
    inspect: vi.fn(async () => options.inspection ?? cleanInspection(run)),
    pushRunBranch: vi.fn(async () => { if (options.pushError) throw options.pushError }),
  }
  const transport: GitHubDraftTransport = {
    findPullRequest: vi.fn(async () => options.found ?? null),
    createDraft: vi.fn(async () => pr(run)),
    updateDraft: vi.fn(async number => pr(run, { number })),
    findQComment: vi.fn(async () => options.qComment ?? null),
    createQComment: vi.fn(async () => ({ id: 99, url: 'https://github.com/shaunandrews/bond/pull/12#issuecomment-99' })),
    updateQComment: vi.fn(async id => ({ id, url: `https://github.com/shaunandrews/bond/pull/12#issuecomment-${id}` })),
  }
  const config = {
    getConfig: vi.fn(async () => ({ enabled: true, repository: 'shaunandrews/bond' as const, remote: 'origin' as const, credentialRef: 'github-bond-agent', credentialConfigured: true })),
    configure: vi.fn(), setCredential: vi.fn(),
    credential: vi.fn(async () => {
      if (options.credential instanceof Error) throw options.credential
      return options.credential ?? 'scoped-test-token'
    }),
  }
  const handoff = createAgentRunHandoff({ config: config as any, git, github: () => transport, repoRoot: () => repoRoot, reviewer: options.reviewer })
  return { handoff, git, transport, config }
}

describe('draft PR handoff', () => {
  it('persists a clear missing-credential failure and performs no git or GitHub write', async () => {
    const run = successfulRun()
    const { handoff, git, transport } = fixture(run, { credential: new Error('GitHub credential is missing. Store the scoped credential.') })
    expect(await handoff.publish(run)).toMatchObject({ status: 'failed', errorClass: 'credential' })
    expect(git.inspect).not.toHaveBeenCalled()
    expect(git.pushRunBranch).not.toHaveBeenCalled()
    expect(transport.createDraft).not.toHaveBeenCalled()
  })

  it('pushes only the run branch and creates one draft PR', async () => {
    const run = successfulRun()
    const { handoff, git, transport } = fixture(run)
    const published = await handoff.publish(run)
    expect(git.pushRunBranch).toHaveBeenCalledWith(run, 'scoped-test-token')
    expect(transport.createDraft).toHaveBeenCalledWith(expect.objectContaining({ headRef: (run.workspace as any).branch, baseRef: 'main' }))
    expect(published).toMatchObject({ status: 'published', prNumber: 12, prUrl: 'https://github.com/shaunandrews/bond/pull/12' })
  })

  it('returns the durable published record on duplicate publication', async () => {
    const run = successfulRun()
    const { handoff, git, transport } = fixture(run)
    await handoff.publish(run)
    await handoff.publish(run)
    expect(git.pushRunBranch).toHaveBeenCalledTimes(1)
    expect(transport.createDraft).toHaveBeenCalledTimes(1)
  })

  it('publishes a registered repository with its immutable remote mapping and repo-scoped credential boundary', async () => {
    const repository = {
      id: 'studio', label: 'Studio', repoRoot, baseRef: 'main', allowedPathPrefixes: ['src'], githubRepository: 'example/studio',
      remote: 'upstream', expectedRemoteUrl: 'https://github.com/example/studio.git', credentialRef: 'github-studio-agent',
      commandRules: ['git status'], acceptanceChecks: [JSON.stringify(['npm', 'run', 'typecheck'])], trustedInPlace: false, builtIn: false,
    }
    const run = successfulRun('studio-run', undefined, repository)
    const transport: GitHubDraftTransport = {
      findPullRequest: vi.fn(async () => null), createDraft: vi.fn(async () => pr(run)), updateDraft: vi.fn(async () => pr(run)),
      findQComment: vi.fn(async () => null), createQComment: vi.fn(), updateQComment: vi.fn(),
    }
    const git: LocalGitPublisher = { inspect: vi.fn(async () => cleanInspection(run)), pushRunBranch: vi.fn(async () => {}) }
    const credentialFor = vi.fn(async () => 'studio-scoped-token')
    const handoff = createAgentRunHandoff({ git, github: () => transport, credentialFor })
    expect(await handoff.publish(run)).toMatchObject({ repository: 'example/studio', remote: 'upstream', status: 'published' })
    expect(credentialFor).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }))
    expect(git.pushRunBranch).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }), 'studio-scoped-token')
  })

  it('records push failure and can retain the idempotent contract', async () => {
    const run = successfulRun()
    const { handoff } = fixture(run, { pushError: new Error('network unavailable') })
    expect(await handoff.publish(run)).toMatchObject({ status: 'failed', errorClass: 'transport', errorMessage: 'network unavailable' })
    expect(getAgentRunPublication(run.id)?.idempotencyKey).toBe(`github-draft:${run.id}`)
  })

  it('rejects the wrong remote, branch, repository root, missing checks, and non-draft PRs', async () => {
    const remoteRun = successfulRun('remote')
    expect(await fixture(remoteRun, { inspection: { ...cleanInspection(remoteRun), remoteUrl: 'git@github.com:shaunandrews/bond.git' } }).handoff.publish(remoteRun))
      .toMatchObject({ status: 'failed', errorClass: 'validation' })

    const branchRun = successfulRun('branch')
    expect(await fixture(branchRun, { inspection: { ...cleanInspection(branchRun), branch: 'other' } }).handoff.publish(branchRun))
      .toMatchObject({ status: 'failed', errorClass: 'validation' })

    const prRun = successfulRun('ready-pr')
    const found = pr(prRun, { draft: false })
    const { handoff, transport } = fixture(prRun, { found })
    expect(await handoff.publish(prRun)).toMatchObject({ status: 'failed', errorClass: 'validation' })
    expect(transport.updateDraft).not.toHaveBeenCalled()

    const checkRun = successfulRun('checks', [JSON.stringify(['npm', 'run', 'build'])])
    expect(await fixture(checkRun).handoff.publish(checkRun)).toMatchObject({ status: 'failed', errorClass: 'validation' })
  })

  it('runs Q for risky paths and posts one advisory comment on the associated PR', async () => {
    const run = successfulRun('q-risk')
    const reviewer: AgentRunQReviewer = { review: vi.fn(async () => 'VERDICT: advisory findings.') }
    const { handoff, transport } = fixture(run, { inspection: cleanInspection(run, ['src/daemon/server.ts']), reviewer })
    const published = await handoff.publish(run)
    expect(reviewer.review).toHaveBeenCalledWith(expect.objectContaining({ run, changedPaths: ['src/daemon/server.ts'] }))
    expect(transport.createQComment).toHaveBeenCalledWith(12, expect.stringContaining(`bond-q-review:${run.id}`))
    expect(published).toMatchObject({ status: 'published', qReviewRequired: true, qReviewStatus: 'posted', qCommentId: 99 })
  })

  it('updates Q\'s marked advisory comment on retry and never blocks the draft PR', async () => {
    const run = successfulRun('q-update')
    const failedReviewer: AgentRunQReviewer = { review: vi.fn(async () => { throw new Error('Q temporarily unavailable') }) }
    const first = fixture(run, { inspection: cleanInspection(run, ['src/shared/protocol.ts']), reviewer: failedReviewer })
    expect(await first.handoff.publish(run)).toMatchObject({ status: 'published', qReviewStatus: 'failed' })

    const reviewer: AgentRunQReviewer = { review: vi.fn(async () => 'Updated advisory.') }
    const retry = fixture(run, {
      inspection: cleanInspection(run, ['src/shared/protocol.ts']), reviewer,
      qComment: { id: 77, url: 'https://github.com/shaunandrews/bond/pull/12#issuecomment-77' },
    })
    expect(await retry.handoff.publish(run)).toMatchObject({ status: 'published', qReviewStatus: 'posted', qCommentId: 77 })
    expect(retry.transport.updateQComment).toHaveBeenCalledWith(77, expect.stringContaining('Updated advisory'))
    expect(retry.transport.createQComment).not.toHaveBeenCalled()
  })
})

describe('Q risk classification', () => {
  it('flags daemon/shared/migration/protocol and broad changes, but skips isolated renderer work', () => {
    expect(requiresQReview(['src/daemon/server.ts'])).toBe(true)
    expect(requiresQReview(['src/shared/protocol.ts'])).toBe(true)
    expect(requiresQReview(['src/db/migrations/009.sql'])).toBe(true)
    expect(requiresQReview(['src/renderer/App.vue'])).toBe(false)
    expect(requiresQReview(['src/renderer/A.vue', 'src/main/B.ts', 'scripts/x.ts'])).toBe(true)
  })
})

describe('narrow GitHub HTTP transport', () => {
  it('creates drafts only and exposes no ready/reviewer/merge operation', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      number: 3, node_id: 'PR3', html_url: 'https://github.com/shaunandrews/bond/pull/3', draft: true,
      base: { ref: 'main' }, head: { ref: 'bond-agent/run' },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    const transport = createGitHubDraftTransport('secret-test-token', fetcher)
    await transport.createDraft({ headRef: 'bond-agent/run', baseRef: 'main', title: 'Draft', body: 'Body' })
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(request).toMatchObject({ draft: true, maintainer_can_modify: false })
    expect(request).not.toHaveProperty('reviewers')
    expect(Object.keys(transport)).not.toEqual(expect.arrayContaining(['merge', 'markReady', 'requestReviewers']))
  })
})
