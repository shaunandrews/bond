/**
 * The consult_agent Pi tool — Bond's doorway to the specialist roster.
 *
 * The tool does the deterministic prep (context-doc resolution, evidence
 * runners) and hands it to an isolated read-only agent session. Because every
 * agent is read-only, this tool is available in every edit mode and never
 * parks a tool approval of its own — the one exception being first-time
 * approval of a shell evidence runner, which rides the normal approval flow.
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { BondStreamChunk } from '../../shared/stream'
import { collectEvidence } from './evidence'
import { resolveContextDocs } from './context-docs'
import { effectiveAgentSettings, loadAgentRoster } from './registry'
import { runAgentConsult } from './run-agent'
import { checkAgentRunFromTool, dispatchAgentRunFromTool } from './async/api'

export const AGENT_TOOL_NAMES = ['consult_agent', 'dispatch_agent', 'check_agent']

export interface AgentToolOptions {
  /** Parent turn's capability tier, inherited when the agent's model is 'inherit'. */
  model?: string
  /** Approval transport for first-time shell evidence runners. */
  turnId?: string
  onChunk?: (chunk: BondStreamChunk) => void
  abortSignal?: AbortSignal
  /** Injection points for tests. */
  loadRoster?: typeof loadAgentRoster
  runConsult?: typeof runAgentConsult
  gatherEvidence?: typeof collectEvidence
  resolveDocs?: typeof resolveContextDocs
  dispatchRun?: typeof dispatchAgentRunFromTool
  checkRun?: typeof checkAgentRunFromTool
}

export function expandPath(path: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
  return resolve(homedir(), expanded)
}

export function registerAgentTools(pi: ExtensionAPI, options: AgentToolOptions = {}): void {
  const loadRoster = options.loadRoster ?? loadAgentRoster
  const runConsult = options.runConsult ?? runAgentConsult
  const gatherEvidence = options.gatherEvidence ?? collectEvidence
  const resolveDocs = options.resolveDocs ?? resolveContextDocs
  const dispatchRun = options.dispatchRun ?? dispatchAgentRunFromTool
  const checkRun = options.checkRun ?? checkAgentRunFromTool

  pi.registerTool({
    name: 'consult_agent',
    label: 'Consult Agent',
    description:
      'Consult one of Bond\'s specialist agents for focused work. Each agent has named verbs; pass the agent name, the verb, a specific brief, and the file/directory paths in scope. ' +
      'Agents are read-only: they read code, run their own deterministic checks, and return a cited report — you apply any changes yourself. ' +
      'Relay their QUESTIONS and ESCALATIONS to the user before acting on them. The available agents and their verbs are listed in your system prompt.',
    parameters: Type.Object({
      agent: Type.String({ description: 'Agent name, e.g. "felix" or "q"' }),
      verb: Type.String({ description: 'One of that agent\'s verbs' }),
      brief: Type.String({ description: 'What you want their take on — specific, including the user\'s goal' }),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'Files/directories in scope (absolute or ~-relative)' })),
    }),
    async execute(_toolCallId, params, signal) {
      const { agents } = loadRoster()
      const definition = agents.find(agent => agent.name === params.agent.trim().toLowerCase())
      if (!definition) {
        throw new Error(`Unknown agent "${params.agent}". Available: ${agents.map(agent => agent.name).join(', ') || 'none'}.`)
      }
      const verb = definition.verbs.find(entry => entry.name === params.verb.trim().toLowerCase())
      if (!verb) {
        throw new Error(`"${params.verb}" is not a verb of ${definition.label}. Verbs: ${definition.verbs.map(entry => entry.name).join(', ')}.`)
      }

      const settings = effectiveAgentSettings(definition)
      if (settings.workspace === 'write') {
        throw new Error(`${definition.label} is write-capable and must run durably through dispatch_agent after the user confirms the brief.`)
      }
      const paths = (params.paths ?? []).map(expandPath)
      const docs = paths.length ? resolveDocs(paths, definition.contextDocs) : { docs: {} }

      const evidence = definition.evidence.length && paths.length
        ? await gatherEvidence({
          runners: definition.evidence,
          verb: verb.name,
          paths,
          docs,
          cwd: docs.root,
          timeoutMs: settings.leash * 1000,
          signal,
          turnId: options.turnId,
          onChunk: options.onChunk,
        })
        : []

      const report = await runConsult({
        definition,
        verb,
        settings,
        brief: params.brief,
        paths,
        docs,
        evidence,
        parentModel: options.model,
        signal,
      })

      return {
        content: [{ type: 'text' as const, text: report }],
        details: {
          agent: definition.name,
          verb: verb.name,
          paths,
          contextDocs: Object.keys(docs.docs ?? {}),
          evidenceRun: evidence.length,
        },
      }
    },
  })

  pi.registerTool({
    name: 'dispatch_agent',
    label: 'Dispatch Agent',
    description:
      'Queue a durable read-only specialist task and return immediately. Use only after the user confirms the exact brief. ' +
      'Supply a stable idempotency key and reuse it for retries so a reconnect cannot create duplicate work.',
    parameters: Type.Object({
      agent: Type.String({ description: 'Agent name, e.g. "felix" or "q"' }),
      verb: Type.String({ description: 'One of that agent\'s verbs' }),
      brief: Type.String({ description: 'The immutable user-confirmed task brief' }),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'Read-only files/directories in scope' })),
      idempotencyKey: Type.String({ description: 'Stable unique key for this confirmed task; reuse on retries' }),
    }),
    async execute(_toolCallId, params) {
      const dispatched = await dispatchRun({
        agent: params.agent,
        verb: params.verb,
        brief: params.brief,
        paths: params.paths,
        idempotencyKey: params.idempotencyKey,
        parentModel: options.model,
      })
      return {
        content: [{
          type: 'text' as const,
          text: dispatched.created
            ? `Queued ${dispatched.run.agentLabel} in the background. Run id: ${dispatched.run.id}.`
            : `That task was already dispatched. Existing run id: ${dispatched.run.id}.`,
        }],
        details: { run: dispatched.run, created: dispatched.created },
      }
    },
  })

  pi.registerTool({
    name: 'check_agent',
    label: 'Check Agent',
    description: 'Read the durable status and append-only event history for a background agent run.',
    parameters: Type.Object({
      runId: Type.String({ description: 'Run id returned by dispatch_agent' }),
    }),
    async execute(_toolCallId, params) {
      const detail = checkRun(params.runId)
      if (!detail) throw new Error(`Unknown agent run "${params.runId}".`)
      const run = detail.run
      const result = run.status === 'succeeded' && run.result ? `\n\n${run.result}` : ''
      const error = run.errorMessage ? `\n\nError: ${run.errorMessage}` : ''
      return {
        content: [{ type: 'text' as const, text: `${run.agentLabel} ${run.verb}: ${run.status}.${result}${error}` }],
        details: detail,
      }
    },
  })
}

