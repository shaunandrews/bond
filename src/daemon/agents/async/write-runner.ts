import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { AgentRun, AgentRunEvent } from '../../../shared/agent-runs'
import { selectModel } from '../../pi/model'
import { buildAgentSystemPrompt, buildAgentUserPrompt } from '../prompt'
import { findAgent } from '../registry'
import { thinkingLevelFor } from '../run-agent'
import { applyRepositoryCommandProfile, evaluateMathisCommand } from './command-policy'
import { runArgvCommand, SAFE_COMMAND_PATH } from './command-runner'
import { assertContainedPath } from './workspace'
import { AgentResourceLimitError } from './failures'

export const MATHIS_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'run_command']
const FILE_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'edit', 'write'])

export interface ProposedCommandQuestion {
  argv: string[]
  reason: string
  proposedAllowlistAddition: string
}

export class CommandApprovalRequired extends Error {
  constructor(readonly question: ProposedCommandQuestion) {
    super(question.reason)
    this.name = 'CommandApprovalRequired'
  }
}

export interface MathisResourceSnapshot {
  steps: number
  commands: number
  tokens: number
  costUsd: number
  fingerprints: Record<string, number>
}

export class MathisResourceGuard {
  private steps: number
  private commands: number
  private tokens: number
  private costUsd: number
  private readonly fingerprints: Map<string, number>

  constructor(
    private readonly maxSteps = 80,
    private readonly maxCommands = 24,
    private readonly maxRepeats = 4,
    private readonly maxTokens = 250_000,
    private readonly maxCostUsd = 25,
    initial: Partial<MathisResourceSnapshot> = {},
    private readonly onChange?: (snapshot: MathisResourceSnapshot) => void,
  ) {
    this.steps = Math.max(0, initial.steps ?? 0)
    this.commands = Math.max(0, initial.commands ?? 0)
    this.tokens = Math.max(0, initial.tokens ?? 0)
    this.costUsd = Math.max(0, initial.costUsd ?? 0)
    this.fingerprints = new Map(Object.entries(initial.fingerprints ?? {}).map(([key, count]) => [key, Math.max(0, count)]))
  }

  snapshot(): MathisResourceSnapshot {
    return {
      steps: this.steps,
      commands: this.commands,
      tokens: this.tokens,
      costUsd: this.costUsd,
      fingerprints: Object.fromEntries(this.fingerprints),
    }
  }

  private changed(): void { this.onChange?.(this.snapshot()) }

  recordTool(name: string, input: unknown): void {
    this.steps += 1
    if (name === 'run_command') this.commands += 1
    this.changed()
    if (this.steps > this.maxSteps) throw new AgentResourceLimitError(`Mathis exceeded the ${this.maxSteps}-step resource cap.`)
    if (this.commands > this.maxCommands) throw new AgentResourceLimitError(`Mathis exceeded the ${this.maxCommands}-command resource cap.`)
  }

  recordResult(name: string, input: unknown, result: unknown): void {
    const fingerprint = createHash('sha256').update(`${name}:${JSON.stringify(input)}:${JSON.stringify(result)}`).digest('hex')
    const count = (this.fingerprints.get(fingerprint) ?? 0) + 1
    this.fingerprints.set(fingerprint, count)
    this.changed()
    if (count > this.maxRepeats) throw new AgentResourceLimitError(`Mathis repeated the same ${name} action too many times.`)
  }

  recordUsage(tokens: number, costUsd: number): void {
    this.tokens += Math.max(0, tokens)
    this.costUsd += Math.max(0, costUsd)
    this.changed()
    if (this.tokens > this.maxTokens) throw new AgentResourceLimitError(`Mathis exceeded the ${this.maxTokens}-token resource cap.`)
    if (this.costUsd > this.maxCostUsd) throw new AgentResourceLimitError(`Mathis exceeded the $${this.maxCostUsd} resource cap.`)
  }
}

function directoryBytes(root: string, cap: number): number {
  let total = 0
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) visit(path)
      else total += statSync(path).size
      if (total > cap) return
    }
  }
  visit(root)
  return total
}

