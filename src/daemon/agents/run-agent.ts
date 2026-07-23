/**
 * The generic agent session runner — an isolated, read-only Pi session per
 * consult. In-memory persistence (never touches the epoch JSONL), SSE
 * transport, tools limited to the read-only base plus whatever the settings
 * grant, killed by the parent turn's abort or by the leash, and it returns
 * only the final report text: nothing streams into the parent transcript.
 */

import { homedir } from 'node:os'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'
import type { AgentSettings, AgentThinking } from '../../shared/agents'
import { createWebExtensionFactory, WEB_TOOL_NAMES } from '../web/tools'
import { selectModel } from '../pi/model'
import { buildAgentSystemPrompt, buildAgentUserPrompt, type AgentUserPromptInput } from './prompt'
import type { AgentDefinition, AgentVerbDefinition } from './definition'
import { assertContainedPath } from './async/workspace'

/** Read-only base every agent gets. Write-capable tools must never appear here. */
export const AGENT_BASE_TOOLS = ['read', 'grep', 'find', 'ls']

/** Bond thinking setting → Pi ThinkingLevel; 'default' leaves Pi's own default. */
export function thinkingLevelFor(setting: AgentThinking): 'low' | 'medium' | 'high' | 'max' | undefined {
  return setting === 'default' ? undefined : setting
}

export function toolsForAgent(settings: AgentSettings): string[] {
  const granted = settings.tools.filter(tool => WEB_TOOL_NAMES.includes(tool))
  return [...AGENT_BASE_TOOLS, ...granted]
}

export interface RunAgentInput extends AgentUserPromptInput {
  definition: AgentDefinition
  verb: AgentVerbDefinition
  settings: AgentSettings
  /** Parent turn's capability tier, used when the agent's model is 'inherit'. */
  parentModel?: string
  signal?: AbortSignal
  /** Durable async runs use this checkpoint only after Pi created a session. */
  onSessionStarted?: () => void
  /** Optional retained-worktree root for a narrowly scoped read-only review. */
  cwd?: string
  allowedRoot?: string
}

export async function runAgentConsult(input: RunAgentInput): Promise<string> {
  const tools = toolsForAgent(input.settings)
  const cwd = input.cwd ?? homedir()
  const scopeExtension = input.allowedRoot
    ? (pi: any) => pi.on('tool_call', async (event: any) => {
        if (!AGENT_BASE_TOOLS.includes(event.toolName)) return
        const target = event.input?.path
        if (typeof target !== 'string') return
        try { assertContainedPath(input.allowedRoot!, target) }
        catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) } }
      })
    : null
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => buildAgentSystemPrompt(input.definition, input.verb, input.settings),
    // Granted web tools ride the app's hidden browser — network reads only,
    // no workspace writes, so they keep the read-only invariant intact.
    extensionFactories: [
      ...(input.settings.tools.length ? [createWebExtensionFactory()] : []),
      ...(scopeExtension ? [scopeExtension] : []),
    ],
  })
  await loader.reload()

  const tier = input.settings.model === 'inherit' ? input.parentModel : input.settings.model
  const { model, modelRuntime } = await selectModel(tier)
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    thinkingLevel: thinkingLevelFor(input.settings.thinking),
    tools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    // Same forced-SSE rationale as the main turn: the Codex WebSocket path
    // served stale tool manifests; SSE sends the full body every turn.
    settingsManager: SettingsManager.inMemory({ transport: 'sse' }),
  })

  let leashed = false
  const abort = () => void session.abort()
  const leash = setTimeout(() => {
    leashed = true
    abort()
  }, input.settings.leash * 1000)
  input.signal?.addEventListener('abort', abort, { once: true })

  try {
    input.onSessionStarted?.()
    await session.prompt(buildAgentUserPrompt(input))
    if (leashed) throw new Error(`${input.definition.label} hit the ${input.settings.leash}s leash and was stopped. Narrow the scope or raise the leash in Settings → Agents.`)
    if (input.signal?.aborted) throw new Error(`${input.definition.label}'s consultation was cancelled.`)
    if (session.agent.state.errorMessage) throw new Error(`${input.definition.label}'s consultation failed: ${session.agent.state.errorMessage}`)
    const report = session.messages
      .filter((message: any) => message.role === 'assistant')
      .flatMap((message: any) => message.content ?? [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')
    if (!report.trim()) throw new Error(`${input.definition.label} returned an empty report.`)
    return report
  } finally {
    clearTimeout(leash)
    input.signal?.removeEventListener('abort', abort)
    session.dispose()
  }
}
