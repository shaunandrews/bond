import type { AgentRun, AgentRunQuestion } from '../../../shared/agent-runs'
import { upsertMessages } from '../../transcript'
import { queueWhenNoActiveTurns } from '../../turns'
import { getAgentRun, getAgentRunPublication, listPendingAgentRunQuestions, markAgentRunCompletionInserted, runsAwaitingCompletion } from './store'

export interface AgentRunCompletionOptions {
  deferUntilTurnsIdle?: (task: () => void) => void
  onChanged?: (run: AgentRun) => void
  logger?: Pick<Console, 'warn'>
}

export interface AgentRunCompletionCoordinator {
  enqueue(run: AgentRun): void
  enqueueQuestion(run: AgentRun, question: AgentRunQuestion): void
  refresh(run: AgentRun): void
  reconcile(): void
}

function completionText(run: AgentRun): string {
  if (run.status === 'succeeded') {
    const summary = run.result?.replace(/\s+/g, ' ').trim().slice(0, 240)
    const publication = getAgentRunPublication(run.id)
    const handoff = publication?.status === 'published'
      ? ` Draft PR #${publication.prNumber}: ${publication.prUrl}.${publication.qReviewStatus === 'posted' ? ` Q review: ${publication.qCommentUrl}.` : publication.qReviewRequired ? ' Q review could not be posted.' : ' Q review was not required.'}`
      : publication?.status === 'failed'
        ? ` GitHub handoff needs attention: ${publication.errorMessage}`
        : ''
    return `${run.agentLabel} finished the background ${run.verb} task.${summary ? ` ${summary}` : ''}${handoff}`
  }
  if (run.status === 'cancelled') return `${run.agentLabel}'s background ${run.verb} task was cancelled.`
  return `${run.agentLabel}'s background ${run.verb} task failed${run.errorMessage ? `: ${run.errorMessage}` : '.'}`
}

export function createAgentRunCompletionCoordinator(options: AgentRunCompletionOptions = {}): AgentRunCompletionCoordinator {
  const defer = options.deferUntilTurnsIdle ?? queueWhenNoActiveTurns
  const logger = options.logger ?? console
  const queued = new Set<string>()
  const queuedQuestions = new Set<string>()

  const enqueue = (candidate: AgentRun): void => {
    if (!['succeeded', 'failed', 'cancelled'].includes(candidate.status)) return
    if (candidate.completionInsertedAt || queued.has(candidate.id)) return
    queued.add(candidate.id)
    defer(() => {
      try {
        const run = getAgentRun(candidate.id)
        if (!run || run.completionInsertedAt || !['succeeded', 'failed', 'cancelled'].includes(run.status)) return
        const messageId = `agent-run:${run.id}:completion`
        const publication = getAgentRunPublication(run.id)
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
            prNumber: publication?.prNumber ?? null,
            prUrl: publication?.prUrl ?? null,
            qReviewStatus: publication?.qReviewStatus ?? null,
            qCommentUrl: publication?.qCommentUrl ?? null,
            publishError: publication?.errorMessage ?? null,
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

  const enqueueQuestion = (run: AgentRun, question: AgentRunQuestion): void => {
    if (question.status !== 'pending' || queuedQuestions.has(question.id)) return
    queuedQuestions.add(question.id)
    defer(() => {
      try {
        const current = getAgentRun(run.id)
        if (!current || current.status !== 'needs-input') return
        upsertMessages([{
          id: `agent-run:${run.id}:question:${question.id}`,
          role: 'meta',
          kind: 'agent-run',
          text: `${run.agentLabel} needs approval before continuing. ${question.proposedAllowlistAddition} Reason: ${question.reason}`,
          data: {
            runId: run.id,
            agent: run.agent,
            agentLabel: run.agentLabel,
            verb: run.verb,
            status: 'needs-input',
            questionId: question.id,
            argv: question.argv,
            reason: question.reason,
            proposedAllowlistAddition: question.proposedAllowlistAddition,
          },
        }])
      } catch (error) {
        logger.warn('[agents/completion] question insertion failed:', error)
      } finally {
        queuedQuestions.delete(question.id)
      }
    })
  }

  return {
    enqueue,
    refresh(run): void {
      if (!['succeeded', 'failed', 'cancelled'].includes(run.status)) return
      defer(() => {
        const current = getAgentRun(run.id)
        if (!current) return
        const publication = getAgentRunPublication(run.id)
        upsertMessages([{
          id: `agent-run:${current.id}:completion`, role: 'meta', kind: 'agent-run', text: completionText(current),
          data: {
            runId: current.id, agent: current.agent, agentLabel: current.agentLabel, verb: current.verb, status: current.status,
            errorClass: current.errorClass, prNumber: publication?.prNumber ?? null, prUrl: publication?.prUrl ?? null,
            qReviewStatus: publication?.qReviewStatus ?? null, qCommentUrl: publication?.qCommentUrl ?? null,
            publishError: publication?.errorMessage ?? null,
          },
        }])
      })
    },
    enqueueQuestion,
    reconcile(): void {
      for (const run of runsAwaitingCompletion()) enqueue(run)
      for (const question of listPendingAgentRunQuestions()) {
        const run = getAgentRun(question.runId)
        if (run) enqueueQuestion(run, question)
      }
    },
  }
}