export function packageScriptsMatch(currentPackage: string, basePackage: string): boolean {
  try {
    const current = JSON.parse(currentPackage) as { scripts?: unknown }
    const base = JSON.parse(basePackage) as { scripts?: unknown }
    return JSON.stringify(current.scripts ?? {}) === JSON.stringify(base.scripts ?? {})
  } catch {
    return false
  }
}

function assertNpmScriptsUnchanged(run: AgentRun, argv: string[]): void {
  if (argv[0] !== 'npm' || !['run', 'test'].includes(argv[1] ?? '')) return
  if (run.workspace.readOnly || !run.baseSha) throw new Error('Cannot validate npm scripts without a writable git workspace and immutable base commit.')
  const root = run.workspace.isolation === 'worktree' ? run.workspace.worktreePath : run.workspace.repoRoot
  const current = readFileSync(join(root, 'package.json'), 'utf8')
  const base = execFileSync('git', ['-C', root, 'show', `${run.baseSha}:package.json`], {
    encoding: 'utf8',
    env: {
      PATH: SAFE_COMMAND_PATH,
      HOME: root,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!packageScriptsMatch(current, base)) {
    throw new Error('Command denied: package.json scripts differ from the immutable base commit; use an argv-only tool command instead.')
  }
}

export interface MathisExtensionOptions {
  run: AgentRun
  signal: AbortSignal
  exactGrants?: ReadonlySet<string>
  guard?: MathisResourceGuard
  onQuestion(question: ProposedCommandQuestion): void
  onCommandStarted?: (input: { argv: string[]; rule: string; pid: number }) => void
  onCommandCompleted?: (input: { argv: string[]; rule: string; exitCode: number | null; signal: NodeJS.Signals | null }) => void
}

export function latestMathisResourceSnapshot(events: AgentRunEvent[]): MathisResourceSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'resource_checkpoint') continue
    const usage = event.data.usage
    if (usage && typeof usage === 'object') return usage as MathisResourceSnapshot
  }
  return undefined
}

