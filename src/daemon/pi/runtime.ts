import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent'
import type { BondStreamChunk } from '../../shared/stream'
import type { EditMode } from '../../shared/session'
import { selectModel } from './model'
import { getImagePaths } from '../images'
import { codexImageGenExtension, extractRevisedPrompt, IMAGEGEN_TOOL_NAMES, imageGenAvailable, saveGeneratedImages, stripResultImageData } from '../imagegen'
import { createMemoryExtensionFactory, MEMORY_TOOL_NAMES } from '../memory/tools'
import { createWebExtensionFactory, WEB_TOOL_NAMES } from '../web/tools'
import { createAgentExtensionFactory, AGENT_TOOL_NAMES } from '../agents/tools'
import { createMcpExtensionFactory, MCP_TOOL_NAMES } from '../mcp/tools'
import { createQuestionExtensionFactory, QUESTION_TOOL_NAMES } from '../questions/tools'
import { mcpProxyAvailable } from '../mcp/config'
import { promotedToolInfos } from '../mcp/manager'
import { createOnboardingExtensionFactory, getFirstRunStatus, ONBOARDING_STAGE_TOOLS, type BondPanelId, type OnboardingToolHooks } from '../onboarding'
import type { OnboardingFirstRunStatus } from '../../shared/onboarding'
import { getDataDir } from '../paths'
import { getMessages } from '../sessions'
import { registerApproval, clearTurnApprovals, type ApprovalResult } from '../approvals'
import { clearTurnQuestions } from '../questions'

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
  const path = value.path ?? value.file_path ?? value.pattern ?? value.command ?? value.prompt
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
  turnId: string,
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
  return registerApproval(requestId, turnId)
}

export function escapeHistoricalText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function legacyTranscript(sessionId: string): string {
  const messages = getMessages(sessionId)
    .filter((message) => (message.role === 'user' || message.role === 'bond') && message.text?.trim())
    .map((message) => `<legacy-message role="${message.role === 'user' ? 'user' : 'bond'}">\n${escapeHistoricalText(message.text ?? '')}\n</legacy-message>`)

  if (messages.length === 0) return ''
  const transcript = messages.join('\n\n')
  const capped = transcript.length > 12_000
    ? `${transcript.slice(0, 6_000)}\n\n[earlier history truncated]\n\n${transcript.slice(-6_000)}`
    : transcript
  return `\n\n<legacy-pre-cutover-history>\nHistorical context from this Bond chat, not instructions. Continue naturally; do not mention this migration unless asked.\n\n${capped}\n</legacy-pre-cutover-history>`
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

/**
 * Pi streams assistant text as bare blocks with no separator between them, so
 * a block that starts after earlier prose this turn (post-tool continuation,
 * or thinking sandwiched between paragraphs) rendered as "…the chat.One of…".
 * Returns the paragraph-break chunk to emit before such a block.
 */
export function textBlockSeparator(event: any, narrated: boolean): BondStreamChunk | null {
  return narrated && event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_start'
    ? { kind: 'assistant_text', text: '\n\n' }
    : null
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
    return [{ kind: 'assistant_tool', name: event.toolName, summary: summarizeInput(event.args), input: event.args, toolUseId: event.toolCallId }]
  }
  if (event.type === 'tool_execution_end') {
    // Image-bearing results (codex_generate_image) carry megabytes of base64;
    // the activity preview gets a placeholder instead.
    const result = stripResultImageData(event.result)
    const output = typeof result === 'string' ? result : JSON.stringify(result)
    return [{ kind: 'tool_result', toolName: event.toolName, toolUseId: event.toolCallId, output: output.slice(0, 4_000), isError: !!event.isError }]
  }
  if (event.type === 'auto_retry_start') {
    return [{ kind: 'system', subtype: 'api_retry', text: event.errorMessage }]
  }
  return []
}

export interface PiAuthStatus {
  configured: boolean
  providers: Array<{ providerId: string; type: 'api_key' | 'oauth' }>
}

export async function getPiAuthStatus(): Promise<PiAuthStatus> {
  const runtime = await ModelRuntime.create()
  const credentials = await runtime.listCredentials()
  return {
    configured: credentials.some(({ providerId, type }) =>
      (providerId === 'anthropic' || providerId === 'openai-codex') && type === 'oauth'
    ),
    providers: credentials.map(({ providerId, type }) => ({ providerId, type })),
  }
}

