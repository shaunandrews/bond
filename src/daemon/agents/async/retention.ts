import type { AgentRun } from '../../../shared/agent-runs'
import { getSetting } from '../../settings'
import {
  deleteExpiredTerminalAgentRunLogs,
  evictOldestTerminalAgentRunLogs,
  getAgentRunPublication,
  listAgentRunQuestions,
  listAgentRuns,
  updateAgentRunWorkspaceState,
} from './store'
import { workspaceManager } from './workspace'

export const DEFAULT_AGENT_WORKTREE_RETENTION_DAYS = 30
export const DEFAULT_AGENT_LOG_RETENTION_DAYS = 30
export const DEFAULT_AGENT_RAW_LOG_MAX_BYTES = 256 * 1024 * 1024
export type AgentRawLogRetention = 7 | 30 | 90 | 'forever'

function daysSetting(key: string, fallback: number): number {
  const parsed = Number(getSetting(key))
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback
}

function rawLogRetentionSetting(): AgentRawLogRetention {
  const value = getSetting('agents.retention.rawLogDays')
  if (value === 'forever') return value
  const days = Number(value)
  return days === 7 || days === 30 || days === 90 ? days : DEFAULT_AGENT_LOG_RETENTION_DAYS
}

function bytesSetting(): number {
  const bytes = Number(getSetting('agents.retention.rawLogMaxBytes'))
  return Number.isFinite(bytes) && bytes >= 1_048_576 ? Math.floor(bytes) : DEFAULT_AGENT_RAW_LOG_MAX_BYTES
}

function olderThan(run: AgentRun, cutoffMs: number): boolean {
  const value = run.completedAt ?? run.updatedAt
  return Number.isFinite(Date.parse(value)) && Date.parse(value) < cutoffMs
}

export interface AgentRetentionOptions {
  now?: number
  worktreeDays?: number
  logRetention?: AgentRawLogRetention
  maxRawLogBytes?: number
  discard?: (run: AgentRun) => Promise<void>
}

export async function runAgentRetentionSweep(options: AgentRetentionOptions = {}): Promise<{ discarded: number; rawLogsDeleted: number; rawBytesDeleted: number; retained: number }> {
  const currentTime = options.now ?? Date.now()
  const worktreeDays = options.worktreeDays ?? daysSetting('agents.retention.worktreeDays', DEFAULT_AGENT_WORKTREE_RETENTION_DAYS)
  const logRetention = options.logRetention ?? rawLogRetentionSetting()
  const maxRawLogBytes = options.maxRawLogBytes ?? bytesSetting()
  const discard = options.discard ?? (run => workspaceManager.discard(run))
  const worktreeCutoff = currentTime - worktreeDays * 86_400_000
  let discarded = 0
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

    retained += 1
  }
  const expired = logRetention === 'forever'
    ? { deleted: 0, bytes: 0 }
    : deleteExpiredTerminalAgentRunLogs(new Date(currentTime - logRetention * 86_400_000).toISOString())
  const evicted = evictOldestTerminalAgentRunLogs(maxRawLogBytes)
  return {
    discarded,
    rawLogsDeleted: expired.deleted + evicted.deleted,
    rawBytesDeleted: expired.bytes + evicted.bytes,
    retained,
  }
}
