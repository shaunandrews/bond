import { formatSkippedEvidence, collectEvidence } from '../evidence'
import { resolveContextDocs } from '../context-docs'
import { findAgent } from '../registry'
import { runAgentConsult } from '../run-agent'
import type { AgentRun, AgentRunEvent } from '../../../shared/agent-runs'
import { runMathis } from './write-runner'

export interface AsyncAgentExecutionContext {
  signal: AbortSignal
  events: AgentRunEvent[]
  exactCommandGrants: ReadonlySet<string>
  onStarted(checkpoint: Record<string, unknown>): void
  onProgress(type: string, data: Record<string, unknown>, checkpoint?: Record<string, unknown>): void
}

export type AsyncAgentExecutor = (run: AgentRun, context: AsyncAgentExecutionContext) => Promise<string>

export const executeAgentRun: AsyncAgentExecutor = (run, context) => run.workspace.isolation === 'worktree'
  ? runMathis({
      run,
      signal: context.signal,
      exactGrants: context.exactCommandGrants,
      onStarted: context.onStarted,
      onProgress: context.onProgress,
    })
  : executeReadOnlyAgentRun(run, context)

function recoveryEnvelope(run: AgentRun, events: AgentRunEvent[]): string {
  const isRecovery = run.recoveryCount > 0 || run.status === 'interrupted' || events.some(event => event.type === 'recovery_preparing')
  if (!isRecovery) return ''
  const summary = events.slice(-8).map(event => `${event.sequence}. ${event.type} (${event.toState ?? event.fromState ?? 'event'})`).join('\n')
  return [
    '<async-recovery>',
    'This read-only task is resuming after its previous process was interrupted.',
    `Durable checkpoint: ${JSON.stringify(run.checkpoint ?? {})}`,
    `Recent events:\n${summary || '(none)'}`,
    'Re-read the requested sources and produce the final report; do not assume an interrupted action completed.',
    '</async-recovery>',
  ].join('\n')
}

/**
 * Phase 0 executor: the existing isolated read-only Pi runner, with durable
 * inputs. Shell evidence is intentionally skipped here even when it has a
 * synchronous-consult approval; process execution belongs to the later
 * policy/sandbox phase. Built-in deterministic read-only evidence is reused.
 */
export const executeReadOnlyAgentRun: AsyncAgentExecutor = async (run, context) => {
  const definition = findAgent(run.agent)
  if (!definition) throw new Error(`Agent "${run.agent}" is no longer available.`)
  const verb = definition.verbs.find(entry => entry.name === run.verb)
  if (!verb) throw new Error(`Verb "${run.verb}" is no longer available for ${definition.label}.`)

  const docs = run.paths.length ? resolveContextDocs(run.paths, definition.contextDocs) : { docs: {} }
  const applicable = definition.evidence.filter(runner => !runner.verbs.length || runner.verbs.includes(verb.name))
  const native = applicable.filter(runner => runner.kind === 'native')
  const shell = applicable.filter(runner => runner.kind === 'shell')
  const evidence = native.length && run.paths.length
    ? await collectEvidence({
      runners: native,
      verb: verb.name,
      paths: run.paths,
      docs,
      cwd: docs.root,
      timeoutMs: run.settings.leash * 1000,
      signal: context.signal,
    })
    : []
  evidence.push(...shell.map(runner => formatSkippedEvidence(
    runner,
    'Background shell evidence is disabled in Phase 0. Report that this check did not run.',
  )))

  if (context.signal.aborted) throw new Error(`${definition.label}'s background task was cancelled.`)
  const recovery = recoveryEnvelope(run, context.events)
  return runAgentConsult({
    definition,
    verb,
    settings: run.settings,
    brief: [run.brief, recovery].filter(Boolean).join('\n\n'),
    paths: run.paths,
    docs,
    evidence,
    signal: context.signal,
    onSessionStarted: () => context.onStarted({
      phase: 'agent-session-started',
      evidencePrepared: evidence.length,
      lastCompletedAction: 'context-and-read-only-evidence-prepared',
    }),
  })
}
