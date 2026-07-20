/**
 * Evidence runners — deterministic checks the *tool* runs before the agent
 * session starts, injected as labeled blocks the agent reconciles against its
 * own reading. Agents never execute anything themselves.
 *
 * Two kinds:
 * - `native`: Bond code (Felix's Impeccable detector, migration inventory),
 *   reserved for bundled definitions.
 * - `shell`: a command string from a definition file. Because these bypass
 *   the per-turn approval flow — and Bond can author definition files — every
 *   distinct command needs one-time user approval, keyed by command hash,
 *   before it ever runs. Unapproved runners are skipped with an honest note.
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { BondStreamChunk } from '../../shared/stream'
import { registerApproval } from '../approvals'
import { approveRunnerHash, getApprovedRunnerHashes } from '../settings'
import { formatDetectorEvidence, runImpeccableDetect } from '../design/detector'
import { runMigrationInventory } from '../design/migrate'
import type { ResolvedContextDocs } from './context-docs'
import type { AgentEvidenceRunner } from './definition'

const MAX_OUTPUT_CHARS = 24_000
const DEFAULT_RUNNER_TIMEOUT_MS = 60_000

export function runnerHash(command: string): string {
  return createHash('sha256').update(command.trim()).digest('hex').slice(0, 16)
}

export function isRunnerApproved(command: string, approved: string[] = getApprovedRunnerHashes()): boolean {
  return approved.includes(runnerHash(command))
}

export interface RunnerContext {
  paths: string[]
  docs: ResolvedContextDocs
  cwd?: string
  timeoutMs: number
  signal?: AbortSignal
}

export type NativeRunner = (context: RunnerContext) => Promise<string>

/** Native runners are referenced from bundled definitions as `builtin:<id>`. */
export const NATIVE_RUNNERS: Record<string, NativeRunner> = {
  'impeccable-detect': async ({ paths, docs, timeoutMs }) => {
    if (!paths.length) return '<evidence source="impeccable-detector" status="skipped">No paths in scope.</evidence>'
    return formatDetectorEvidence(await runImpeccableDetect(paths, { cwd: docs.root, timeoutMs }))
  },
  'migration-inventory': async ({ paths, docs }) => {
    if (!paths.length) return '<evidence source="migration-inventory" status="skipped">No paths in scope.</evidence>'
    return runMigrationInventory(paths, { designMdText: docs.docs['DESIGN.md']?.text }).evidence
  },
}

export interface ShellResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type ShellExecFn = (command: string, options: { cwd?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<ShellResult>

const spawnShell: ShellExecFn = (command, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const kill = () => child.kill('SIGKILL')
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutMs)
    options.signal?.addEventListener('abort', kill, { once: true })
    child.stdout.on('data', chunk => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += String(chunk)
    })
    child.on('error', error => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', kill)
      rejectPromise(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', kill)
      resolvePromise({ code, stdout, stderr, timedOut })
    })
  })

function clamp(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]` : text
}

export function formatShellEvidence(runner: AgentEvidenceRunner, result: ShellResult): string {
  const status = result.timedOut ? 'timeout' : result.code === 0 ? 'pass' : 'fail'
  const body = clamp([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n') || '(no output)')
  return `<evidence source="${runner.name}" command="${runner.command}" status="${status}" exit="${result.code ?? 'killed'}">\n${body}\n</evidence>`
}

export function formatSkippedEvidence(runner: AgentEvidenceRunner, reason: string): string {
  return `<evidence source="${runner.name}" command="${runner.command}" status="skipped">\n${reason}\n</evidence>`
}

export interface CollectEvidenceOptions extends RunnerContext {
  runners: AgentEvidenceRunner[]
  verb: string
  /** Approval transport — omitted when no turn owns this consult (tests, CLI). */
  turnId?: string
  onChunk?: (chunk: BondStreamChunk) => void
  exec?: ShellExecFn
  nativeRunners?: Record<string, NativeRunner>
}

/**
 * Runs the runners that apply to this verb and returns their evidence blocks.
 * A runner failure is evidence, not a consult failure — every path returns a
 * block the agent can read and report honestly.
 */
export async function collectEvidence(options: CollectEvidenceOptions): Promise<string[]> {
  const exec = options.exec ?? spawnShell
  const natives = options.nativeRunners ?? NATIVE_RUNNERS
  const applicable = options.runners.filter(runner => !runner.verbs.length || runner.verbs.includes(options.verb))
  const blocks: string[] = []

  for (const runner of applicable) {
    if (options.signal?.aborted) break

    if (runner.kind === 'native') {
      const native = natives[runner.command.slice('builtin:'.length)]
      if (!native) {
        blocks.push(formatSkippedEvidence(runner, 'Unknown built-in runner.'))
        continue
      }
      try {
        blocks.push(await native(options))
      } catch (error) {
        blocks.push(formatSkippedEvidence(runner, `Runner failed: ${error instanceof Error ? error.message : String(error)}`))
      }
      continue
    }

    if (!isRunnerApproved(runner.command)) {
      const approved = await requestRunnerApproval(runner, options)
      if (!approved) {
        blocks.push(formatSkippedEvidence(runner, 'Not approved by the user, so it was not run. Report that this check did not run.'))
        continue
      }
      approveRunnerHash(runnerHash(runner.command))
    }

    try {
      const result = await exec(runner.command, { cwd: options.cwd ?? options.docs.root, timeoutMs: Math.min(options.timeoutMs, DEFAULT_RUNNER_TIMEOUT_MS), signal: options.signal })
      blocks.push(formatShellEvidence(runner, result))
    } catch (error) {
      blocks.push(formatSkippedEvidence(runner, `Command could not run: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  return blocks
}

/** Surfaces the command as a normal Bond approval prompt; no turn means no approval. */
async function requestRunnerApproval(runner: AgentEvidenceRunner, options: CollectEvidenceOptions): Promise<boolean> {
  if (!options.turnId || !options.onChunk) return false
  const requestId = randomUUID()
  options.onChunk({
    kind: 'tool_approval',
    requestId,
    toolName: 'agent_evidence',
    input: { command: runner.command, runner: runner.name },
    title: `Run "${runner.name}" for this consult?`,
    description: `${runner.command}\n\nApproving remembers this exact command for future consults.`,
  })
  const decision = await registerApproval(requestId, options.turnId)
  return decision.approved
}
