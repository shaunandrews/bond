import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { getModel } from '@earendil-works/pi-ai/compat'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'
import type { BondStreamChunk } from '../../shared/stream'
import type { EditMode } from '../../shared/session'
import { getImagePaths } from '../images'
import { getDataDir } from '../paths'
import { getMessages } from '../sessions'

type ApprovalResult = { approved: boolean; input?: Record<string, unknown> }
type PendingApproval = { sessionId: string; resolve: (result: ApprovalResult) => void }

const pendingApprovals = new Map<string, PendingApproval>()
const MODEL_IDS = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
} as const

function getSessionDir(): string {
  const dir = join(getDataDir(), 'pi', 'sessions')
  mkdirSync(dir, { recursive: true })
  return dir
}

function findSessionFile(sessionId: string): string | undefined {
  const dir = getSessionDir()
  const suffix = `_${sessionId}.jsonl`
  const name = readdirSync(dir).find((entry) => entry.endsWith(suffix))
  return name ? join(dir, name) : undefined
}

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = input as Record<string, unknown>
  const path = value.path ?? value.file_path ?? value.pattern ?? value.command
  return typeof path === 'string' ? path.slice(0, 240) : JSON.stringify(value).slice(0, 240)
}

function isWithinAllowedPaths(targetPath: string, allowedPaths: string[]): boolean {
  const target = normalize(resolve(targetPath))
  return allowedPaths.some((allowed) => {
    const root = normalize(resolve(allowed.replace(/^~/, homedir())))
    return target === root || target.startsWith(`${root}/`)
  })
}

function requiresApproval(toolName: string): boolean {
  return toolName === 'bash' || toolName === 'edit' || toolName === 'write'
}

function requestApproval(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  onChunk: (chunk: BondStreamChunk) => void,
): Promise<ApprovalResult> {
  const requestId = randomUUID()
  onChunk({
    kind: 'tool_approval',
    requestId,
    toolName,
    input,
    title: `Allow ${toolName}?`,
    description: summarizeInput(input),
  })
  return new Promise((resolveApproval) => {
    pendingApprovals.set(requestId, { sessionId, resolve: resolveApproval })
  })
}

export function resolvePiPendingApproval(requestId: string, approved: boolean, input?: Record<string, unknown>): void {
  const pending = pendingApprovals.get(requestId)
  if (!pending) return
  pendingApprovals.delete(requestId)
  pending.resolve({ approved, input })
}

export function clearPiSessionApprovals(sessionId: string): void {
  for (const [id, pending] of pendingApprovals) {
    if (pending.sessionId === sessionId) {
      pendingApprovals.delete(id)
      pending.resolve({ approved: false })
    }
  }
}

function legacyTranscript(sessionId: string): string {
  const messages = getMessages(sessionId)
    .filter((message) => (message.role === 'user' || message.role === 'bond') && message.text?.trim())
    .map((message) => `${message.role === 'user' ? 'User' : 'Bond'}: ${message.text}`)

  if (messages.length === 0) return ''
  const transcript = messages.join('\n\n')
  const capped = transcript.length > 12_000
    ? `${transcript.slice(0, 6_000)}\n\n[earlier history truncated]\n\n${transcript.slice(-6_000)}`
    : transcript
  return `\n\nCONVERSATION HISTORY BEFORE PI CUTOVER:\nThe following is trusted historical context from this Bond chat. Continue naturally; do not mention this migration unless asked.\n\n${capped}`
}

function imageContent(imageIds: string[] | undefined) {
  if (!imageIds?.length) return []
  return getImagePaths(imageIds).flatMap((path) => {
    try {
      const extension = extname(path).toLowerCase()
      const mediaType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : extension === '.gif' ? 'image/gif'
          : extension === '.webp' ? 'image/webp'
            : 'image/png'
      return [{ type: 'image' as const, mimeType: mediaType, data: readFileSync(path).toString('base64') }]
    } catch {
      return []
    }
  })
}

function selectModel(name: string | undefined) {
  const id = MODEL_IDS[name as keyof typeof MODEL_IDS] ?? MODEL_IDS.sonnet
  return getModel('anthropic', id)
}

