import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AgentRun, ManagedWorkspaceInspection, ManagedWorktreeWorkspace } from '../../../shared/agent-runs'
import { getDataDir } from '../../paths'
import { getSetting } from '../../settings'

const execFileAsync = promisify(execFile)
const DEFAULT_BOND_REPO = join(homedir(), 'Developer', 'Projects', 'bond')
const DEFAULT_BASE_REF = 'main'
const GIT_TIMEOUT_MS = 30_000
const GIT_OUTPUT_CAP = 256 * 1024

export interface ArgvResult {
  stdout: string
  stderr: string
}

export type ArgvExec = (file: string, args: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxBuffer: number
}) => Promise<ArgvResult>

const defaultExec: ArgvExec = async (file, args, options) => {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: homedir(),
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

async function git(exec: ArgvExec, cwd: string, args: string[]): Promise<ArgvResult> {
  // Pass the repository explicitly as argv. This keeps discovery independent
  // from process cwd changes in the daemon and makes every trusted git target
  // visible at the call boundary.
  return exec('git', ['-C', cwd, ...args], {
    cwd: '/',
    env: gitEnv(),
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_CAP,
  })
}

export function configuredBondRepoRoot(): string {
  return resolve(getSetting('agents.bondRepoRoot') ?? DEFAULT_BOND_REPO)
}

export function configuredBondBaseRef(): string {
  const value = getSetting('agents.bondBaseRef')?.trim()
  return value && /^[A-Za-z0-9._/-]+$/.test(value) ? value : DEFAULT_BASE_REF
}

export function managedWorktreeRoot(): string {
  return join(getDataDir(), 'agent-worktrees')
}

export function managedBranchName(runId: string): string {
  return `bond-agent/${runId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24)}`
}

export function plannedWorktree(
  runId: string,
  repoRoot: string,
  baseRef: string,
  worktreeRoot = managedWorktreeRoot(),
): ManagedWorktreeWorkspace {
  return {
    repoRoot: resolve(repoRoot),
    isolation: 'worktree',
    branch: managedBranchName(runId),
    baseRef,
    worktreePath: join(worktreeRoot, runId),
    readOnly: false,
  }
}

function nearestExisting(path: string): string {
  let candidate = path
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) throw new Error(`No existing ancestor for ${path}`)
    candidate = parent
  }
  return candidate
}

/** Resolve symlinks in the nearest existing ancestor before containment. */
export function assertContainedPath(root: string, target: string, options: { protectGit?: boolean } = {}): string {
  const absoluteRoot = realpathSync(resolve(root))
  const absoluteTarget = resolve(root, target)
  const lexical = relative(resolve(root), absoluteTarget)
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error(`Path escapes the managed worktree: ${target}`)
  }
  if (options.protectGit !== false && (lexical === '.git' || lexical.startsWith(`.git${sep}`))) {
    throw new Error('The managed worktree .git metadata is protected.')
  }
  const ancestor = nearestExisting(absoluteTarget)
  const resolvedTarget = resolve(realpathSync(ancestor), relative(ancestor, absoluteTarget))
  const physical = relative(absoluteRoot, resolvedTarget)
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
    throw new Error(`Path resolves outside the managed worktree: ${target}`)
  }
  return resolvedTarget
}

