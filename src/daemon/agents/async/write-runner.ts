import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { AgentRun } from '../../../shared/agent-runs'
import { selectModel } from '../../pi/model'
import { buildAgentSystemPrompt, buildAgentUserPrompt } from '../prompt'
import { findAgent } from '../registry'
import { thinkingLevelFor } from '../run-agent'
import { evaluateMathisCommand } from './command-policy'
import { runArgvCommand } from './command-runner'
import { assertContainedPath } from './workspace'

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

export class MathisResourceGuard {
  private steps = 0
  private commands = 0
  private readonly fingerprints = new Map<string, number>()

  constructor(private readonly maxSteps = 80, private readonly maxCommands = 24, private readonly maxRepeats = 4) {}

  recordTool(name: string, input: unknown): void {
    this.steps += 1
    if (this.steps > this.maxSteps) throw new Error(`Mathis exceeded the ${this.maxSteps}-step resource cap.`)
    if (name === 'run_command' && ++this.commands > this.maxCommands) throw new Error(`Mathis exceeded the ${this.maxCommands}-command resource cap.`)
    const fingerprint = `${name}:${JSON.stringify(input)}`
    const count = (this.fingerprints.get(fingerprint) ?? 0) + 1
    this.fingerprints.set(fingerprint, count)
    if (count > this.maxRepeats) throw new Error(`Mathis repeated the same ${name} action too many times.`)
  }
}

function directoryBytes(root: string, cap: number): number {
  let total = 0
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
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

export interface MathisExtensionOptions {
  run: AgentRun
  signal: AbortSignal
  exactGrants?: ReadonlySet<string>
  guard?: MathisResourceGuard
  onQuestion(question: ProposedCommandQuestion): void
}

export function createMathisExtensionFactory(options: MathisExtensionOptions) {
  if (options.run.workspace.isolation !== 'worktree') throw new Error('Mathis requires a managed worktree.')
  const worktree = options.run.workspace.worktreePath
  const guard = options.guard ?? new MathisResourceGuard()
  return (pi: ExtensionAPI) => {
    pi.on('tool_call', async (event: any) => {
      const toolName = String(event.toolName)
      const input = (event.input ?? {}) as Record<string, unknown>
      guard.recordTool(toolName, input)
      if (!FILE_TOOLS.has(toolName)) return
      const target = input.path ?? input.file_path
      if (typeof target === 'string') {
        try { assertContainedPath(worktree, target) }
        catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) } }
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
        const decision = evaluateMathisCommand(argv, options.exactGrants)
        if (decision.kind === 'deny') throw new Error(`Command denied: ${decision.reason}`)
        if (decision.kind === 'question') {
          const question = { argv, reason: `${decision.reason} Requested because: ${params.reason}`, proposedAllowlistAddition: decision.proposedAllowlistAddition }
          options.onQuestion(question)
          throw new CommandApprovalRequired(question)
        }
        const diskCap = 512 * 1024 * 1024
        if (directoryBytes(worktree, diskCap) > diskCap) throw new Error('Mathis exceeded the 512 MiB worktree resource cap.')
        const result = await runArgvCommand(argv, { cwd: worktree, signal: options.signal, caps: options.run.resourceCaps })
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
  onStarted(checkpoint: Record<string, unknown>): void
}

export async function runMathis(input: RunMathisInput): Promise<string> {
  const { run } = input
  if (run.workspace.isolation !== 'worktree') throw new Error('Mathis requires a managed worktree.')
  const definition = findAgent(run.agent)
  if (!definition) throw new Error(`Agent "${run.agent}" is no longer available.`)
  const verb = definition.verbs.find(entry => entry.name === run.verb)
  if (!verb) throw new Error(`Verb "${run.verb}" is no longer available for ${definition.label}.`)
  let pendingQuestion: ProposedCommandQuestion | null = null
  let abortSession = () => {}
  const loader = new DefaultResourceLoader({
    cwd: run.workspace.worktreePath,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => `${buildAgentSystemPrompt(definition, verb, run.settings).replace(
      '- You are READ-ONLY. You can read and search files; you cannot edit, write, or run commands. You never ask to. Bond applies every change through its own approval flow.',
      '- You are write-capable only inside the managed worktree supplied for this run. Read before editing and keep every file operation inside it.',
    )}\n\nUse run_command with argv entries, never shell syntax. Do not access remotes or daemon/app lifecycle commands.`,
    extensionFactories: [createMathisExtensionFactory({
      run,
      signal: input.signal,
      exactGrants: input.exactGrants,
      onQuestion: question => {
        pendingQuestion = question
        queueMicrotask(abortSession)
      },
    })],
  })
  await loader.reload()
  const { model, modelRuntime } = await selectModel(run.settings.model === 'inherit' ? undefined : run.settings.model)
  const { session } = await createAgentSession({
    cwd: run.workspace.worktreePath,
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
    input.onStarted({ phase: 'mathis-session-started', worktree: run.workspace.worktreePath, lastCompletedAction: 'workspace-ready' })
    await session.prompt(buildAgentUserPrompt({ brief: run.brief, paths: run.paths }))
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
