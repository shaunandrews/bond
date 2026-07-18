import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, normalize } from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BondStreamChunk } from '../shared/stream'
import type { EditMode } from '../shared/session'
import { getSoul, getSetting } from './settings'
import { getImagePaths } from './images'
import { getSkillsDir } from './paths'
import { scanSkills, type SkillInfo } from './skills'
import { listCollections, countItems } from './collections'
import { getDb } from './db'
import { DEFAULT_SENSE_SETTINGS } from '../shared/sense'
import { listDebriefs } from './debriefs'

export function getCachedSkills(): SkillInfo[] {
  return scanSkills()
}

const BOND_BASE_PROMPT =
  'You are Bond, a standalone desktop assistant app for Mac. ' +
  'Bond is its own product — a native Electron app with its own chat UI, sidebar, settings, and session management. ' +
  'You are NOT Claude, Claude Code, or the Claude website. You are powered by Claude (an AI model by Anthropic), but your identity is Bond. ' +
  'Do not behave like a default AI assistant — no filler, no sycophancy, no "Great question!" preambles, no hedging with unnecessary caveats. You have a personality; use it.\n' +
  'When the user says "your UI", "your app", "your settings", or similar, they mean the Bond app they are using right now — not Claude\'s UI or any Anthropic product. ' +
  'The Bond app\'s source code lives at ~/Developer/Projects/bond if you need to inspect or modify it.\n\n' +
  'You can read files with Read, search with Glob and Grep, edit files with Edit and Write, and run shell commands with Bash. ' +
  'You can search the web with WebSearch and fetch page content with WebFetch. ' +
  'Write operations require user approval before they execute. Stay concise. ' +
  'When the user gives a path, resolve it relative to their home or as an absolute path if they provide one.\n\n' +
  'Skills extend your capabilities. They live in ~/.bond/skills/<name>/SKILL.md. ' +
  'Each SKILL.md has YAML frontmatter (name, description, argument-hint) and a body with detailed instructions. ' +
  'IMPORTANT: Before responding to a user message, check if it matches any available skill\'s description. ' +
  'If it does, read ~/.bond/skills/<name>/SKILL.md and follow its instructions automatically. ' +
  'Users can also invoke skills explicitly with /skill-name in chat. ' +
  'You can create, edit, list, and remove skills by reading/writing files in ~/.bond/skills/. ' +
  'To create a skill: mkdir the directory, write a SKILL.md with frontmatter and instructions. ' +
  'After creating or modifying skills, tell the user to restart the daemon for changes to take effect.\n\n' +
  'MEDIA LIBRARY:\n' +
  'Bond has a built-in media library for storing images. You can manage it via the `bond media` CLI:\n' +
  '- `bond media` or `bond media list` — list all images in the library\n' +
  '- `bond media add <url>` — download an image from a URL and add it to the library\n' +
  '- `bond media info <id|number>` — show details for an image\n' +
  '- `bond media open <id|number>` — open an image in Preview\n' +
  '- `bond media rm <id|number>` — delete an image\n' +
  '- `bond media purge` — delete all images\n' +
  'When the user asks you to download, save, or add images to their media library, use `bond media add <url>`. ' +
  'You can combine this with WebSearch to find images and then download them. ' +
  'Images are stored permanently in ~/Library/Application Support/bond/images/.\n\n' +
  'ARTIFACTS — RICH VISUAL CONTENT IN CHAT:\n' +
  'For visual content that is not already covered by Bond data embeds (collections or media), use <bond-artifact> blocks to render rich HTML+Tailwind. ' +
  'Good uses: recommendations, comparisons, data visualizations, styled tables, dashboards, step-by-step guides, image grids. ' +
  'Do NOT use artifacts to display Bond\'s own entities (collections or media) — use <bond-embed> for those instead.\n\n' +
  'Syntax (the tag MUST start on its own line, not inline with other text):\n' +
  '<bond-artifact title="Optional Title" chrome="none">\n' +
  '  HTML content with Tailwind utility classes\n' +
  '</bond-artifact>\n\n' +
  'Attributes:\n' +
  '- title: optional label shown above the artifact (only shown when chrome is "default")\n' +
  '- layout: "normal" (default, message width), "wide" (up to 960px, for tables and comparisons), or "full" (edge-to-edge, for carousels, galleries, dashboards, and immersive content)\n' +
  '- chrome: "default" (border + header) or "none" (seamless, blends into chat). Use chrome="none" by default.\n\n' +
  'Available inside the artifact:\n' +
  '- All Tailwind CSS utility classes (loaded via CDN)\n' +
  '- Bond color tokens as CSS variables: --color-bg, --color-surface, --color-border, --color-text-primary, --color-muted, --color-accent, --color-err, --color-ok, --color-tint\n' +
  '- JavaScript for interactivity (event handlers, state, animations)\n' +
  '- Links are auto-intercepted and opened in the user\'s browser\n' +
  '- postMessage bridge:\n' +
  '  window.parent.postMessage({ type: "bond:openExternal", url: "..." }, "*")\n' +
  '  window.parent.postMessage({ type: "bond:copyText", text: "..." }, "*")\n\n' +
  'Design guidelines:\n' +
  '- Use Bond color tokens (var(--color-*)), keep backgrounds native, and use chrome="none" by default.\n\n' +
  'IMAGES IN ARTIFACTS:\n' +
  '- NEVER guess or hallucinate image URLs. Use WebSearch to find actual image URLs first. If you cannot verify a URL, do NOT include <img> tags.\n\n' +
  'Do NOT mention or reference the artifact system to the user — just use it naturally.\n\n' +
  'ENTITY EMBEDS — COMPLETE REFERENCE:\n' +
  '<bond-embed type="media" />                            — all images (default limit 12)\n' +
  '<bond-embed type="media" ids="id1,id2" />             — specific images by ID\n' +
  '<bond-embed type="media" search="screenshot" />       — filter by filename\n' +
  '<bond-embed type="media" limit="6" />                 — cap the count\n' +
  'Tag MUST be on its own line. Self-closing. Mix freely with markdown commentary. ALWAYS use embeds when showing Bond data to the user.\n\n' +
  'COLLECTIONS:\n' +
  'Bond has a collections system for tracking anything with user-defined schemas (movies, books, coffee, workouts, etc.). Manage via the `bond collection` CLI.\n' +
  '- `bond collection` — list all collections\n' +
  '- `bond collection create <name> --icon 🎬 --schema \'<json>\'` — create a collection\n' +
  '- `bond collection show <name|id>` / `ls` / `add` / `update` / `done` / `info` / `rm` / `archive` — manage collections and items\n' +
  'When the user talks about items conversationally, use the CLI to create/update items. To show collections in chat, use <bond-embed type="collection" /> or variants with name/filter/search/limit.\n\n'

