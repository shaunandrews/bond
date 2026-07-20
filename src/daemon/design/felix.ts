/**
 * Felix's session runner — an isolated, read-only Pi session per
 * consultation. Modeled on runPiTextPrompt: own system prompt, in-memory
 * session/settings (never touches the epoch JSONL), SSE transport, killed by
 * the parent turn's abort signal, and it returns only the final report text —
 * nothing streams into the parent transcript.
 */

import { homedir } from 'node:os'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'
import { selectModel } from '../pi/model'
import { buildFelixSystemPrompt, buildFelixUserPrompt, type FelixUserPromptInput } from './prompt'
import type { FelixRegister, FelixVerb } from './doctrine'

/** Read-only: Bond's own readonly edit-mode set. Felix never writes, so no approval plumbing is needed. */
export const FELIX_SESSION_TOOLS = ['read', 'grep', 'find', 'ls']

export interface FelixQueryInput extends FelixUserPromptInput {
  verb: FelixVerb
  register?: FelixRegister
  /** Capability tier — inherit the parent turn's model. */
  model?: string
  /** The parent tool call's abort signal; cancelling the turn kills Felix. */
  signal?: AbortSignal
}

export async function runFelixQuery(input: FelixQueryInput): Promise<string> {
  const loader = new DefaultResourceLoader({
    cwd: homedir(),
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => buildFelixSystemPrompt(input.verb, input.register),
  })
  await loader.reload()
  const { model, modelRuntime } = await selectModel(input.model)
  const { session } = await createAgentSession({
    cwd: homedir(),
    model,
    modelRuntime,
    tools: FELIX_SESSION_TOOLS,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    // Same forced-SSE rationale as the main turn: the Codex WebSocket path
    // served stale tool manifests; SSE sends the full body every turn.
    settingsManager: SettingsManager.inMemory({ transport: 'sse' }),
  })
  const abort = () => void session.abort()
  input.signal?.addEventListener('abort', abort, { once: true })
  try {
    await session.prompt(buildFelixUserPrompt(input))
    if (input.signal?.aborted) throw new Error('Felix consultation was cancelled.')
    if (session.agent.state.errorMessage) throw new Error(`Felix consultation failed: ${session.agent.state.errorMessage}`)
    const report = session.messages
      .filter((message: any) => message.role === 'assistant')
      .flatMap((message: any) => message.content ?? [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')
    if (!report.trim()) throw new Error('Felix returned an empty report.')
    return report
  } finally {
    input.signal?.removeEventListener('abort', abort)
    session.dispose()
  }
}
