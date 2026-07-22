import type { AgentRun, AgentRunQuestion } from '../../../shared/agent-runs'
import { upsertMessages } from '../../transcript'
import { queueWhenNoActiveTurns } from '../../turns'
import { getAgentRun, getAgentRunPublication, listAgentRuns, listPendingAgentRunQuestions, markAgentRunCompletionInserted, runsAwaitingCompletion } from './store'

export interface AgentRunCompletionOptions {
  deferUntilTurnsIdle?: (task: () => void) => void
  onChanged?: (run: AgentRun) => void
  logger?: Pick<Console, 'warn'>
}

export interface AgentRunCompletionCoordinator {
  enqueue(run: AgentRun): void
  track(run: AgentRun): void
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

function cardId(run: AgentRun): string { return run.completionMessageId ?? `agent-run:${run.id}:activity` }

export function createAgentRunCompletionCoordinator(options: AgentRunCompletionOptions = {}): AgentRunCompletionCoordinator {
  const defer = options.deferUntilTurnsIdle ?? queueWhenNoActiveTurns
  const logger = options.logger ?? console
  const queued = new Set<string>()
  const queuedQuestions = new Set<string>()

  const upsertCard = (run: AgentRun, question?: AgentRunQuestion): void => {
    const publication = getAgentRunPublication(run.id)
    upsertMessages([{
      id: cardId(run),
      role: 'meta',
      kind: 'agent-run',
      text: ['succeeded', 'failed', 'cancelled'].includes(run.status)
        ? completionText(run)
        : question
          ? `${run.agentLabel} needs approval before continuing. ${question.proposedAllowlistAddition} Reason: ${question.reason}`
          : `${run.agentLabel} is working on the background ${run.verb} task.`,
      data: {
        runId: run.id, agent: run.agent, agentLabel: run.agentLabel, verb: run.verb, status: run.status,
        errorClass: run.errorClass, questionId: question?.id ?? null,
        prNumber: publication?.prNumber ?? null, prUrl: publication?.prUrl ?? null,
        qReviewStatus: publication?.qReviewStatus ?? null, qCommentUrl: publication?.qCommentUrl ?? null,
        publishError: publication?.errorMessage ?? null,
      },
    }])
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      const updated = markAgentRunCompletionInserted(run.id, cardId(run))
      options.onChanged?.(updated)
    } else options.onChanged?.(run)
  }

  const track = (candidate: AgentRun): void => {
    if (queued.has(candidate.id)) return
    queued.add(candidate.id)
    defer(() => {
      try {
        const run = getAgentRun(candidate.id)
        if (!run) return
        const question = run.status === 'needs-input'
          ? listPendingAgentRunQuestions().find(entry => entry.runId === run.id)
          : undefined
        upsertCard(run, question)
      } catch (error) {
        logger.warn('[agents/completion] card update failed:', error)
      } finally {
        queued.delete(candidate.id)
      }
    })
  }

  const enqueue = (candidate: AgentRun): void => {
    if (!['succeeded', 'failed', 'cancelled'].includes(candidate.status)) return
    track(candidate)
  }

  const enqueueQuestion = (run: AgentRun, question: AgentRunQuestion): void => {
    if (question.status !== 'pending' || queuedQuestions.has(question.id)) return
    queuedQuestions.add(question.id)
    defer(() => {
      try {
        const current = getAgentRun(run.id)
        if (!current || current.status !== 'needs-input') return
        upsertCard(current, question)
      } catch (error) {
        logger.warn('[agents/completion] question insertion failed:', error)
      } finally {
        queuedQuestions.delete(question.id)
      }
    })
  }

  return {
    enqueue,
    track,
    refresh(run): void {
      track(run)
    },
    enqueueQuestion,
    reconcile(): void {
      for (const run of runsAwaitingCompletion()) enqueue(run)
      for (const run of listAgentRuns({ statuses: ['queued', 'preparing-workspace', 'running', 'needs-input', 'interrupted'], limit: 500 })) track(run)
      for (const question of listPendingAgentRunQuestions()) {
        const run = getAgentRun(question.runId)
        if (run) enqueueQuestion(run, question)
      }
    },
  }
}