export function createAgentExtensionFactory(options: AgentToolOptions = {}) {
  return (pi: ExtensionAPI) => registerAgentTools(pi, options)
}

/**
 * The roster section for Bond's system prompt — name, role, verbs, and the
 * consultation policy. Generated per turn, so a new agent definition needs no
 * runtime wiring.
 */
export function buildAgentRosterPrompt(loadRoster: typeof loadAgentRoster = loadAgentRoster): string {
  const { agents } = loadRoster()
  if (!agents.length) return ''

  let prompt = '\nSPECIALIST AGENTS:\n' +
    'Bond can consult specialist agents via the consult_agent tool. They run isolated and read-only, and return a cited report; you apply any changes yourself through your normal tools. ' +
    'A consult can take a minute or two — that is normal. Always pass a specific brief and the paths in scope. Relay their QUESTIONS and ESCALATIONS to the user before acting on them. ' +
    'For work that should continue off-turn, first show the user the exact brief and wait for confirmation, then use dispatch_agent with a stable idempotency key; use check_agent for status. Phase 0 background tasks are also read-only.\n'

  for (const agent of agents) {
    const settings = effectiveAgentSettings(agent)
    const verbs = agent.verbs.map(verb => (verb.description ? `${verb.name} (${verb.description})` : verb.name)).join(', ')
    const policy = settings.policy === 'auto'
      ? 'Consult proactively whenever their specialty is in play, without being asked.'
      : settings.policy === 'suggest'
        ? 'Offer to consult them when their specialty is in play; consult when the user asks.'
        : 'Consult only when the user explicitly asks.'
    const mode = settings.workspace === 'write'
      ? 'Write-capable: dispatch only after explicit brief confirmation; it works in a managed retained worktree.'
      : 'Read-only; use consult_agent for synchronous work or dispatch_agent for durable background work.'
    prompt += `- ${agent.label} (${agent.name})${agent.role ? ` — ${agent.role}` : ''}. Verbs: ${verbs}. ${mode} ${policy}\n`
  }
  return prompt
}
