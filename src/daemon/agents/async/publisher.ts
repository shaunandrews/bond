import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AgentRun, AgentRunPublication } from '../../../shared/agent-runs'
import { getSecretStore, type SecretStore } from '../../mcp/keychain'
import { SAFE_COMMAND_PATH } from './command-runner'
import { BOND_GITHUB_REMOTE, BOND_GITHUB_REPOSITORY, githubConfigService } from './github-config'
import { configuredBondRepoRoot } from './workspace'
import {
  createAgentRunPublication,
  getAgentRunPublication,
  listAgentRunEvents,
  markAgentRunPublished,
  markAgentRunPublishing,
  markAgentRunPublishFailed,
  markAgentRunQReview,
  getAgentRun,
} from './store'

const execFileAsync = promisify(execFile)
const EXPECTED_REMOTE_URL = 'https://github.com/shaunandrews/bond.git'

export interface LocalPublishInspection {
  branch: string
  headSha: string
  porcelain: string
  changedPaths: string[]
  aheadBy: number
  remoteUrl: string
}

export interface LocalGitPublisher {
  inspect(run: AgentRun): Promise<LocalPublishInspection>
  pushRunBranch(run: AgentRun, credential: string): Promise<void>
}

export interface GitHubDraftPullRequest {
  repository: string
  number: number
  nodeId: string
  url: string
  draft: boolean
  baseRef: string
  headRef: string
}

export interface GitHubDraftTransport {
  findPullRequest(headRef: string, baseRef: string): Promise<GitHubDraftPullRequest | null>
  createDraft(input: { headRef: string; baseRef: string; title: string; body: string }): Promise<GitHubDraftPullRequest>
  updateDraft(prNumber: number, input: { title: string; body: string }): Promise<GitHubDraftPullRequest>
  findQComment(prNumber: number, marker: string): Promise<{ id: number; url: string } | null>
  createQComment(prNumber: number, body: string): Promise<{ id: number; url: string }>
  updateQComment(commentId: number, body: string): Promise<{ id: number; url: string }>
}

export interface AgentRunQReviewer {
  review(input: { run: AgentRun; publication: AgentRunPublication; changedPaths: string[] }): Promise<string>
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: SAFE_COMMAND_PATH,
    HOME: '/dev/null',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  }
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: gitEnvironment(env),
    timeout: 120_000,
    maxBuffer: 512 * 1024,
  })
  return result.stdout.trim()
}

