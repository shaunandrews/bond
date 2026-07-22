import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { AgentRun, AgentRunPublication, AgentRunUpdate, AgentRunUpdateRisk } from '../../../shared/agent-runs'
import { getSecretStore } from '../../mcp/keychain'
import { hasActiveTurns } from '../../turns'
import { SAFE_COMMAND_PATH } from './command-runner'
import { BOND_GITHUB_REPOSITORY, githubConfigService } from './github-config'
import { configuredBondBaseRef, configuredBondRepoRoot } from './workspace'
import {
  getAgentRun,
  getAgentRunPublication,
  getAgentRunUpdate,
  listAgentRuns,
  markAgentRunUpdate,
  recordAgentRunMerge,
} from './store'

const execFileAsync = promisify(execFile)
const EXPECTED_REMOTE_URL = 'https://github.com/shaunandrews/bond.git'

export interface GitHubMergeState {
  merged: boolean
  mergeCommitSha: string | null
  mergedAt: string | null
  changedPaths: string[]
}

export interface GitHubMergeReader {
  getPullRequest(prNumber: number): Promise<GitHubMergeState>
}

export interface BondCheckoutInspection {
  root: string
  branch: string
  porcelain: string
  remoteUrl: string
  canFastForward: boolean
}

export interface BondUpdateDriver {
  inspect(mergeCommitSha: string): Promise<BondCheckoutInspection>
  fastForward(mergeCommitSha: string): Promise<void>
  reloadRenderer(): Promise<void>
  buildDaemon(): Promise<void>
  restartDaemon(): Promise<void>
  awaitReconnect(): Promise<void>
}

const PROTOCOL_OR_SCHEMA = [
  /^src\/shared\//,
  /^src\/daemon\/db\.ts$/,
  /^src\/daemon\/agents\/async\/schema\.ts$/,
  /(?:^|\/)migrations?\//,
  /^package(?:-lock)?\.json$/,
]