function buildSkillsPrompt(): string {
  const skills = getCachedSkills()
  if (skills.length === 0) return ''
  let prompt = '\nAvailable skills:\n'
  for (const s of skills) {
    prompt += '- /' + s.name + ': ' + s.description
    if (s.argumentHint) prompt += ' ' + s.argumentHint
    prompt += '\n'
  }
  prompt += 'When a user request clearly matches a skill, read its SKILL.md and follow the instructions without being asked.\n'
  return prompt
}

function buildCollectionsPrompt(): string {
  const collections = listCollections().filter(c => !c.archived)
  if (collections.length === 0) return ''
  const lines = collections.map(c => {
    const icon = c.icon ? `${c.icon} ` : ''
    const count = countItems(c.id)
    const fields = c.schema.map(f => f.name).join(', ')
    return `- ${icon}${c.name} (${count} items) — fields: ${fields}`
  })
  return '\nCurrent collections:\n' + lines.join('\n') + '\n'
}

function buildSenseInstructions(): string {
  return '\nSENSE — AWARENESS & SESSION DEBRIEFS:\n' +
    'Bond has built-in screen awareness and session debriefs across chats.\n' +
    'Screen:\n' +
    '- `bond sense now` — current screen context\n' +
    '- `bond sense today` / `bond sense yesterday` — daily summaries\n' +
    '- `bond sense search <query>` — search screen captures and session debriefs\n' +
    '- `bond sense apps [today|week]` — app usage breakdown\n' +
    '- `bond sense timeline [range]` — chronological activity\n' +
    'Debriefs:\n' +
    '- `bond sense memory` — recent session debriefs\n' +
    '- `bond sense debrief <session-id>` — full debrief for a session\n' +
    'Use Sense data when the user references past activity, needs work summaries, wants to recall something they saw, or when context would help. Don\'t dump raw OCR — synthesize and summarize.\n'
}

