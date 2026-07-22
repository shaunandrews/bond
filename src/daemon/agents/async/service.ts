import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentRun, AgentRunDetail, AgentRunQuestion, AgentRunWorkspace, DispatchAgentRunInput, ManagedWorkspaceInspection } from '../../../shared/agent-runs'
import { MODEL_IDS } from '../../../shared/models'
import { resolveContextDocs } from '../context-docs'
import { effectiveAgentSettings, findAgent } from '../registry'
import { createAgentRunCompletionCoordinator } from './completion'
import {
  createAgentRunRecord,
  answerAgentRunQuestion,
  getAgentRun,
  getAgentRunByIdempotencyKey,
  listAgentRunEvents,
  listAgentRunQuestions,
  getAgentRunPublication,
  listAgentRuns,
  updateAgentRunWorkspaceState,
} from './store'
import { createAgentRunWorker } from './worker'
import { setAgentRunApi } from './api'
import {
  configuredBondBaseRef,
  configuredBondRepoRoot,
  plannedWorktree,
  workspaceManager,
} from './workspace'
import { MATHIS_COMMAND_POLICY_VERSION } from './command-policy'

const execFileAsync = promisify(execFile)
export const ASYNC_AGENT_COMMAND_POLICY_VERSION = 'phase0-readonly-no-shell-v1'
const MAX_BRIEF_CHARS = 20_000
const MAX_PATHS = 100

export interface AgentRunTransport {
  changed(run: AgentRun): void
}

let transport: AgentRunTransport | null = null
let started = false

function emit(run: AgentRun): void {
  transport?.changed(run)
}

const completion = createAgentRunCompletionCoordinator({ onChanged: emit })
function retainAndComplete(run: AgentRun): void {
  let terminal = run
  if (run.workspace.isolation === 'worktree' && run.workspaceState.status !== 'discarded') {
    const now = new Date().toISOString()
    terminal = updateAgentRunWorkspaceState(run.id, {
      ...run.workspaceState,
      status: 'retained',
      retainedAt: now,
    }, 'workspace_retained', { path: run.workspace.worktreePath }, now)
    emit(terminal)
  }
  completion.enqueue(terminal)
}

const worker = createAgentRunWorker({
  prepare: async (run, signal) => {
    if (run.workspace.isolation !== 'worktree') return run
    if (run.workspaceState.status === 'discarded') throw new Error('This run\'s managed worktree was discarded.')
    await workspaceManager.ensure(run, signal)
    if (run.workspaceState.status === 'ready') return run
    const now = new Date().toISOString()
    const updated = updateAgentRunWorkspaceState(run.id, {
      status: 'ready',
      createdAt: run.workspaceState.createdAt ?? now,
      retainedAt: null,
      discardedAt: null,
    }, 'workspace_ready', { path: run.workspace.worktreePath, branch: run.workspace.branch }, now)
    emit(updated)
    return updated
  },
  onChanged: emit,
  onQuestion: (run, question) => completion.enqueueQuestion(run, question),
  onTerminal: retainAndComplete,
})

function expandPath(path: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
  return resolve(homedir(), expanded)
}

function definitionVersion(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

async function gitBaseSha(root: string): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    const sha = result.stdout.trim()
    return /^[a-f0-9]{40,64}$/i.test(sha) ? sha : null
  } catch {
    return null
  }
}

function validateDispatch(input: DispatchAgentRunInput): void {
  if (!input.agent.trim()) throw new Error('agent is required')
  if (!input.verb.trim()) throw new Error('verb is required')
  if (!input.brief.trim()) throw new Error('brief is required')
  if (input.brief.length > MAX_BRIEF_CHARS) throw new Error(`brief exceeds ${MAX_BRIEF_CHARS} characters`)
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new Error('idempotencyKey must be 1-200 characters')
  if ((input.paths?.length ?? 0) > MAX_PATHS) throw new Error(`paths exceeds ${MAX_PATHS} entries`)
}

export function setAgentRunTransport(value: AgentRunTransport | null): void {
  transport = value
}

export function startAgentRunService(): void {
  if (started) return
  started = true
  setAgentRunApi({ dispatch: dispatchAgentRun, check: checkAgentRun, answer: answerAgentQuestion })
  completion.reconcile()
  worker.start()
}

export async function stopAgentRunService(): Promise<void> {
  if (!started) return
  started = false
  setAgentRunApi(null)
  await worker.stop()
}