export function classifyMergedPaths(paths: string[]): { risk: AgentRunUpdateRisk; reason: string } {
  const normalized = [...new Set(paths.map(path => path.replace(/^\.\//, '')).filter(Boolean))].sort()
  if (!normalized.length) return { risk: 'scheduled', reason: 'The merge has no verifiable changed-path set.' }
  if (normalized.some(path => PROTOCOL_OR_SCHEMA.some(pattern => pattern.test(path)))) {
    return { risk: 'scheduled', reason: 'The merge changes a shared contract, dependency manifest, or database schema.' }
  }
  if (normalized.every(path => path.startsWith('src/renderer/') || path.startsWith('public/'))) {
    return { risk: 'renderer', reason: 'Every changed path is renderer-only.' }
  }
  if (normalized.every(path => path.startsWith('src/daemon/'))) {
    return { risk: 'daemon', reason: 'Every changed path is daemon-only and no protocol or schema path changed.' }
  }
  return { risk: 'scheduled', reason: 'The merge spans multiple runtime areas or includes an unclassified path.' }
}

function validateMergeState(run: AgentRun, prNumber: number, state: GitHubMergeState): asserts state is GitHubMergeState & { mergeCommitSha: string; mergedAt: string } {
  if (!state.merged) return
  if (!/^[a-f0-9]{40,64}$/i.test(state.mergeCommitSha ?? '')) throw new Error(`PR #${prNumber} returned an invalid merge commit.`)
  if (!state.mergedAt || Number.isNaN(Date.parse(state.mergedAt))) throw new Error(`PR #${prNumber} returned an invalid merge timestamp.`)
  if (run.workspace.isolation !== 'worktree') throw new Error('Only a managed published run can be merge-tracked.')
}

export interface MergeUpdateCoordinatorOptions {
  reader: (run: AgentRun, publication: AgentRunPublication) => Promise<GitHubMergeReader>
  driver: BondUpdateDriver
  activeTurn?: () => boolean
  onChanged?: (run: AgentRun) => void
  intervalMs?: number
}

export function createMergeUpdateCoordinator(options: MergeUpdateCoordinatorOptions) {
  const activeTurn = options.activeTurn ?? hasActiveTurns
  const intervalMs = options.intervalMs ?? 60_000
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false

  async function poll(): Promise<AgentRunUpdate[]> {
    if (polling) return []
    polling = true
    const detected: AgentRunUpdate[] = []
    try {
      const candidates = listAgentRuns({ statuses: ['succeeded'], limit: 500 })
        .filter(run => {
          const publication = getAgentRunPublication(run.id)
          return publication?.status === 'published' && publication.prNumber && !getAgentRunUpdate(run.id)
        })
      if (!candidates.length) return detected
      for (const run of candidates) {
        const publication = getAgentRunPublication(run.id)!
        const reader = await options.reader(run, publication)
        const state = await reader.getPullRequest(publication.prNumber!)
        validateMergeState(run, publication.prNumber!, state)
        if (!state.merged) continue
        const classification = classifyMergedPaths(state.changedPaths)
        const recorded = recordAgentRunMerge({
          runId: run.id, prNumber: publication.prNumber!, mergeCommitSha: state.mergeCommitSha,
          mergedAt: state.mergedAt, changedPaths: state.changedPaths,
          risk: classification.risk, reason: classification.reason,
        })
        detected.push(recorded.update)
        options.onChanged?.(getAgentRun(run.id)!)
      }
      return detected
    } finally {
      polling = false
    }
  }

  async function apply(runId: string, confirmed = false): Promise<AgentRunUpdate> {
    const update = getAgentRunUpdate(runId)
    if (!update) throw new Error(`Run "${runId}" has no detected merge.`)
    const run = getAgentRun(runId)
    if (!run || (run.repository && run.repository.id !== 'bond')) throw new Error('Automatic local updates are restricted to the registered Bond repository.')
    if (update.status === 'applied') return update
    if (update.risk === 'scheduled' && !confirmed) throw new Error('This broad or contract-changing update requires explicit scheduled confirmation.')
    if (activeTurn()) {
      return markAgentRunUpdate(runId, 'deferred', {
        eventType: 'local_update_deferred',
        recoveryInstructions: 'Wait for the active user turn to finish, then retry the same update action.',
        data: { reason: 'active-user-turn' },
      })
    }
    const inspection = await options.driver.inspect(update.mergeCommitSha)
    const expectedRoot = configuredBondRepoRoot()
    const expectedBranch = configuredBondBaseRef()
    const refusal = inspection.root !== expectedRoot
      ? `Active checkout root is ${inspection.root}, expected ${expectedRoot}.`
      : inspection.branch !== expectedBranch
        ? `Active checkout is on ${inspection.branch || 'detached HEAD'}, expected ${expectedBranch}.`
        : inspection.porcelain
          ? 'Active checkout has local changes.'
          : inspection.remoteUrl !== EXPECTED_REMOTE_URL
            ? `origin must be exactly ${EXPECTED_REMOTE_URL}.`
            : !inspection.canFastForward
              ? 'Active checkout cannot fast-forward to the detected merge commit.'
              : null
    if (refusal) return markAgentRunUpdate(runId, 'failed', {
      eventType: 'local_update_refused', errorMessage: refusal,
      recoveryInstructions: 'Restore the expected clean checkout and retry; Bond did not reset or overwrite anything.',
    })

    markAgentRunUpdate(runId, 'updating', { eventType: 'local_update_started', data: { risk: update.risk } })
    try {
      await options.driver.fastForward(update.mergeCommitSha)
      if (update.risk === 'renderer') await options.driver.reloadRenderer()
      if (update.risk === 'daemon') {
        await options.driver.buildDaemon()
        await options.driver.restartDaemon()
        await options.driver.awaitReconnect()
      }
      const applied = markAgentRunUpdate(runId, 'applied', { eventType: 'local_update_applied', data: { risk: update.risk } })
      options.onChanged?.(getAgentRun(runId)!)
      return applied
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return markAgentRunUpdate(runId, 'failed', {
        eventType: 'local_update_failed', errorMessage: message,
        recoveryInstructions: `The checkout was never reset. Verify ${update.mergeCommitSha}, run the required build manually, and reconnect Bond before retrying.`,
      })
    }
  }

  return {
    start() { if (!timer) { timer = setInterval(() => void poll().catch(error => console.warn('[agents/merge] poll failed:', error)), intervalMs); timer.unref?.() } },
    stop() { if (timer) clearInterval(timer); timer = undefined },
    poll,
    apply,
  }
}

export function createGitHubMergeReader(credential: string, fetcher: typeof fetch = fetch, repository: string = BOND_GITHUB_REPOSITORY): GitHubMergeReader {
  const request = async (path: string): Promise<any> => {
    if (!path.startsWith(`/repos/${repository}/`)) throw new Error('GitHub merge read escaped the configured repository.')
    const response = await fetcher(`https://api.github.com${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${credential}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Bond-Mathis' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GitHub merge read failed with HTTP ${response.status}.`)
    return response.json()
  }
  return {
    async getPullRequest(prNumber) {
      const [pr, files] = await Promise.all([
        request(`/repos/${repository}/pulls/${prNumber}`),
        request(`/repos/${repository}/pulls/${prNumber}/files?per_page=100`),
      ])
      return {
        merged: pr.merged === true,
        mergeCommitSha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null,
        mergedAt: typeof pr.merged_at === 'string' ? pr.merged_at : null,
        changedPaths: Array.isArray(files) ? files.map(value => String(value.filename ?? '')).filter(Boolean) : [],
      }
    },
  }
}

function safeGitEnv(): NodeJS.ProcessEnv {
  return { PATH: SAFE_COMMAND_PATH, HOME: homedir(), LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], { env: safeGitEnv(), timeout: 120_000, maxBuffer: 512 * 1024 })
  return result.stdout.trim()
}

/** Host lifecycle hooks are injected by the app; tests never launch or restart Bond. */
export function createLocalBondUpdateDriver(lifecycle: Pick<BondUpdateDriver, 'reloadRenderer' | 'restartDaemon' | 'awaitReconnect'>): BondUpdateDriver {
  return {
    async inspect(mergeCommitSha) {
      const root = configuredBondRepoRoot()
      const [top, branch, porcelain, remoteUrl] = await Promise.all([
        git(root, ['rev-parse', '--show-toplevel']), git(root, ['branch', '--show-current']),
        git(root, ['status', '--porcelain=v1']), git(root, ['remote', 'get-url', 'origin']),
      ])
      let canFastForward = false
      try { await git(root, ['merge-base', '--is-ancestor', 'HEAD', mergeCommitSha]); canFastForward = true } catch { /* safe refusal */ }
      return { root: top, branch, porcelain, remoteUrl, canFastForward }
    },
    async fastForward(sha) { await git(configuredBondRepoRoot(), ['merge', '--ff-only', sha]) },
    async buildDaemon() { await execFileAsync('npm', ['run', 'build'], { cwd: configuredBondRepoRoot(), env: safeGitEnv(), timeout: 15 * 60_000, maxBuffer: 2 * 1024 * 1024 }) },
    ...lifecycle,
  }
}

export async function configuredMergeReader(run: AgentRun, publication: AgentRunPublication): Promise<GitHubMergeReader> {
  if (!run.repository || run.repository.id === 'bond') return createGitHubMergeReader(await githubConfigService.credential(), fetch, publication.repository)
  if (!run.repository.credentialRef) throw new Error('The registered repository has no credential reference.')
  const credential = await getSecretStore().get(run.repository.credentialRef)
  if (!credential) throw new Error(`GitHub credential is missing from Keychain reference "${run.repository.credentialRef}".`)
  return createGitHubMergeReader(credential, fetch, publication.repository)
}
