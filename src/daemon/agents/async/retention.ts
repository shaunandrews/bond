import type { AgentRun } from '../../../shared/agent-runs'
import { getSetting } from '../../settings'
import {
  deleteTerminalAgentRun,
  getAgentRun,
  getAgentRunPublication,
  listAgentRunQuestions,
  listAgentRuns,
  updateAgentRunWorkspaceState,
} from './store'
import { workspaceManager } from './workspace'

export const DEFAULT_AGENT_WORKTREE_RETENTION_DAYS = 30
export const DEFAULT_AGENT_LOG_RETENTION_DAYS = 180

function daysSetting(key: string, fallback: number): number {
  const parsed = Number(getSetting(key))
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback
}

function olderThan(run: AgentRun, cutoffMs: number): boolean {
  const value = run.completedAt ?? run.updatedAt
  return Number.isFinite(Date.parse(value)) && Date.parse(value) < cutoffMs
}

export interface AgentRetentionOptions {
  now?: number
  worktreeDays?: number
  logDays?: number
  discard?: (run: AgentRun) => Promise<void>
}

export async function runAgentRetentionSweep(options: AgentRetentionOptions = {}): Promise<{ discarded: number; deleted: number; retained: number }> {
  const currentTime = options.now ?? Date.now()
  const worktreeDays = options.worktreeDays ?? daysSetting('agents.retention.worktreeDays', DEFAULT_AGENT_WORKTREE_RETENTION_DAYS)
  const logDays = options.logDays ?? daysSetting('agents.retention.logDays', DEFAULT_AGENT_LOG_RETENTION_DAYS)
  const discard = options.discard ?? (run => workspaceManager.discard(run))
  const worktreeCutoff = currentTime - worktreeDays * 86_400_000
  const logCutoff = currentTime - logDays * 86_400_000
  let discarded = 0
  let deleted = 0
  let retained = 0

  for (const snapshot of listAgentRuns({ statuses: ['succeeded', 'failed', 'cancelled'], limit: 500 })) {
    let run = snapshot
    const questions = listAgentRunQuestions(run.id)
    const publication = getAgentRunPublication(run.id)
    const unresolved = questions.some(question => question.status === 'pending')
    const safelyPublished = publication?.status === 'published'

    if (!unresolved && safelyPublished && run.workspace.isolation === 'worktree' && run.workspaceState.status === 'retained' && olderThan(run, worktreeCutoff)) {
      await discard(run)
      const now = new Date(currentTime).toISOString()
      run = updateAgentRunWorkspaceState(run.id, { ...run.workspaceState, status: 'discarded', discardedAt: now }, 'retention_workspace_discarded', {}, now)
      discarded += 1
    }

    const workspaceSafe = run.workspace.isolation === 'in-place' || run.workspaceState.status === 'discarded'
    const publicationSafe = !publication ? run.workspace.isolation === 'in-place' : safelyPublished
    if (!unresolved && workspaceSafe && publicationSafe && olderThan(run, logCutoff)) {
      if (deleteTerminalAgentRun(run.id)) deleted += 1
    } else if (getAgentRun(run.id)) {
      retained += 1
    }
  }
  return { discarded, deleted, retained }
}