export async function dispatchAgentRun(input: DispatchAgentRunInput): Promise<{ run: AgentRun; created: boolean }> {
  validateDispatch(input)
  const agentName = input.agent.trim().toLowerCase()
  const verbName = input.verb.trim().toLowerCase()
  let paths = (input.paths ?? []).map(expandPath)
  const prior = getAgentRunByIdempotencyKey(input.idempotencyKey.trim())
  if (prior) {
    if (prior.workspace.isolation === 'worktree' && input.confirmed !== true) {
      throw new Error('Mathis requires explicit user confirmation of the immutable task brief before dispatch.')
    }
    const priorWorkspace = prior.workspace
    const retryPaths = priorWorkspace.isolation === 'worktree'
      ? ((input.paths ?? []).length
          ? (input.paths ?? []).map(path => {
              const source = isAbsolute(path) ? resolve(path) : resolve(priorWorkspace.repoRoot, path)
              return resolve(priorWorkspace.worktreePath, relative(priorWorkspace.repoRoot, source))
            })
          : [priorWorkspace.worktreePath])
      : paths
    const sameRequest = prior.agent === agentName
      && prior.verb === verbName
      && prior.brief === input.brief.trim()
      && JSON.stringify(prior.paths) === JSON.stringify(retryPaths)
    if (!sameRequest) throw new Error(`Idempotency key "${input.idempotencyKey}" already belongs to a different agent run.`)
    return { run: prior, created: false }
  }
  const definition = findAgent(agentName)
  if (!definition) throw new Error(`Unknown agent "${input.agent}".`)
  const verb = definition.verbs.find(entry => entry.name === verbName)
  if (!verb) throw new Error(`"${input.verb}" is not a verb of ${definition.label}.`)

  const effective = effectiveAgentSettings(definition)
  const parentModel = input.parentModel && (MODEL_IDS as readonly string[]).includes(input.parentModel)
    ? input.parentModel
    : undefined
  const settings = effective.model === 'inherit' && parentModel
    ? { ...effective, model: parentModel as typeof effective.model }
    : effective
  if (settings.workspace === 'write' && input.confirmed !== true) {
    throw new Error(`${definition.label} requires explicit user confirmation of the immutable task brief before dispatch.`)
  }

  const id = randomUUID()
  let workspace: AgentRunWorkspace
  let baseSha: string | null
  let allowedPaths: string[]
  if (settings.workspace === 'write') {
    const repoRoot = configuredBondRepoRoot()
    const baseRef = configuredBondBaseRef()
    baseSha = await workspaceManager.resolveBase(repoRoot, baseRef)
    const writeWorkspace = plannedWorktree(id, repoRoot, baseRef)
    workspace = writeWorkspace
    const sourcePaths = (input.paths ?? []).map(path => isAbsolute(path) ? resolve(path) : resolve(repoRoot, path))
    paths = sourcePaths.length ? sourcePaths.map(path => {
      const rel = relative(repoRoot, path)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Mathis path is outside the configured Bond repository: ${path}`)
      return resolve(writeWorkspace.worktreePath, rel)
    }) : [writeWorkspace.worktreePath]
    allowedPaths = [writeWorkspace.worktreePath]
  } else {
    const docs = paths.length ? resolveContextDocs(paths, definition.contextDocs) : { root: homedir(), docs: {} }
    const repoRoot = docs.root ?? homedir()
    workspace = { repoRoot, isolation: 'in-place' as const, branch: null, readOnly: true as const }
    baseSha = await gitBaseSha(repoRoot)
    allowedPaths = paths
  }

  const created = createAgentRunRecord({
    id,
    idempotencyKey: input.idempotencyKey.trim(),
    agent: definition.name,
    agentLabel: definition.label,
    verb: verb.name,
    brief: input.brief.trim(),
    paths,
    workspace,
    baseSha,
    allowedPaths,
    settings,
    agentDefinitionVersion: definitionVersion({ definition, settings }),
    commandPolicyVersion: workspace.isolation === 'worktree' ? MATHIS_COMMAND_POLICY_VERSION : ASYNC_AGENT_COMMAND_POLICY_VERSION,
    acceptanceChecks: [],
    resourceCaps: {
      wallClockSeconds: settings.leash,
      maxOutputChars: 100_000,
      maxSteps: 80,
      maxSubprocesses: 24,
      maxDiskBytes: 2 * 1024 * 1024 * 1024,
      maxTokens: 250_000,
      maxCostUsd: 25,
    },
  })
  if (created.created) {
    emit(created.run)
    if (started) void worker.wake()
  }
  return created
}

export function checkAgentRun(runId: string): AgentRunDetail | null {
  const run = getAgentRun(runId)
  return run ? {
    run,
    events: listAgentRunEvents(run.id),
    questions: listAgentRunQuestions(run.id),
    publication: getAgentRunPublication(run.id),
  } : null
}

export async function answerAgentQuestion(
  runId: string,
  questionId: string,
  approved: boolean,
  response = '',
): Promise<{ run: AgentRun; question: AgentRunQuestion; changed: boolean }> {
  const answered = answerAgentRunQuestion(runId, questionId, approved, response.trim())
  emit(answered.run)
  if (!answered.changed) return answered
  if (approved) await worker.resume(runId)
  else retainAndComplete(answered.run)
  return answered
}

export function cancelAgentRun(runId: string): AgentRun | null {
  return worker.cancel(runId)
}

export function reconnectAgentRuns(): AgentRun[] {
  return listAgentRuns({ limit: 100 })
}

export async function inspectAgentRunWorkspace(runId: string): Promise<ManagedWorkspaceInspection> {
  const run = getAgentRun(runId)
  if (!run) throw new Error(`Unknown agent run "${runId}".`)
  return workspaceManager.inspect(run)
}

export async function discardAgentRunWorkspace(runId: string): Promise<AgentRun> {
  const run = getAgentRun(runId)
  if (!run) throw new Error(`Unknown agent run "${runId}".`)
  if (!['succeeded', 'failed', 'cancelled'].includes(run.status)) throw new Error('A managed worktree can only be discarded after the run finishes.')
  if (run.workspace.isolation !== 'worktree') throw new Error('This run has no managed worktree.')
  if (run.workspaceState.status === 'discarded') return run
  await workspaceManager.discard(run)
  const now = new Date().toISOString()
  const updated = updateAgentRunWorkspaceState(run.id, {
    ...run.workspaceState,
    status: 'discarded',
    discardedAt: now,
  }, 'workspace_discarded', { path: run.workspace.worktreePath, branch: run.workspace.branch }, now)
  emit(updated)
  return updated
}