/** Translate Pi's SDK event vocabulary into the renderer's stable stream protocol. */
export function piEventToChunks(event: any): BondStreamChunk[] {
  if (event.type === 'message_update') {
    if (event.assistantMessageEvent.type === 'text_delta') {
      return [{ kind: 'assistant_text', text: event.assistantMessageEvent.delta }]
    }
    if (event.assistantMessageEvent.type === 'thinking_delta') {
      return [{ kind: 'thinking_text', text: event.assistantMessageEvent.delta }]
    }
  }
  if (event.type === 'tool_execution_start') {
    return [{ kind: 'assistant_tool', name: event.toolName, summary: summarizeInput(event.args), input: event.args }]
  }
  if (event.type === 'tool_execution_end') {
    const output = typeof event.result === 'string' ? event.result : JSON.stringify(event.result)
    return [{ kind: 'tool_result', toolName: event.toolName, toolUseId: event.toolCallId, output: output.slice(0, 4_000) }]
  }
  if (event.type === 'auto_retry_start') {
    return [{ kind: 'system', subtype: 'api_retry', text: event.errorMessage }]
  }
  return []
}

export interface PiBondQueryOptions {
  abortSignal: AbortSignal
  onChunk: (chunk: BondStreamChunk) => void
  model?: string
  sessionId?: string
  imageIds?: string[]
  editMode?: EditMode
  systemPrompt: string
}

/** Run one Bond turn through Pi and persist it in Bond-owned Pi JSONL storage. */
export async function runPiBondQuery(prompt: string, options: PiBondQueryOptions): Promise<boolean> {
  const sessionId = options.sessionId ?? randomUUID()
  const sessionFile = findSessionFile(sessionId)
  const isNewSession = !sessionFile
  const editMode = options.editMode ?? { type: 'full' as const }
  const tools = editMode.type === 'readonly'
    ? ['read', 'grep', 'find', 'ls']
    : ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']

  const loader = new DefaultResourceLoader({
    cwd: homedir(),
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => options.systemPrompt,
    extensionFactories: [
      (pi: any) => {
        pi.on('tool_call', async (event: any) => {
          const toolName = event.toolName as string
          const input = (event.input ?? {}) as Record<string, unknown>
          if (!requiresApproval(toolName)) return
          if (editMode.type === 'readonly') return { block: true, reason: 'This session is read-only.' }
          if (editMode.type === 'scoped' && (toolName === 'edit' || toolName === 'write')) {
            const target = input.path ?? input.file_path
            if (typeof target === 'string' && !isWithinAllowedPaths(target, editMode.allowedPaths)) {
              return { block: true, reason: `Path ${target} is outside this session's allowed folders.` }
            }
          }
          const decision = await requestApproval(sessionId, toolName, input, options.onChunk)
          if (!decision.approved) return { block: true, reason: 'User denied this action.' }
          if (decision.input) Object.assign(input, decision.input)
        })
      },
    ],
  })
  await loader.reload()

  const sessionManager = isNewSession
    ? SessionManager.create(homedir(), getSessionDir(), { id: sessionId })
    : SessionManager.open(sessionFile, getSessionDir(), homedir())
  const { session } = await createAgentSession({
    cwd: homedir(),
    model: selectModel(options.model),
    tools,
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
  })

  let hadError = false
  const unsubscribe = session.subscribe((event) => {
    for (const chunk of piEventToChunks(event)) options.onChunk(chunk)
    if (event.type === 'tool_execution_end' && event.isError) hadError = true
  })

  const abort = () => {
    clearPiSessionApprovals(sessionId)
    void session.abort()
  }
  options.abortSignal.addEventListener('abort', abort, { once: true })

  try {
    const history = isNewSession ? legacyTranscript(sessionId) : ''
    await session.prompt(`${prompt}${history}`, { images: imageContent(options.imageIds) })
    if (session.agent.state.errorMessage) {
      hadError = true
      options.onChunk({ kind: 'raw_error', message: session.agent.state.errorMessage })
    }
    return !options.abortSignal.aborted && !hadError
  } catch (error) {
    options.onChunk({ kind: 'raw_error', message: error instanceof Error ? error.message : String(error) })
    return false
  } finally {
    options.abortSignal.removeEventListener('abort', abort)
    clearPiSessionApprovals(sessionId)
    unsubscribe()
    session.dispose()
  }
}

/** A non-persistent, no-tool Pi request for small structured background tasks. */
export async function runPiTextPrompt(prompt: string, model: 'haiku' | 'sonnet' | 'opus'): Promise<string> {
  const loader = new DefaultResourceLoader({
    cwd: homedir(),
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => 'Reply only with the requested content. Do not use tools.'
  })
  await loader.reload()
  const { session } = await createAgentSession({
    cwd: homedir(),
    model: selectModel(model),
    noTools: 'all',
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  })
  try {
    await session.prompt(prompt)
    return session.messages
      .filter((message: any) => message.role === 'assistant')
      .flatMap((message: any) => message.content ?? [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')
  } finally {
    session.dispose()
  }
}