function loadSenseSettings() {
  try {
    const raw = getSetting('sense')
    if (raw) return { ...DEFAULT_SENSE_SETTINGS, ...JSON.parse(raw) }
  } catch { /* defaults */ }
  return DEFAULT_SENSE_SETTINGS
}

function buildRecentScreenContext(): string {
  try {
    const senseSettings = loadSenseSettings()
    if (!senseSettings.enabled || !senseSettings.autoContextInChat) return ''

    const db = getDb()
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const recentApps = db.prepare(`
      SELECT app_name, window_title, MAX(captured_at) as last_seen
      FROM sense_captures
      WHERE captured_at >= ? AND app_name IS NOT NULL
      GROUP BY app_bundle_id
      ORDER BY last_seen DESC
      LIMIT 5
    `).all(fiveMinAgo) as { app_name: string; window_title: string; last_seen: string }[]

    if (recentApps.length === 0) return ''
    const active = recentApps[0]
    const previous = recentApps.slice(1).map(a => `${a.app_name} (${a.window_title})`).join(', ')
    let contextBlock = '\nRECENT SCREEN CONTEXT (last 5 minutes):\n'
    contextBlock += `- Active app: ${active.app_name} (${active.window_title})\n`
    if (previous) contextBlock += `- Previously: ${previous}\n`

    const lastCapture = db.prepare(`
      SELECT text_content FROM sense_captures
      WHERE captured_at >= ? AND text_content IS NOT NULL AND text_status = 'done'
      ORDER BY captured_at DESC LIMIT 1
    `).get(fiveMinAgo) as { text_content: string } | undefined

    if (lastCapture?.text_content) {
      const lines = lastCapture.text_content.split('\n').filter(l => l.trim().length > 3).slice(0, 5)
      if (lines.length > 0) contextBlock += `- Key visible text: ${lines.map(l => `"${l.trim().slice(0, 80)}"`).join(', ')}\n`
    }
    return contextBlock
  } catch {
    return ''
  }
}

function buildRecentDebriefContext(): string {
  try {
    const debriefs = listDebriefs({ limit: 3 })
    if (debriefs.length === 0) return ''
    let block = '\nRECENT SESSION DEBRIEFS:\n'
    for (const d of debriefs) {
      block += `- "${d.sessionTitle}" (${d.createdAt}): ${d.summary}\n`
      if (d.topics.length > 0) block += `  Topics: ${d.topics.slice(0, 6).join(', ')}\n`
    }
    return block
  } catch {
    return ''
  }
}

function buildEditModeSuffix(editMode: EditMode): string {
  if (editMode.type === 'readonly') {
    return '\n\nThis session is in READ-ONLY mode. You can only use Read, Glob, Grep, WebSearch, and WebFetch. You cannot edit files, write files, or run shell commands.'
  }
  if (editMode.type === 'scoped') {
    return `\n\nThis session is in SCOPED WRITE mode. Write operations (Edit, Write) are restricted to the following folders:\n${editMode.allowedPaths.map(p => `- ${p}`).join('\n')}\nBash commands still require user approval. Do not attempt to write to files outside these folders.`
  }
  return ''
}