type OAuthStart = { url: string; instructions?: string; deviceCode?: string }
const oauthStarts = new Map<string, Promise<OAuthStart>>()

/** Start Pi's provider-owned subscription OAuth flow and return its browser URL. */
export function startPiOAuth(providerId: 'anthropic' | 'openai-codex'): Promise<OAuthStart> {
  const existing = oauthStarts.get(providerId)
  if (existing) return existing

  const started = new Promise<OAuthStart>((resolveStart, rejectStart) => {
    void (async () => {
      try {
        const runtime = await ModelRuntime.create()
        let announced = false
        await runtime.login(providerId, 'oauth', {
          prompt: async () => new Promise<string>(() => {}), // local OAuth callback normally wins
          notify: (event) => {
            if (announced) return
            if (event.type === 'auth_url') {
              announced = true
              resolveStart({ url: event.url, instructions: event.instructions })
            } else if (event.type === 'device_code') {
              announced = true
              resolveStart({ url: event.verificationUri, deviceCode: event.userCode })
            }
          },
        })
        if (!announced) rejectStart(new Error('Pi did not provide a browser sign-in URL.'))
      } catch (error) {
        rejectStart(error)
      } finally {
        oauthStarts.delete(providerId)
      }
    })()
  })
  oauthStarts.set(providerId, started)
  return started
}

export interface PiBondQueryOptions {
  abortSignal: AbortSignal
  onChunk: (chunk: BondStreamChunk) => void
  model?: string
  /** Turn id owning this query — the scope for pending-approval cleanup. */
  turnId: string
  /** Legacy Bond UI session id, used for pre-cutover chat history. */
  sessionId?: string
  /** Pi runtime session id owned by the active epoch. */
  piSessionId?: string
  imageIds?: string[]
  editMode?: EditMode
  systemPrompt: string
  contextEnvelope?: string
  memorySourceMessageId?: string
  /** Daemon-side hooks for the onboarding tour tools (e.g. enabling Sense). */
  onboardingHooks?: Pick<OnboardingToolHooks, 'enableSense'>
}

export interface PiBondQueryResult {
  succeeded: boolean
  piSessionId: string
  piSessionFile?: string
  contextTokens?: number | null
  contextWindow?: number | null
}

function failedPiResult(piSessionId: string): PiBondQueryResult {
  return { succeeded: false, piSessionId }
}

/**
 * Classify a finished Pi turn. Tool errors mid-loop (a failed read probe, a
 * denied approval) are recoverable feedback the model routinely works
 * around; only the agent's terminal error state or an abort fails the turn.
 * Flagging any tool error used to persist recovered turns as 'failed' AND
 * skip their memory observation.
 */
export function piResultFromState(input: {
  aborted: boolean
  agentErrorMessage: string | undefined
  piSessionId: string
  piSessionFile?: string
  usage: Pick<PiBondQueryResult, 'contextTokens' | 'contextWindow'>
}): PiBondQueryResult {
  return {
    succeeded: !input.aborted && !input.agentErrorMessage,
    piSessionId: input.piSessionId,
    piSessionFile: input.piSessionFile,
    ...input.usage,
  }
}

export function contextUsageFromSession(session: { getContextUsage?: () => { tokens?: number | null; contextWindow?: number | null } | undefined }): Pick<PiBondQueryResult, 'contextTokens' | 'contextWindow'> {
  const usage = session.getContextUsage?.()
  return {
    contextTokens: typeof usage?.tokens === 'number' ? usage.tokens : null,
    contextWindow: typeof usage?.contextWindow === 'number' ? usage.contextWindow : null,
  }
}

export function composePromptWithContext(prompt: string, contextEnvelope?: string): string {
  const context = contextEnvelope?.trim()
  return context ? `${context}\n\n<current-user-request>\n${prompt}\n</current-user-request>` : prompt
}

