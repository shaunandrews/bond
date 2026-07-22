import type { AgentRun, AgentRunDetail, AgentRunEvent } from '../shared/agent-runs'
import { redactAgentText, redactAgentValue } from '../shared/agent-redaction'

export type AgentCommand =
  | { kind: 'status'; runId?: string; json: boolean }
  | { kind: 'list'; json: boolean }
  | { kind: 'logs'; runId: string | null; json: boolean }
  | { kind: 'cancel' | 'discard'; runId: string | null }
  | { kind: 'answer'; runId: string | null; questionId: string | null; approved: boolean | null; response?: string }
  | { kind: 'help' }
  | { kind: 'unknown'; command: string }

export function parseAgentArgs(args: string[]): AgentCommand {
  const command = args[0] ?? 'status'
  const json = args.includes('--json')
  const positional = args.slice(1).filter(value => !value.startsWith('--'))
  switch (command) {
    case 'status': return { kind: 'status', runId: positional[0], json }
    case 'list': return { kind: 'list', json }
    case 'logs': return { kind: 'logs', runId: positional[0] ?? null, json }
    case 'cancel': return { kind: 'cancel', runId: positional[0] ?? null }
    case 'discard': return { kind: 'discard', runId: positional[0] ?? null }
    case 'answer': {
      const verdict = positional[2]?.toLowerCase()
      const responseIndex = args.indexOf('--response')
      return {
        kind: 'answer', runId: positional[0] ?? null, questionId: positional[1] ?? null,
        approved: verdict ? ['yes', 'y', 'approve', 'approved'].includes(verdict) : null,
        response: responseIndex >= 0 ? args[responseIndex + 1] : undefined,
      }
    }
    case 'help': case '-h': case '--help': return { kind: 'help' }
    default: return { kind: 'unknown', command }
  }
}

function age(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

export function formatAgentRuns(runs: AgentRun[]): string {
  if (!runs.length) return 'No agent runs.'
  return runs.map(run => `${run.id.slice(0, 8)}  ${run.status.padEnd(19)} ${run.agentLabel.padEnd(8)} ${run.verb.padEnd(10)} ${age(run.updatedAt)}  ${redactAgentText(run.brief).replace(/\s+/g, ' ').slice(0, 70)}`).join('\n')
}

export function formatAgentDetail(detail: AgentRunDetail): string {
  const { run, publication } = detail
  const pending = detail.questions.filter(question => question.status === 'pending')
  return [
    `Run          ${run.id}`,
    `Agent        ${run.agentLabel} · ${run.verb}`,
    `Status       ${run.status}`,
    `Attempts     ${run.attemptCount} (${run.retryCount} retries, ${run.recoveryCount} recoveries)`,
    `Workspace    ${run.workspace.isolation === 'worktree' ? `${run.workspace.branch} · ${run.workspaceState.status}` : 'read-only in-place'}`,
    `Publication  ${publication ? `${publication.status}${publication.prUrl ? ` · ${publication.prUrl}` : ''}` : 'none'}`,
    `Brief        ${redactAgentText(run.brief)}`,
    ...(run.errorMessage ? [`Error        ${run.errorClass ?? 'execution'} · ${redactAgentText(run.errorMessage)}`] : []),
    ...(pending.length ? pending.map(question => `Question     ${question.id} · ${redactAgentText(question.proposedAllowlistAddition)}\n             ${redactAgentText(question.reason)}`) : []),
  ].join('\n')
}

export function formatAgentEvents(events: AgentRunEvent[]): string {
  if (!events.length) return 'No events.'
  return events.map(event => `${String(event.sequence).padStart(4)}  ${event.createdAt}  ${event.type.padEnd(28)} ${JSON.stringify(redactAgentValue(event.data))}`).join('\n')
}

export const AGENT_HELP = `bond agent — durable background agents

  bond agent status [run-id] [--json]           Active summary or one run
  bond agent list [--json]                      Recent runs
  bond agent logs <run-id> [--json]             Append-only event log
  bond agent cancel <run-id>                    Cancel active/parked run
  bond agent answer <run-id> <question-id> yes|no [--response "text"]
  bond agent discard <run-id>                   Delete retained managed worktree`
