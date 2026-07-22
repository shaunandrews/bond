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
import { answerAgentQuestionFromTool, checkAgentRunFromTool, dispatchAgentRunFromTool } from './async/api'

export const AGENT_TOOL_NAMES = ['consult_agent', 'dispatch_agent', 'check_agent', 'answer_agent_question']

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
  answerQuestion?: typeof answerAgentQuestionFromTool
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
  const answerQuestion = options.answerQuestion ?? answerAgentQuestionFromTool

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
      'Queue a durable specialist task and return immediately. Write-capable Mathis requires the exact immutable brief to be shown and confirmed by the user. ' +
      'Supply a stable idempotency key and reuse it for retries so a reconnect cannot create duplicate work.',
    parameters: Type.Object({
      agent: Type.String({ description: 'Agent name, e.g. "felix" or "q"' }),
      verb: Type.String({ description: 'One of that agent\'s verbs' }),
      brief: Type.String({ description: 'The immutable user-confirmed task brief' }),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'Read-only files/directories in scope' })),
      idempotencyKey: Type.String({ description: 'Stable unique key for this confirmed task; reuse on retries' }),
      confirmed: Type.Boolean({ description: 'True only after the user explicitly confirmed this exact immutable brief' }),
      repositoryId: Type.Optional(Type.String({ description: 'Registered target repository id; omit for Bond' })),
      targetConfirmed: Type.Optional(Type.Boolean({ description: 'True only after the user confirmed the selected repository' })),
      isolation: Type.Optional(Type.Union([Type.Literal('worktree'), Type.Literal('in-place')])),
      inPlaceConfirmed: Type.Optional(Type.Boolean({ description: 'Additional confirmation required for every trusted in-place dispatch' })),
    }),
    async execute(_toolCallId, params) {
      const dispatched = await dispatchRun({
        agent: params.agent,
        verb: params.verb,
        brief: params.brief,
        paths: params.paths,
        idempotencyKey: params.idempotencyKey,
        parentModel: options.model,
        confirmed: params.confirmed,
        repositoryId: params.repositoryId,
        targetConfirmed: params.targetConfirmed,
        isolation: params.isolation,
        inPlaceConfirmed: params.inPlaceConfirmed,
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
      const target = run.repository ? ` Repository: ${run.repository.label} (${run.repository.id}).` : ''
      const result = run.status === 'succeeded' && run.result ? `\n\n${run.result}` : ''
      const error = run.errorMessage ? `\n\nError: ${run.errorMessage}` : ''
      const pending = detail.questions.filter(question => question.status === 'pending')
      const questions = pending.length
        ? `\n\nWaiting for command approval:\n${pending.map(question => `- ${question.id}: ${question.proposedAllowlistAddition}\n  Reason: ${question.reason}`).join('\n')}`
        : ''
      const publication = detail.publication
      const handoff = publication?.status === 'published'
        ? `\n\nDraft PR #${publication.prNumber}: ${publication.prUrl}${publication.qCommentUrl ? `\nQ review: ${publication.qCommentUrl}` : ''}`
        : publication?.status === 'failed'
          ? `\n\nGitHub handoff failed (${publication.errorClass}): ${publication.errorMessage}`
          : publication
            ? `\n\nGitHub handoff: ${publication.status}`
            : ''
      const update = detail.update ? `\n\nMerged update: ${detail.update.risk} / ${detail.update.status}. ${detail.update.reason}` : ''
      return {
        content: [{ type: 'text' as const, text: `${run.agentLabel} ${run.verb}: ${run.status}.${target}${result}${error}${questions}${handoff}${update}` }],
        details: detail,
      }
    },
  })

  pi.registerTool({
    name: 'answer_agent_question',
    label: 'Answer Agent Question',
    description: 'Approve or deny a persisted run-scoped command question after relaying the exact argv, reason, and proposed allowlist addition to the user.',
    parameters: Type.Object({
      runId: Type.String(),
      questionId: Type.String(),
      approved: Type.Boolean(),
      response: Type.Optional(Type.String({ description: 'The user decision or constraints to persist with the answer.' })),
    }),
    async execute(_toolCallId, params) {
      const answered = await answerQuestion(params.runId, params.questionId, params.approved, params.response)
      return {
        content: [{ type: 'text' as const, text: params.approved
          ? `Approved that exact argv for run ${params.runId}; Mathis is resuming in the same worktree.`
          : `Denied the command; run ${params.runId} is now failed and its worktree is retained.` }],
        details: answered,
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
    'For work that should continue off-turn, first show the user the exact brief and wait for confirmation, then use dispatch_agent with a stable idempotency key; use check_agent for status. ' +
    'For a non-Bond registered repository, name the repository target and wait for explicit target confirmation. Worktrees are the default. In-place work additionally requires a trusted registration and a separate confirmation for that dispatch.\n'

  for (const agent of agents) {
    const settings = effectiveAgentSettings(agent)
    const verbs = agent.verbs.map(verb => (verb.description ? `${verb.name} (${verb.description})` : verb.name)).join(', ')
    const policy = settings.policy === 'auto'
      ? 'Consult proactively whenever their specialty is in play, without being asked.'
      : settings.policy === 'suggest'
        ? 'Offer to consult them when their specialty is in play; consult when the user asks.'
        : 'Consult only when the user explicitly asks.'
    const mode = settings.workspace === 'write'
      ? 'Write-capable: dispatch only after explicit brief and repository-target confirmation; it defaults to a managed retained worktree.'
      : 'Read-only; use consult_agent for synchronous work or dispatch_agent for durable background work.'
    prompt += `- ${agent.label} (${agent.name})${agent.role ? ` — ${agent.role}` : ''}. Verbs: ${verbs}. ${mode} ${policy}\n`
  }
  return prompt
}
