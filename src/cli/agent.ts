#!/usr/bin/env node
import { call, connect, type WebSocket } from './connect'
import type { AgentRun, AgentRunDetail } from '../shared/agent-runs'
import { redactAgentValue } from '../shared/agent-redaction'
import { AGENT_HELP, formatAgentDetail, formatAgentEvents, formatAgentRuns, parseAgentArgs } from './agent-helpers'

async function main() {
  const command = parseAgentArgs(process.argv.slice(2))
  if (command.kind === 'help') return console.log(AGENT_HELP)
  if (command.kind === 'unknown') throw new Error(`Unknown agent command: ${command.command}\n\n${AGENT_HELP}`)
  let ws: WebSocket
  try { ws = await connect() } catch { throw new Error('Cannot connect to Bond daemon. Is it running?') }
  try {
    if (command.kind === 'list' || (command.kind === 'status' && !command.runId)) {
      const result = await call(ws, 'agentruns.list') as { runs: AgentRun[] }
      const runs = command.kind === 'status' ? result.runs.filter(run => !['succeeded', 'failed', 'cancelled'].includes(run.status)) : result.runs
      console.log(command.json ? JSON.stringify(redactAgentValue(runs), null, 2) : formatAgentRuns(runs))
      return
    }
    if (command.kind === 'status' || command.kind === 'logs') {
      const runId = command.runId
      if (!runId) throw new Error(`run-id is required\n\n${AGENT_HELP}`)
      const detail = await call(ws, 'agentruns.get', { runId }) as AgentRunDetail | null
      if (!detail) throw new Error(`Unknown agent run "${runId}".`)
      console.log(command.json ? JSON.stringify(redactAgentValue(command.kind === 'logs' ? detail.events : detail), null, 2) : command.kind === 'logs' ? formatAgentEvents(detail.events) : formatAgentDetail(detail))
      return
    }
    if (command.kind === 'cancel' || command.kind === 'discard') {
      if (!command.runId) throw new Error(`run-id is required\n\n${AGENT_HELP}`)
      const method = command.kind === 'cancel' ? 'agentruns.cancel' : 'agentruns.discardWorkspace'
      const run = await call(ws, method, { runId: command.runId }) as AgentRun | null
      console.log(run ? `${run.id}  ${command.kind === 'cancel' ? run.status : run.workspaceState.status}` : `Unknown agent run "${command.runId}".`)
      return
    }
    if (command.kind !== 'answer') throw new Error(`Unsupported agent command.\n\n${AGENT_HELP}`)
    if (!command.runId || !command.questionId || command.approved === null) throw new Error(`run-id, question-id, and yes|no are required\n\n${AGENT_HELP}`)
    const result = await call(ws, 'agentruns.answerQuestion', {
      runId: command.runId, questionId: command.questionId, approved: command.approved, response: command.response,
    }) as { run: AgentRun }
    console.log(`${result.run.id}  ${result.run.status}`)
  } finally { ws.close() }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
