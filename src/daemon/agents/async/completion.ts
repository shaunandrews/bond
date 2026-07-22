import type { AgentRun } from '../../../shared/agent-runs'
import { upsertMessages } from '../../transcript'
import { queueWhenNoActiveTurns } from '../../turns'
import { getAgentRun, markAgentRunCompletionInserted, runsAwaitingCompletion } from './store'

export interface AgentRunCompletionOptions {
  deferUntilTurnsIdle?: (task: () => void) => void
  onChanged?: (run: AgentRun) => void
  logger?: Pick<Console, 'warn'>
}

export interface AgentRunCompletionCoordinator {
  enqueue(run: AgentRun): void
  reconcile(): void
}

function completionText(run: AgentRun): string {
  if (run.status === 'succeeded') {
    const summary = run.result?.replace(/\s+/g, ' ').trim().slice(0, 240)
    return `${run.agentLabel} finished the background ${run.verb} task.${summary ? ` ${summary}` : ''}`
  }
  if (run.status === 'cancelled') return `${run.agentLabel}'s background ${run.verb} task was cancelled.`
  return `${run.agentLabel}'s background ${run.verb} task failed${run.errorMessage ? `: ${run.errorMessage}` : '.'}`
}

export function createAgentRunCompletionCoordinator(options: AgentRunCompletionOptions = {}): AgentRunCompletionCoordinator {
  const defer = options.deferUntilTurnsIdle ?? queueWhenNoActiveTurns
  const logger = options.logger ?? console
  const queued = new Set<string>()

  const enqueue = (candidate: AgentRun): void => {
    if (!['succeeded', 'failed', 'cancelled'].includes(candidate.status)) return
    if (candidate.completionInsertedAt || queued.has(candidate.id)) return
    queued.add(candidate.id)
    defer(() => {
      try {
        const run = getAgentRun(candidate.id)
        if (!run || run.completionInsertedAt || !['succeeded', 'failed', 'cancelled'].includes(run.status)) return
        const messageId = `agent-run:${run.id}:completion`
        upsertMessages([{
          id: messageId,
          role: 'meta',
          kind: 'agent-run',
          text: completionText(run),
          data: {
            runId: run.id,
            agent: run.agent,
            agentLabel: run.agentLabel,
            verb: run.verb,
            status: run.status,
            errorClass: run.errorClass,
          },
        }])
        const updated = markAgentRunCompletionInserted(run.id, messageId)
        options.onChanged?.(updated)
      } catch (error) {
        logger.warn('[agents/completion] insertion failed:', error)
      } finally {
        queued.delete(candidate.id)
      }
    })
  }

  return {
    enqueue,
    reconcile(): void {
      for (const run of runsAwaitingCompletion()) enqueue(run)
    },
  }
}