export function createMathisExtensionFactory(options: MathisExtensionOptions) {
  if (options.run.workspace.readOnly) throw new Error('Mathis requires a writable registered workspace.')
  const worktree = options.run.workspace.isolation === 'worktree' ? options.run.workspace.worktreePath : options.run.workspace.repoRoot
  const caps = options.run.resourceCaps
  const guard = options.guard ?? new MathisResourceGuard(
    caps.maxSteps ?? 80,
    caps.maxSubprocesses ?? 24,
    4,
    caps.maxTokens ?? 250_000,
    caps.maxCostUsd ?? 25,
  )
  const calls = new Map<string, { name: string; input: unknown }>()
  return (pi: ExtensionAPI) => {
    pi.on('tool_call', async (event: any) => {
      const toolName = String(event.toolName)
      const input = (event.input ?? {}) as Record<string, unknown>
      guard.recordTool(toolName, input)
      calls.set(String(event.toolCallId), { name: toolName, input })
      if (!FILE_TOOLS.has(toolName)) return
      const target = input.path ?? input.file_path
      if (typeof target === 'string') {
        try {
          const resolved = assertContainedPath(worktree, target)
          const allowed = options.run.allowedPaths.some(prefix => {
            const rel = relative(resolve(prefix), resolved)
            return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
          })
          if (!allowed) throw new Error(`Path is outside this run's registered allowed paths: ${target}`)
        }
        catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) } }
      }
    })
    pi.on('tool_result', async (event: any) => {
      const call = calls.get(String(event.toolCallId)) ?? { name: String(event.toolName), input: event.input }
      calls.delete(String(event.toolCallId))
      guard.recordResult(call.name, call.input, { content: event.content, isError: event.isError })
    })
    pi.on('message_end', async (event: any) => {
      const message = event.message
      if (message?.role === 'assistant' && message.usage) {
        guard.recordUsage(Number(message.usage.totalTokens ?? 0), Number(message.usage.cost?.total ?? 0))
      }
    })

    pi.registerTool({
      name: 'run_command',
      label: 'Run Command',
      description: 'Run an argv-only allowlisted local development command in this managed worktree. Shell syntax is never accepted.',
      parameters: Type.Object({
        argv: Type.Array(Type.String(), { minItems: 1, maxItems: 128, description: 'Executable followed by separate argv entries; never a shell command string.' }),
        reason: Type.String({ description: 'Why this command is needed for the confirmed task.' }),
      }),
      async execute(_id, params) {
        const argv = params.argv.map(value => String(value))
        const decision = applyRepositoryCommandProfile(argv, evaluateMathisCommand(argv, options.exactGrants), options.run.repository?.commandRules)
        if (decision.kind === 'deny') throw new Error(`Command denied: ${decision.reason}`)
        if (decision.kind === 'question') {
          const question = { argv, reason: `${decision.reason} Requested because: ${params.reason}`, proposedAllowlistAddition: decision.proposedAllowlistAddition }
          options.onQuestion(question)
          throw new CommandApprovalRequired(question)
        }
        assertNpmScriptsUnchanged(options.run, argv)
        const diskCap = options.run.resourceCaps.maxDiskBytes ?? 2 * 1024 * 1024 * 1024
        if (directoryBytes(worktree, diskCap) > diskCap) throw new AgentResourceLimitError(`Mathis exceeded the ${diskCap}-byte worktree resource cap.`)
        const result = await runArgvCommand(argv, {
          cwd: worktree,
          signal: options.signal,
          caps: options.run.resourceCaps,
          onProcess: pid => { if (pid !== null) options.onCommandStarted?.({ argv, rule: decision.rule, pid }) },
        })
        options.onCommandCompleted?.({ argv, rule: decision.rule, exitCode: result.exitCode, signal: result.signal })
        const text = [result.stdout, result.stderr].filter(Boolean).join('\n')
        return {
          content: [{ type: 'text' as const, text: `${argv.join(' ')} exited ${result.exitCode ?? result.signal ?? 'unknown'}.\n${text}`.trim() }],
          details: { argv, rule: decision.rule, exitCode: result.exitCode, signal: result.signal },
        }
      },
    })
  }
}

export interface RunMathisInput {
  run: AgentRun
  signal: AbortSignal
  exactGrants?: ReadonlySet<string>
  events?: AgentRunEvent[]
  onStarted(checkpoint: Record<string, unknown>): void
  onProgress(type: string, data: Record<string, unknown>, checkpoint?: Record<string, unknown>): void
}

export function pendingMathisAcceptanceChecks(run: AgentRun, events: AgentRunEvent[]): string[] {
  const completed = new Set(events
    .filter(event => event.type === 'command_completed' && event.data.exitCode === 0 && Array.isArray(event.data.argv))
    .map(event => JSON.stringify(event.data.argv)))
  return run.acceptanceChecks.filter(check => !completed.has(check))
}