function requireManaged(run: AgentRun, managedRoot: string): ManagedWorktreeWorkspace {
  if (run.workspace.isolation !== 'worktree') throw new Error(`Run ${run.id} has no managed worktree.`)
  const root = resolve(managedRoot)
  const path = resolve(run.workspace.worktreePath)
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Run ${run.id} has an invalid managed worktree path.`)
  }
  return run.workspace
}

export interface WorkspaceManagerOptions {
  exec?: ArgvExec
  managedRoot?: string
}

export function createWorkspaceManager(options: WorkspaceManagerOptions = {}) {
  const exec = options.exec ?? defaultExec
  const managedRoot = options.managedRoot ?? managedWorktreeRoot()

  async function resolveBase(repoRoot: string, baseRef: string): Promise<string> {
    const root = realpathSync(resolve(repoRoot))
    const top = (await git(exec, root, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (realpathSync(top) !== root) throw new Error(`${repoRoot} is not the configured git repository root.`)
    const sha = (await git(exec, root, ['rev-parse', '--verify', `${baseRef}^{commit}`])).stdout.trim()
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error(`Could not resolve ${baseRef} to a commit.`)
    return sha
  }

  async function ensure(run: AgentRun, signal?: AbortSignal): Promise<ManagedWorktreeWorkspace> {
    const workspace = requireManaged(run, managedRoot)
    if (signal?.aborted) throw new Error('Workspace creation cancelled.')
    mkdirSync(dirname(workspace.worktreePath), { recursive: true })
    if (!existsSync(workspace.worktreePath)) {
      try {
        await git(exec, workspace.repoRoot, ['worktree', 'add', '-b', workspace.branch, workspace.worktreePath, run.baseSha!])
      } catch (error) {
        // A crash can leave the uniquely-owned branch after the directory was
        // never fully attached. Reattach only when it still names our base.
        let branchSha = ''
        try {
          branchSha = (await git(exec, workspace.repoRoot, ['rev-parse', '--verify', `${workspace.branch}^{commit}`])).stdout.trim()
        } catch { /* branch was never created */ }
        if (branchSha !== run.baseSha) throw error
        await git(exec, workspace.repoRoot, ['worktree', 'add', workspace.worktreePath, workspace.branch])
      }
    }
    if (signal?.aborted) throw new Error('Workspace creation cancelled.')
    const top = (await git(exec, workspace.worktreePath, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (realpathSync(top) !== realpathSync(workspace.worktreePath)) throw new Error('Managed worktree resolved to an unexpected path.')
    const branch = (await git(exec, workspace.worktreePath, ['branch', '--show-current'])).stdout.trim()
    if (branch !== workspace.branch) throw new Error(`Managed worktree is on ${branch || 'detached HEAD'}, expected ${workspace.branch}.`)
    return workspace
  }

  async function inspect(run: AgentRun): Promise<ManagedWorkspaceInspection> {
    const workspace = requireManaged(run, managedRoot)
    if (!existsSync(workspace.worktreePath) || !statSync(workspace.worktreePath).isDirectory()) {
      return {
        runId: run.id, path: workspace.worktreePath, branch: workspace.branch,
        baseSha: run.baseSha, headSha: null, status: run.workspaceState.status,
        porcelain: '', diffStat: '',
      }
    }
    const [head, status, diff] = await Promise.all([
      git(exec, workspace.worktreePath, ['rev-parse', 'HEAD']),
      git(exec, workspace.worktreePath, ['status', '--porcelain=v1']),
      git(exec, workspace.worktreePath, ['diff', '--stat', 'HEAD']),
    ])
    return {
      runId: run.id,
      path: workspace.worktreePath,
      branch: workspace.branch,
      baseSha: run.baseSha,
      headSha: head.stdout.trim() || null,
      status: run.workspaceState.status,
      porcelain: status.stdout,
      diffStat: diff.stdout,
    }
  }

  async function discard(run: AgentRun): Promise<void> {
    const workspace = requireManaged(run, managedRoot)
    if (existsSync(workspace.worktreePath)) {
      await git(exec, workspace.repoRoot, ['worktree', 'remove', '--force', workspace.worktreePath])
    } else {
      await git(exec, workspace.repoRoot, ['worktree', 'prune'])
    }
    try { await git(exec, workspace.repoRoot, ['branch', '-D', workspace.branch]) } catch { /* already absent */ }
  }

  return { resolveBase, ensure, inspect, discard }
}

export const workspaceManager = createWorkspaceManager()

export function workspaceLabel(run: AgentRun): string {
  return run.workspace.isolation === 'worktree'
    ? `${basename(run.workspace.repoRoot)}:${run.workspace.branch}`
    : run.workspace.repoRoot
}
