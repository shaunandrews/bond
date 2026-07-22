import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { AgentRun, AgentRunDetail, DispatchAgentRunInput } from '../../../shared/agent-runs'
import { MODEL_IDS } from '../../../shared/models'
import { resolveContextDocs } from '../context-docs'
import { effectiveAgentSettings, findAgent } from '../registry'
import { createAgentRunCompletionCoordinator } from './completion'
import {
  createAgentRunRecord,
  getAgentRun,
  getAgentRunByIdempotencyKey,
  listAgentRunEvents,
  listAgentRuns,
} from './store'
import { createAgentRunWorker } from './worker'
import { setAgentRunApi } from './api'

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
const worker = createAgentRunWorker({
  onChanged: emit,
  onTerminal: run => completion.enqueue(run),
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
  setAgentRunApi({ dispatch: dispatchAgentRun, check: checkAgentRun })
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
  const paths = (input.paths ?? []).map(expandPath)
  const prior = getAgentRunByIdempotencyKey(input.idempotencyKey.trim())
  if (prior) {
    const sameRequest = prior.agent === agentName
      && prior.verb === verbName
      && prior.brief === input.brief.trim()
      && JSON.stringify(prior.paths) === JSON.stringify(paths)
    if (!sameRequest) throw new Error(`Idempotency key "${input.idempotencyKey}" already belongs to a different agent run.`)
    return { run: prior, created: false }
  }
  const definition = findAgent(agentName)
  if (!definition) throw new Error(`Unknown agent "${input.agent}".`)
  const verb = definition.verbs.find(entry => entry.name === verbName)
  if (!verb) throw new Error(`"${input.verb}" is not a verb of ${definition.label}.`)

  const docs = paths.length ? resolveContextDocs(paths, definition.contextDocs) : { root: homedir(), docs: {} }
  const repoRoot = docs.root ?? homedir()
  const effective = effectiveAgentSettings(definition)
  const parentModel = input.parentModel && (MODEL_IDS as readonly string[]).includes(input.parentModel)
    ? input.parentModel
    : undefined
  const settings = effective.model === 'inherit' && parentModel
    ? { ...effective, model: parentModel as typeof effective.model }
    : effective

  const created = createAgentRunRecord({
    idempotencyKey: input.idempotencyKey.trim(),
    agent: definition.name,
    agentLabel: definition.label,
    verb: verb.name,
    brief: input.brief.trim(),
    paths,
    workspace: { repoRoot, isolation: 'in-place', branch: null, readOnly: true },
    baseSha: await gitBaseSha(repoRoot),
    allowedPaths: paths,
    settings,
    agentDefinitionVersion: definitionVersion({ definition, settings }),
    commandPolicyVersion: ASYNC_AGENT_COMMAND_POLICY_VERSION,
    acceptanceChecks: [],
    resourceCaps: { wallClockSeconds: settings.leash, maxOutputChars: 100_000 },
  })
  if (created.created) {
    emit(created.run)
    if (started) void worker.wake()
  }
  return created
}

export function checkAgentRun(runId: string): AgentRunDetail | null {
  const run = getAgentRun(runId)
  return run ? { run, events: listAgentRunEvents(run.id) } : null
}

export function cancelAgentRun(runId: string): AgentRun | null {
  return worker.cancel(runId)
}

export function reconnectAgentRuns(): AgentRun[] {
  return listAgentRuns({ limit: 100 })
}