export async function runMathis(input: RunMathisInput): Promise<string> {
  const { run } = input
  if (run.workspace.readOnly) throw new Error('Mathis requires a writable registered workspace.')
  const workspaceRoot = run.workspace.isolation === 'worktree' ? run.workspace.worktreePath : run.workspace.repoRoot
  const definition = findAgent(run.agent)
  if (!definition) throw new Error(`Agent "${run.agent}" is no longer available.`)
  const verb = definition.verbs.find(entry => entry.name === run.verb)
  if (!verb) throw new Error(`Verb "${run.verb}" is no longer available for ${definition.label}.`)
  let pendingQuestion: ProposedCommandQuestion | null = null
  let abortSession = () => {}
  const caps = run.resourceCaps
  const guard = new MathisResourceGuard(
    caps.maxSteps ?? 80,
    caps.maxSubprocesses ?? 24,
    4,
    caps.maxTokens ?? 250_000,
    caps.maxCostUsd ?? 25,
    latestMathisResourceSnapshot(input.events ?? []),
    usage => input.onProgress('resource_checkpoint', { usage }, {
      phase: 'resource-checkpoint',
      resourceUsage: usage,
      lastCompletedAction: 'resource-meter-updated',
    }),
  )
  const loader = new DefaultResourceLoader({
    cwd: workspaceRoot,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => `${buildAgentSystemPrompt(definition, verb, run.settings).replace(
      '- You are READ-ONLY. You can read and search files; you cannot edit, write, or run commands. You never ask to. Bond applies every change through its own approval flow.',
      '- You are write-capable only inside the managed worktree supplied for this run. Read before editing and keep every file operation inside it.',
    )}\n\nUse run_command with argv entries, never shell syntax. Do not access remotes or daemon/app lifecycle commands. Before finishing, run every required acceptance command exactly as declared: ${run.acceptanceChecks.join(', ') || '(none)'}.`,
    extensionFactories: [createMathisExtensionFactory({
      run,
      signal: input.signal,
      exactGrants: input.exactGrants,
      guard,
      onQuestion: question => {
        pendingQuestion = question
        queueMicrotask(abortSession)
      },
      onCommandStarted: result => input.onProgress('command_started', result, {
        phase: 'command-started',
        argv: result.argv,
        pid: result.pid,
        worktree: run.workspace.isolation === 'worktree' ? run.workspace.worktreePath : null,
        lastCompletedAction: 'command-spawned-result-unknown',
      }),
      onCommandCompleted: result => input.onProgress('command_completed', result, {
        phase: 'command-completed',
        argv: result.argv,
        exitCode: result.exitCode,
        worktree: run.workspace.isolation === 'worktree' ? run.workspace.worktreePath : null,
        lastCompletedAction: 'command-completed',
      }),
    })],
  })
  await loader.reload()
  const { model, modelRuntime } = await selectModel(run.settings.model === 'inherit' ? undefined : run.settings.model)
  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    model,
    modelRuntime,
    thinkingLevel: thinkingLevelFor(run.settings.thinking),
    tools: MATHIS_TOOLS,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ transport: 'sse' }),
  })
  abortSession = () => void session.abort()
  const abort = () => void session.abort()
  input.signal.addEventListener('abort', abort, { once: true })
  const leash = setTimeout(abort, run.settings.leash * 1000)
  try {
    input.onStarted({
      phase: 'mathis-session-started',
      worktree: workspaceRoot,
      lastCompletedAction: 'workspace-ready',
      previousCheckpoint: run.checkpoint,
    })
    const pendingChecks = pendingMathisAcceptanceChecks(run, input.events ?? [])
    const resume = run.checkpoint
      ? `\n\nRESUME CHECKPOINT:\nStart a fresh session for this same durable run in workspace ${workspaceRoot} at immutable base ${run.baseSha ?? '(unavailable)'}. Previous checkpoint: ${JSON.stringify(run.checkpoint)}. Last completed action: ${String(run.checkpoint.lastCompletedAction ?? '(unknown)')}. Pending acceptance checks: ${pendingChecks.join(', ') || '(none)'}. Exact run-scoped command grants: ${JSON.stringify([...input.exactGrants ?? []])}. Never revive a previous child PID; its outcome is unknown unless a command_completed event exists. Re-inspect git status and current files; preserve completed edits and do not repeat work blindly.`
      : ''
    await session.prompt(buildAgentUserPrompt({ brief: `${run.brief}${resume}`, paths: run.paths }))
    if (pendingQuestion) throw new CommandApprovalRequired(pendingQuestion)
    if (input.signal.aborted) throw new Error(`${definition.label}'s background task was cancelled.`)
    if (session.agent.state.errorMessage) throw new Error(`${definition.label}'s run failed: ${session.agent.state.errorMessage}`)
    const report = session.messages
      .filter((message: any) => message.role === 'assistant')
      .flatMap((message: any) => message.content ?? [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')
    if (!report.trim()) throw new Error(`${definition.label} returned an empty report.`)
    return report
  } finally {
    clearTimeout(leash)
    input.signal.removeEventListener('abort', abort)
    session.dispose()
  }
}
