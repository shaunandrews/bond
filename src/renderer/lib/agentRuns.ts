import type { AgentRun, AgentRunEvent } from '../../shared/agent-runs'

export const ACTIVE_AGENT_RUN_STATES = new Set<AgentRun['status']>(['queued', 'preparing-workspace', 'running', 'needs-input', 'interrupted'])

export function agentRunStatusLabel(status: AgentRun['status']): string {
  return ({
    queued: 'Queued', 'preparing-workspace': 'Preparing workspace', running: 'Working', 'needs-input': 'Needs input',
    succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Recovering',
  })[status]
}

export function agentRunElapsed(run: AgentRun, now = Date.now()): string {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = run.completedAt ? Date.parse(run.completedAt) : now
  const seconds = Math.max(0, Math.round((end - start) / 1_000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`
}

export function agentEventLabel(event?: AgentRunEvent): string {
  if (!event) return 'No events yet'
  return event.type.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

export function isRawAgentEvent(event: AgentRunEvent): boolean {
  return ['command_started', 'command_completed', 'resource_checkpoint'].includes(event.type)
}