export function buildSystemPrompt(options?: { editMode?: EditMode }): string {
  const editMode = options?.editMode ?? { type: 'full' as const }
  let prompt = BOND_BASE_PROMPT
  prompt += buildSkillsPrompt()
  prompt += buildCollectionsPrompt()
  prompt += buildSenseInstructions()
  prompt += buildRecentScreenContext()
  prompt += buildRecentDebriefContext()

  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  prompt += `\nCURRENT DATE AND TIME: ${dateStr}, ${timeStr}\n`
  prompt += buildEditModeSuffix(editMode)

  const soul = getSoul().trim()
  return soul ? `${prompt}\n\n<soul>\n${soul}\n</soul>` : prompt
}

/** Build the exact full system prompt used for a new Bond query. */
export function buildSystemPromptPreview(options?: { editMode?: EditMode }): string {
  return buildSystemPrompt(options)
}

export function refreshSkillsCache(): SkillInfo[] {
  return scanSkills()
}

/**
 * Load MCP server configs from ~/.claude.json (same format Claude Code uses).
 * Returns a record suitable for the SDK's mcpServers option.
 */
function loadMcpServers(): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(resolve(homedir(), '.claude.json'), 'utf-8')
    const cfg = JSON.parse(raw)
    const servers = cfg?.mcpServers
    if (!servers || typeof servers !== 'object' || Object.keys(servers).length === 0) return undefined
    console.log('[bond] loaded MCP servers:', Object.keys(servers).join(', '))
    return servers
  } catch {
    return undefined
  }
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'Bash'])
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
const ALL_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'Bash']

function extractTargetPath(input: Record<string, unknown>): string | null {
  if (typeof input.file_path === 'string') return resolve(input.file_path)
  return null
}

function isWithinAllowedPaths(targetPath: string, allowedPaths: string[]): boolean {
  const target = normalize(targetPath)
  return allowedPaths.some(allowed => {
    const norm = normalize(resolve(allowed.replace(/^~/, homedir())))
    return target === norm || target.startsWith(norm + '/')
  })
}

type AllowResult = { behavior: 'allow'; updatedInput?: Record<string, unknown> }
type DenyResult = { behavior: 'deny'; message: string }
type ApprovalResolve = (result: AllowResult | DenyResult) => void
const pendingApprovals = new Map<string, { resolve: ApprovalResolve; sessionId: string }>()

export function resolvePendingApproval(requestId: string, approved: boolean, input?: Record<string, unknown>): void {
  const entry = pendingApprovals.get(requestId)
  if (!entry) return
  pendingApprovals.delete(requestId)
  entry.resolve(approved ? { behavior: 'allow', ...(input ? { updatedInput: input } : {}) } : { behavior: 'deny', message: 'User denied this action' })
}

export function clearSessionApprovals(sessionId: string): void {
  for (const [id, entry] of pendingApprovals) {
    if (entry.sessionId === sessionId) {
      entry.resolve({ behavior: 'deny', message: 'Request cancelled' })
      pendingApprovals.delete(id)
    }
  }
}

export type { BondStreamChunk }

function summarizeToolInput(input: Record<string, unknown>): string | undefined {
  try {
    const path = input.file_path ?? input.path ?? input.pattern
    if (typeof path === 'string') return path
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return undefined
  }
}

function* flattenToolBlocks(msg: SDKMessage): Generator<BondStreamChunk> {
  if (msg.type !== 'assistant' || !msg.message?.content) return
  for (const block of msg.message.content) {
    if (block.type === 'tool_use' && 'name' in block) {
      const name = String(block.name)
      const input =
        'input' in block && block.input && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {}
      yield { kind: 'assistant_tool', name, summary: summarizeToolInput(input), input }
    }
  }
}