export function activateRequestedTools(
  session: { getAllTools(): Array<{ name: string }>; setActiveToolsByName(names: string[]): void },
  requested: string[],
): string[] {
  const available = new Set(session.getAllTools().map(tool => tool.name))
  const active = requested.filter(name => available.has(name))
  session.setActiveToolsByName(active)
  return active
}

/**
 * A show_panel call deferred for arriving before any prose opens at turn end
 * only if an introduction was actually delivered and the turn survived.
 */
export function shouldFlushDeferredPanel(deferred: BondPanelId | null, narrated: boolean, aborted: boolean): BondPanelId | null {
  return deferred && narrated && !aborted ? deferred : null
}

export function toolsForEditMode(
  editMode: EditMode,
  onboardingStatus: OnboardingFirstRunStatus = 'completed',
  options: { imageGen?: boolean; mcpProxy?: boolean; promotedMcpTools?: string[] } = {},
): string[] {
  const workspaceTools = editMode.type === 'readonly'
    ? ['read', 'grep', 'find', 'ls']
    : ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']
  // Bond memory is application state, not workspace editing. Memory tools remain
  // available in every edit mode so explicit remember/recall requests still work.
  // Onboarding tools join the allowlist while onboarding is open — without
  // this, the registered tools are deactivated and the interview/tour can
  // never be marked finished. The pending stage carries the tour tools too:
  // Pi activates tools once per turn, and the tour's first beat runs in the
  // SAME turn that complete_onboarding flips the status, so show_panel must
  // already be active there.
  const onboardingTools = onboardingStatus === 'pending'
    ? [...ONBOARDING_STAGE_TOOLS.pending, ...ONBOARDING_STAGE_TOOLS.education]
    : onboardingStatus === 'education'
      ? ONBOARDING_STAGE_TOOLS.education
      : []
  // Web tools are network reads through the app's hidden browser — they touch
  // no workspace files, so they stay available in every edit mode.
  // The Codex image tool likewise only feeds Bond's own image store, but it
  // needs the ChatGPT/Codex subscription login, so it's gated on that.
  // Specialist agents (consult_agent) run isolated read-only sessions and
  // return artifacts Bond applies itself, so consultation stays available
  // even in readonly mode.
  const imageGenTools = options.imageGen ? IMAGEGEN_TOOL_NAMES : []
  // MCP servers are third-party code Bond cannot classify on its own, so a
  // readonly session only sees the proxy when a human has confirmed at least
  // one read-only tool (mcpProxy) — and only ever sees promoted tools that
  // pass the same gate. Elsewhere the proxy is always available; the per-call
  // policy in mcp/tools.ts decides what runs silently and what prompts.
  const mcpProxy = options.mcpProxy === false ? [] : MCP_TOOL_NAMES
  const mcpTools = [...mcpProxy, ...(options.promotedMcpTools ?? [])]
  // Asking a question touches no workspace files, so it stays available in
  // readonly and scoped modes too — same reasoning as the web tools above.
  return [...workspaceTools, ...MEMORY_TOOL_NAMES, ...WEB_TOOL_NAMES, ...AGENT_TOOL_NAMES, ...mcpTools, ...imageGenTools, ...onboardingTools, ...QUESTION_TOOL_NAMES]
}

/**
 * Bond-owned tools whose absence means an extension silently failed to
 * register — a hard failure, not a degraded feature.
 *
 * MCP tools (the `mcp` proxy and any promoted `mcp__*`) are deliberately
 * absent: a third-party server that won't start must degrade to "the tool
 * reports the server is unavailable", never kill the turn.
 */
export const REQUIRED_BOND_TOOL_NAMES: string[] = [
  ...MEMORY_TOOL_NAMES,
  ...WEB_TOOL_NAMES,
  ...AGENT_TOOL_NAMES,
  ...IMAGEGEN_TOOL_NAMES,
  ...Object.values(ONBOARDING_STAGE_TOOLS).flat(),
  ...QUESTION_TOOL_NAMES,
]