export const localGitPublisher: LocalGitPublisher = {
  async inspect(run) {
    if (run.workspace.isolation !== 'worktree') throw new Error('Only a managed worktree can be published.')
    const cwd = run.workspace.worktreePath
    const [branch, headSha, porcelain, changed, ahead, remoteUrl] = await Promise.all([
      git(cwd, ['branch', '--show-current']),
      git(cwd, ['rev-parse', 'HEAD']),
      git(cwd, ['status', '--porcelain=v1']),
      git(cwd, ['diff', '--name-only', `${run.baseSha}...HEAD`]),
      git(cwd, ['rev-list', '--count', `${run.baseSha}..HEAD`]),
      git(cwd, ['remote', 'get-url', run.repository?.remote ?? BOND_GITHUB_REMOTE]),
    ])
    return {
      branch,
      headSha,
      porcelain,
      changedPaths: changed.split('\n').map(value => value.trim()).filter(Boolean),
      aheadBy: Number(ahead),
      remoteUrl,
    }
  },

  async pushRunBranch(run, credential) {
    if (run.workspace.isolation !== 'worktree') throw new Error('Only a managed worktree can be published.')
    const authorization = Buffer.from(`x-access-token:${credential}`, 'utf8').toString('base64')
    await git(run.workspace.worktreePath, [
      'push', '--porcelain', run.repository?.remote ?? BOND_GITHUB_REMOTE,
      `refs/heads/${run.workspace.branch}:refs/heads/${run.workspace.branch}`,
    ], {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: `Authorization: Basic ${authorization}`,
    })
  },
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function createGitHubDraftTransport(credential: string, fetcher: FetchLike = fetch, repository: string = BOND_GITHUB_REPOSITORY): GitHubDraftTransport {
  const request = async (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<any> => {
    if (!path.startsWith(`/repos/${repository}/`)) throw new Error('GitHub request escaped the configured repository.')
    const response = await fetcher(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${credential}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'Bond-Mathis',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GitHub API ${method} ${path.split('?')[0]} failed with HTTP ${response.status}.`)
    return response.json()
  }

  const parse = (value: any): GitHubDraftPullRequest => ({
    repository,
    number: Number(value.number),
    nodeId: String(value.node_id),
    url: String(value.html_url),
    draft: value.draft === true,
    baseRef: String(value.base?.ref ?? ''),
    headRef: String(value.head?.ref ?? ''),
  })

  return {
    async findPullRequest(headRef, baseRef) {
      const owner = repository.split('/')[0]
      const query = new URLSearchParams({ state: 'open', head: `${owner}:${headRef}`, base: baseRef, per_page: '10' })
      const values = await request('GET', `/repos/${repository}/pulls?${query}`)
      if (!Array.isArray(values) || !values.length) return null
      if (values.length > 1) throw new Error('Multiple open pull requests matched this run branch.')
      return parse(values[0])
    },
    async createDraft(input) {
      return parse(await request('POST', `/repos/${repository}/pulls`, {
        title: input.title, body: input.body, head: input.headRef, base: input.baseRef,
        draft: true, maintainer_can_modify: false,
      }))
    },
    async updateDraft(prNumber, input) {
      return parse(await request('PATCH', `/repos/${repository}/pulls/${prNumber}`, {
        title: input.title, body: input.body,
      }))
    },
    async findQComment(prNumber, marker) {
      const values = await request('GET', `/repos/${repository}/issues/${prNumber}/comments?per_page=100`)
      if (!Array.isArray(values)) throw new Error('GitHub returned invalid PR comments.')
      const matches = values.filter(value => typeof value.body === 'string' && value.body.includes(marker))
      if (matches.length > 1) throw new Error('Multiple Q advisory comments matched this run.')
      return matches.length ? { id: Number(matches[0].id), url: String(matches[0].html_url) } : null
    },
    async createQComment(prNumber, body) {
      const value = await request('POST', `/repos/${repository}/issues/${prNumber}/comments`, { body })
      return { id: Number(value.id), url: String(value.html_url) }
    },
    async updateQComment(commentId, body) {
      const value = await request('PATCH', `/repos/${repository}/issues/comments/${commentId}`, { body })
      return { id: Number(value.id), url: String(value.html_url) }
    },
  }
}

export function requiresQReview(paths: string[]): boolean {
  const normalized = paths.map(path => path.replaceAll('\\', '/').replace(/^\.\//, ''))
  if (normalized.some(path => path.startsWith('src/daemon/') || path.startsWith('src/shared/') || path.includes('/migrations/') || /(^|\/)protocol\./.test(path))) return true
  const surfaces = new Set(normalized.map(path => path.split('/').slice(0, 2).join('/')))
  return normalized.length >= 20 || surfaces.size >= 3
}

function validateRun(run: AgentRun, inspection: LocalPublishInspection, expectedRepoRoot: string): void {
  if (run.agent !== 'mathis' || run.status !== 'succeeded') throw new Error('Only a successful Mathis run can publish.')
  if (run.workspace.isolation !== 'worktree' || run.workspace.readOnly) throw new Error('Publishing requires the run managed worktree.')
  if (run.workspaceState.status !== 'retained') throw new Error('The successful worktree must be retained before publishing.')
  if (resolve(run.workspace.repoRoot) !== resolve(expectedRepoRoot)) throw new Error('The run does not target its registered local repository.')
  const expectedBase = run.repository?.baseRef ?? 'main'
  if (run.workspace.baseRef !== expectedBase) throw new Error(`GitHub handoff is restricted to the registered ${expectedBase} base branch.`)
  if (!/^bond-agent\/[a-z0-9-]{1,24}$/.test(run.workspace.branch)) throw new Error('The run branch is outside the managed branch namespace.')
  if (run.workspace.branch !== inspection.branch) throw new Error('The inspected branch does not match the run workspace.')
  const expectedRemote = run.repository?.expectedRemoteUrl ?? EXPECTED_REMOTE_URL
  if (!expectedRemote || inspection.remoteUrl !== expectedRemote) throw new Error(`The registered remote must be exactly ${expectedRemote}.`)
  if (!run.baseSha || !/^[a-f0-9]{40,64}$/i.test(run.baseSha)) throw new Error('The run has no valid immutable base SHA.')
  if (!/^[a-f0-9]{40,64}$/i.test(inspection.headSha) || inspection.aheadBy < 1) throw new Error('The run branch has no committed change to publish.')
  if (inspection.porcelain) throw new Error('The run worktree has uncommitted changes; commit them before publishing.')
  if (!inspection.changedPaths.length) throw new Error('The committed branch has no changed paths.')
  if (!run.acceptanceChecks.length) throw new Error('The run declared no local acceptance checks.')
  const passed = new Set(listAgentRunEvents(run.id)
    .filter(event => event.type === 'command_completed' && event.data.exitCode === 0 && Array.isArray(event.data.argv))
    .map(event => JSON.stringify(event.data.argv)))
  const missing = run.acceptanceChecks.filter(check => !passed.has(check))
  if (missing.length) throw new Error(`Required local checks did not pass: ${missing.join(', ')}`)
}

function validatePullRequest(run: AgentRun, pr: GitHubDraftPullRequest): void {
  if (run.workspace.isolation !== 'worktree') throw new Error('Run has no publishable branch.')
  const repository = run.repository?.githubRepository ?? BOND_GITHUB_REPOSITORY
  if (pr.repository !== repository || pr.baseRef !== run.workspace.baseRef || pr.headRef !== run.workspace.branch) {
    throw new Error('GitHub returned a pull request outside this run contract.')
  }
  if (!pr.draft) throw new Error('Refusing to alter a pull request that is no longer a draft.')
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 || !pr.url.startsWith(`https://github.com/${repository}/pull/`)) {
    throw new Error('GitHub returned invalid pull request identity data.')
  }
}

export interface AgentRunHandoffOptions {
  config?: typeof githubConfigService
  git?: LocalGitPublisher
  github?: (credential: string) => GitHubDraftTransport
  repoRoot?: () => string
  reviewer?: AgentRunQReviewer
  credentialFor?: (run: AgentRun) => Promise<string>
}

export function createAgentRunHandoff(options: AgentRunHandoffOptions = {}) {
  const config = options.config ?? githubConfigService
  const gitPublisher = options.git ?? localGitPublisher
  const github = options.github
  const repoRoot = options.repoRoot ?? configuredBondRepoRoot
  const reviewer = options.reviewer
  const credentialFor = options.credentialFor ?? (async (run: AgentRun) => {
    if (!run.repository || run.repository.id === 'bond') return config.credential()
    if (!run.repository.credentialRef) throw new Error('The registered repository has no credential reference.')
    const value = await getSecretStore().get(run.repository.credentialRef)
    if (!value) throw new Error(`GitHub credential is missing from Keychain reference "${run.repository.credentialRef}".`)
    return value
  })

  const postQReview = async (
    run: AgentRun,
    publication: AgentRunPublication,
    changedPaths: string[],
    transport: GitHubDraftTransport,
  ): Promise<AgentRunPublication> => {
    if (!publication.qReviewRequired || publication.qReviewStatus === 'posted') return publication
    if (!reviewer) return markAgentRunQReview(run.id, { status: 'failed', errorMessage: 'Q reviewer is not configured.' })
    try {
      if (!publication.prNumber || !publication.prUrl) throw new Error('Q cannot review a run without its associated draft PR.')
      const report = await reviewer.review({ run, publication, changedPaths })
      const marker = `<!-- bond-q-review:${run.id} -->`
      const body = `${marker}\n## Q advisory review\n\n${report}`
      const existingComment = await transport.findQComment(publication.prNumber, marker)
      const comment = existingComment
        ? await transport.updateQComment(existingComment.id, body)
        : await transport.createQComment(publication.prNumber, body)
      if (!Number.isSafeInteger(comment.id) || comment.id < 1 || !comment.url.startsWith(`${publication.prUrl}#issuecomment-`)) {
        throw new Error('GitHub returned a Q comment outside the associated pull request.')
      }
      return markAgentRunQReview(run.id, { status: 'posted', commentId: comment.id, commentUrl: comment.url })
    } catch (error) {
      return markAgentRunQReview(run.id, { status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    async publish(candidate: AgentRun): Promise<AgentRunPublication> {
      const run = getAgentRun(candidate.id)
      if (!run) throw new Error(`Unknown agent run "${candidate.id}".`)
      if (run.workspace.isolation !== 'worktree') throw new Error('Run has no managed branch to publish.')
      const existing = getAgentRunPublication(run.id)
      if (existing?.status === 'published' && (!existing.qReviewRequired || existing.qReviewStatus === 'posted')) return existing
      let publication = existing
      try {
        const repository = run.repository?.githubRepository ?? BOND_GITHUB_REPOSITORY
        const remote = run.repository?.remote ?? BOND_GITHUB_REMOTE
        if (run.repository?.id === 'bond' || !run.repository) {
          const configured = await config.getConfig()
          if (configured.repository !== repository || configured.remote !== remote) throw new Error('GitHub configuration escaped the run repository boundary.')
        }
        if (!repository || !remote) throw new Error('The registered repository has no GitHub publication mapping.')
        const credential = await credentialFor(run)
        const inspection = await gitPublisher.inspect(run)
        validateRun(run, inspection, run.repository?.repoRoot ?? repoRoot())
        const transport = github ? github(credential) : createGitHubDraftTransport(credential, fetch, repository)
        if (existing?.status === 'published') {
          return postQReview(run, existing, inspection.changedPaths, transport)
        }
        publication ??= createAgentRunPublication({
          runId: run.id,
          baseRef: run.workspace.baseRef,
          headRef: run.workspace.branch,
          idempotencyKey: `github-draft:${run.id}`,
          qReviewRequired: requiresQReview(inspection.changedPaths),
          repository, remote,
        })
        publication = markAgentRunPublishing(run.id)
        await gitPublisher.pushRunBranch(run, credential)
        const title = `[Mathis] ${run.brief.split('\n')[0].slice(0, 120)}`
        const body = `Automated draft from Bond run \`${run.id}\`.\n\n${run.brief}\n\nBase: \`${run.baseSha}\``
        const found = await transport.findPullRequest(run.workspace.branch, run.workspace.baseRef)
        if (found) validatePullRequest(run, found)
        const pr = found
          ? await transport.updateDraft(found.number, { title, body })
          : await transport.createDraft({ headRef: run.workspace.branch, baseRef: run.workspace.baseRef, title, body })
        validatePullRequest(run, pr)
        publication = markAgentRunPublished(run.id, { number: pr.number, nodeId: pr.nodeId, url: pr.url })
        return postQReview(run, publication, inspection.changedPaths, transport)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const errorClass = /credential|disabled|Keychain/i.test(message) ? 'credential' : /branch|worktree|check|origin|remote|repository|draft|pull request/i.test(message) ? 'validation' : 'transport'
        if (run.repository && (!run.repository.githubRepository || !run.repository.remote)) throw error
        publication ??= createAgentRunPublication({
          runId: run.id,
          baseRef: run.workspace.baseRef,
          headRef: run.workspace.branch,
          idempotencyKey: `github-draft:${run.id}`,
          qReviewRequired: false,
          repository: run.repository?.githubRepository ?? BOND_GITHUB_REPOSITORY,
          remote: run.repository?.remote ?? BOND_GITHUB_REMOTE,
        })
        return markAgentRunPublishFailed(run.id, errorClass, message)
      }
    },
  }
}

export const agentRunHandoff = createAgentRunHandoff()

/** Test/config injection contract; deliberately contains no merge/ready/reviewer operations. */
export interface AgentRunPublisher {
  publish(run: AgentRun): Promise<AgentRunPublication>
}