function extractToolResultText(message: { message?: { content?: unknown[] } }): string | undefined {
  const content = message?.message?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (block && typeof block === 'object') {
      if ('type' in block && block.type === 'tool_result' && 'content' in block) {
        const c = block.content
        if (typeof c === 'string') { parts.push(c); continue }
        if (Array.isArray(c)) {
          for (const sub of c) {
            if (typeof sub === 'string') parts.push(sub)
            else if (sub && typeof sub === 'object' && 'text' in sub && typeof sub.text === 'string') parts.push(sub.text)
          }
        }
      }
      if ('text' in block && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function extractStreamDelta(msg: SDKMessage): BondStreamChunk | null {
  if (msg.type !== 'stream_event') return null
  const evt = msg.event as { type: string; delta?: { type: string; text?: string; thinking?: string } }
  if (evt.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta' && evt.delta.text) {
      return { kind: 'assistant_text', text: evt.delta.text }
    }
    if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
      return { kind: 'thinking_text', text: evt.delta.thinking }
    }
  }
  return null
}

export function* bondMessageToChunks(message: SDKMessage): Generator<BondStreamChunk> {
  if (message.type === 'stream_event') {
    const delta = extractStreamDelta(message)
    if (delta) yield delta
    return
  }
  if (message.type === 'assistant') {
    // Text was already streamed via deltas — only emit tool blocks
    yield* flattenToolBlocks(message)
    return
  }
  if (message.type === 'user' && message.parent_tool_use_id) {
    const output = extractToolResultText(message as any)
    if (output !== undefined) {
      yield {
        kind: 'tool_result',
        toolName: '',
        toolUseId: message.parent_tool_use_id,
        output: output.length > 4000 ? output.slice(0, 4000) + '\n…(truncated)' : output
      }
    }
    return
  }
  if (message.type === 'result') {
    if (message.subtype === 'success') {
      yield {
        kind: 'result',
        subtype: message.subtype,
        result: message.result
      }
    } else {
      yield {
        kind: 'result',
        subtype: message.subtype,
        errors: message.errors
      }
    }
    return
  }
  if (message.type === 'auth_status') {
    yield {
      kind: 'auth_status',
      authenticating: message.isAuthenticating,
      lines: message.output ?? [],
      error: message.error
    }
    return
  }
  if (message.type === 'system' && message.subtype === 'api_retry') {
    yield {
      kind: 'system',
      subtype: 'api_retry',
      text: String(message.error ?? 'Retrying API request…')
    }
  }
}

export async function runBondQuery(
  prompt: string,
  options: {
    abortSignal: AbortSignal
    onChunk: (c: BondStreamChunk) => void
    model?: string
    sessionId?: string
    resumeSession?: boolean
    imageIds?: string[]
    editMode?: EditMode
  }
): Promise<boolean> {
  const cwd = homedir()
  const ac = new AbortController()

  const editMode = options.editMode ?? { type: 'full' as const }
  const tools = editMode.type === 'readonly' ? READ_TOOLS : ALL_TOOLS
  const systemPrompt = buildSystemPrompt({ editMode })

  let lastStderrHint: 'already_in_use' | null = null

  const queryOptions: Record<string, unknown> = {
    abortController: ac,
    cwd,
    tools: [...tools],
    allowedTools: [...tools],
    model: options.model,
    includePartialMessages: true,
    permissionMode: 'default',
    systemPrompt,
    canUseTool: async (
      toolName: string,
      input: Record<string, unknown>,
      sdkOptions: { title?: string; displayName?: string; description?: string; toolUseID: string }
    ) => {
      if (!WRITE_TOOLS.has(toolName)) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      if (editMode.type === 'readonly') {
        return { behavior: 'deny' as const, message: 'Session is in read-only mode' }
      }
      if (editMode.type === 'scoped') {
        const targetPath = extractTargetPath(input)
        if (targetPath && !isWithinAllowedPaths(targetPath, editMode.allowedPaths)) {
          return { behavior: 'deny' as const, message: `Path ${targetPath} is outside allowed folders` }
        }
      }
      const requestId = randomUUID()
      options.onChunk({
        kind: 'tool_approval',
        requestId,
        toolName,
        input,
        title: sdkOptions.title ?? sdkOptions.displayName,
        description: sdkOptions.description
      })
      return new Promise<AllowResult | DenyResult>((resolve) => {
        pendingApprovals.set(requestId, { resolve, sessionId: options.sessionId ?? '' })
      })
    },
    stderr: (text: string) => {
      console.error('[bond] sdk stderr:', text.trimEnd())
      if (text.includes('already in use')) {
        lastStderrHint = 'already_in_use'
      }
    },
    plugins: [
      { type: 'local', path: resolve(getSkillsDir(), '..') }
    ],
    mcpServers: loadMcpServers(),
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'bond-electron/0.1.0'
    } as Record<string, string | undefined>
  }

  if (options.sessionId) {
    if (options.resumeSession) {
      queryOptions.resume = options.sessionId
    } else {
      queryOptions.sessionId = options.sessionId
    }
  }

  let effectivePrompt = prompt

  if (options.imageIds?.length) {
    const imagePaths = getImagePaths(options.imageIds)
    if (imagePaths.length) {
      const imageList = imagePaths.map(p => `  - ${p}`).join('\n')
      const imageNote = `<attached-images>\nThe user attached ${imagePaths.length} image(s) to this message. You MUST read each file with the Read tool before responding:\n${imageList}\n</attached-images>`
      effectivePrompt = prompt ? `${imageNote}\n\n${prompt}` : imageNote
    }
  }

  const q = query({
    prompt: effectivePrompt,
    options: queryOptions as any
  })

  options.abortSignal.addEventListener(
    'abort',
    () => {
      clearSessionApprovals(options.sessionId ?? '')
      ac.abort()
      try {
        q.close()
      } catch {
        /* ignore */
      }
    },
    { once: true }
  )

  let chunkCount = 0
  let succeeded = false
  let lastMessageId: string | null = null
  let lastInputTokens = 0
  let contextWindowLimit = 0
  let cumulativeCost = 0

  try {
    for await (const message of q) {
      if (options.abortSignal.aborted) break

      // Extract usage from assistant messages (deduplicate by message ID)
      if (message.type === 'assistant') {
        const msg = message as any
        const msgId = msg.message?.id
        if (msgId && msgId !== lastMessageId) {
          lastMessageId = msgId
          const u = msg.message?.usage
          if (u) {
            lastInputTokens =
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0)

            if (contextWindowLimit > 0) {
              options.onChunk({
                kind: 'usage_update',
                inputTokens: lastInputTokens,
                contextWindow: contextWindowLimit,
                costUsd: cumulativeCost
              })
            }
          }
        }
      }

      // Extract contextWindow and cost from result messages
      if (message.type === 'result') {
        const msg = message as any
        cumulativeCost = msg.total_cost_usd ?? cumulativeCost

        const models = msg.modelUsage ?? {}
        const primary = Object.values(models)[0] as any
        if (primary?.contextWindow) {
          contextWindowLimit = primary.contextWindow
        }

        if (contextWindowLimit > 0) {
          options.onChunk({
            kind: 'usage_update',
            inputTokens: lastInputTokens,
            contextWindow: contextWindowLimit,
            costUsd: cumulativeCost
          })
        }
      }

      for (const chunk of bondMessageToChunks(message)) {
        chunkCount++
        if (chunk.kind === 'result' && chunk.subtype === 'success') {
          succeeded = true
        }
        options.onChunk(chunk)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[bond] query error:', msg)
    // Startup failures (no chunks emitted) are re-thrown so the caller
    // can retry — e.g. "Session ID already in use" after a cancel.
    if (chunkCount === 0) {
      // The SDK often puts the real error on stderr while throwing a generic
      // "process exited with code 1". Enrich the message so retry logic can match.
      if (lastStderrHint === 'already_in_use' && !msg.includes('already in use')) {
        throw new Error(`${msg} (session already in use)`)
      }
      throw e
    }
    options.onChunk({ kind: 'raw_error', message: msg })
  } finally {
    try { q.close() } catch { /* ensure subprocess cleanup */ }
  }
  if (chunkCount === 0) {
    console.warn('[bond] query completed with no chunks emitted')
  }

  return succeeded
}