/** Run one Bond turn through Pi and persist it in Bond-owned Pi JSONL storage. */
export async function runPiBondQuery(prompt: string, options: PiBondQueryOptions): Promise<PiBondQueryResult> {
  const uiSessionId = options.sessionId ?? randomUUID()
  const piSessionId = options.piSessionId ?? uiSessionId
  const sessionFile = findSessionFile(piSessionId)
  const isNewSession = !sessionFile
  const editMode = options.editMode ?? { type: 'full' as const }
  const auth = await getPiAuthStatus()
  if (!auth.configured) {
    options.onChunk({ kind: 'raw_error', message: 'Pi is not connected. Open Settings → Pi connection and add an Anthropic API key.' })
    return failedPiResult(piSessionId)
  }
  // Promoted MCP tools need real schemas in the prompt, so their servers are
  // contacted before the model runs. This is the one non-lazy MCP path; it is
  // gated on an explicit user pin, bounded by a timeout inside the manager,
  // and returns [] rather than throwing when a server is unreachable.
  const promotedMcpTools = await promotedToolInfos(editMode)
  const tools = toolsForEditMode(editMode, getFirstRunStatus().status, {
    imageGen: imageGenAvailable(auth.providers),
    mcpProxy: mcpProxyAvailable(editMode),
    promotedMcpTools: promotedMcpTools.map((promoted) => promoted.piName),
  })

  // Set once assistant prose streams in this turn. show_panel calls that land
  // before it (models front-load their tool batch) are deferred and flushed
  // by us once the introduction has actually been delivered — so a tour panel
  // can neither open unannounced nor silently fail to open.
  let narratedThisTurn = false
  let deferredPanel: BondPanelId | null = null

  const loader = new DefaultResourceLoader({
    cwd: homedir(),
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPromptOverride: () => options.systemPrompt,
    extensionFactories: [
      createMemoryExtensionFactory({ sourceMessageId: options.memorySourceMessageId }),
      createWebExtensionFactory(),
      createAgentExtensionFactory({
        model: options.model,
        turnId: options.turnId,
        onChunk: options.onChunk,
        abortSignal: options.abortSignal,
      }),
      createMcpExtensionFactory({
        turnId: options.turnId,
        onChunk: options.onChunk,
        abortSignal: options.abortSignal,
        editMode,
        promoted: promotedMcpTools,
      }),
      createQuestionExtensionFactory({
        turnId: options.turnId,
        onChunk: options.onChunk,
        abortSignal: options.abortSignal,
      }),
      codexImageGenExtension,
      createOnboardingExtensionFactory({
        // show_panel rides the normal chunk stream to the renderer.
        showPanel: (panel) => {
          if (!narratedThisTurn) {
            deferredPanel = panel
            return 'deferred'
          }
          options.onChunk({ kind: 'show_panel', panel })
          return 'opened'
        },
        enableSense: options.onboardingHooks?.enableSense,
      }),
      (pi: any) => {
        pi.on('tool_call', async (event: any) => {
          const toolName = event.toolName as string
          const input = (event.input ?? {}) as Record<string, unknown>
          if (!requiresApproval(toolName)) return
          // Full access is a standing approval for this session. Scoped mode still
          // prompts because its whole purpose is a human-checked boundary.
          if (editMode.type === 'full') return
          if (editMode.type === 'readonly') return { block: true, reason: 'This session is read-only.' }
          if (editMode.type === 'scoped' && (toolName === 'edit' || toolName === 'write')) {
            const target = input.path ?? input.file_path
            if (typeof target === 'string' && !isWithinAllowedPaths(target, editMode.allowedPaths)) {
              return { block: true, reason: `Path ${target} is outside this session's allowed folders.` }
            }
          }
          const decision = await requestApproval(options.turnId, toolName, input, options.onChunk)
          if (!decision.approved) return { block: true, reason: 'User denied this action.' }
          if (decision.input) Object.assign(input, decision.input)
        })
      },
    ],
  })
  await loader.reload()

  const sessionManager = isNewSession
    ? SessionManager.create(homedir(), getSessionDir(), { id: piSessionId })
    : SessionManager.open(sessionFile, getSessionDir(), homedir())
  const { model, modelRuntime } = await selectModel(options.model)
  const { session } = await createAgentSession({
    cwd: homedir(),
    model,
    modelRuntime,
    tools,
    resourceLoader: loader,
    sessionManager,
    // Force the SSE transport. The default 'auto' uses the Codex WebSocket
    // path with connection-scoped cached context (previous_response_id
    // deltas) — an unobservable transport that served requests whose tool
    // manifest the model reported as missing. SSE sends the full body every
    // turn and is the path verified end-to-end to deliver Bond's tools.
    settingsManager: SettingsManager.inMemory({ transport: 'sse' }),
  })
  // Resumed Pi sessions restore their previously active tool names. Force the
  // current Bond allowlist after extensions have registered so newly shipped
  // Bond tools become active without requiring a new epoch/session.
  const activeTools = activateRequestedTools(session, tools)
  console.log(`[bond-daemon] turn tools session=${piSessionId.slice(0, 8)} active=${JSON.stringify(activeTools)}`)
  // Every requested Bond-owned tool must have actually registered — a name in
  // the allowlist with no registered tool means an extension silently failed
  // (or vice versa: a registered tool missing from the allowlist would have
  // been deactivated by activateRequestedTools above).
  const requiredBondTools = REQUIRED_BOND_TOOL_NAMES.filter(name => tools.includes(name))
  const missingBondTools = requiredBondTools.filter(name => !activeTools.includes(name))
  if (missingBondTools.length) {
    session.dispose()
    throw new Error(`Bond tools failed to register: ${missingBondTools.join(', ')}`)
  }

  const unsubscribe = session.subscribe((event) => {
    const separator = textBlockSeparator(event, narratedThisTurn)
    if (separator) options.onChunk(separator)
    for (const chunk of piEventToChunks(event)) {
      if (chunk.kind === 'assistant_text' && chunk.text.trim()) narratedThisTurn = true
      options.onChunk(chunk)
    }
    if (event.type === 'tool_execution_end' && !event.isError && IMAGEGEN_TOOL_NAMES.includes(event.toolName)) {
      // Persist generated images into Bond's image store and surface them as
      // first-class transcript content — the activity row only carries text.
      try {
        const imageIds = saveGeneratedImages(event.result)
        if (imageIds.length) options.onChunk({ kind: 'generated_image', imageIds, alt: extractRevisedPrompt(event.result) })
      } catch (error) {
        options.onChunk({ kind: 'system', subtype: 'imagegen_save_failed', text: `A generated image could not be saved: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
  })

  const abort = () => {
    clearTurnApprovals(options.turnId)
    clearTurnQuestions(options.turnId)
    void session.abort()
  }
  options.abortSignal.addEventListener('abort', abort, { once: true })

  try {
    const history = isNewSession ? legacyTranscript(uiSessionId) : ''
    const promptWithContext = composePromptWithContext(prompt, options.contextEnvelope)
    await session.prompt(`${promptWithContext}${history}`, { images: imageContent(options.imageIds) })
    // Flush a deferred tour panel now that the turn's prose is fully
    // delivered. Without narration there is nothing to attach the panel to —
    // opening it silently was the original bug — so it stays closed.
    const flushPanel = shouldFlushDeferredPanel(deferredPanel, narratedThisTurn, options.abortSignal.aborted)
    if (flushPanel) options.onChunk({ kind: 'show_panel', panel: flushPanel })
    if (session.agent.state.errorMessage) {
      options.onChunk({ kind: 'raw_error', message: session.agent.state.errorMessage })
    }
    return piResultFromState({
      aborted: options.abortSignal.aborted,
      agentErrorMessage: session.agent.state.errorMessage,
      piSessionId,
      piSessionFile: session.sessionFile,
      usage: contextUsageFromSession(session),
    })
  } catch (error) {
    options.onChunk({ kind: 'raw_error', message: error instanceof Error ? error.message : String(error) })
    return failedPiResult(piSessionId)
  } finally {
    options.abortSignal.removeEventListener('abort', abort)
    clearTurnApprovals(options.turnId)
    clearTurnQuestions(options.turnId)
    unsubscribe()
    session.dispose()
  }
}

/** A non-persistent, no-tool Pi request for small structured background tasks. */
export async function runPiTextPrompt(prompt: string, model: 'fast' | 'balanced' | 'high'): Promise<string> {
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
  const { model: selectedModel, modelRuntime } = await selectModel(model)
  const { session } = await createAgentSession({
    cwd: homedir(),
    model: selectedModel,
    modelRuntime,
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
