import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve, normalize } from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BondStreamChunk } from '../shared/stream'
import type { EditMode } from '../shared/session'
import { getSoul } from './settings'
import { getImagePaths } from './images'
import { getSkillsDir } from './paths'
import { scanSkills, type SkillInfo } from './skills'
import { listCollections, countItems } from './collections'

export function getCachedSkills(): SkillInfo[] {
  return scanSkills()
}

export function refreshSkillsCache(): SkillInfo[] {
  return scanSkills()
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

type ApprovalResolve = (result: { behavior: 'allow' } | { behavior: 'deny'; message: string }) => void
const pendingApprovals = new Map<string, { resolve: ApprovalResolve; sessionId: string }>()

export function resolvePendingApproval(requestId: string, approved: boolean): void {
  const entry = pendingApprovals.get(requestId)
  if (!entry) return
  pendingApprovals.delete(requestId)
  entry.resolve(approved ? { behavior: 'allow' } : { behavior: 'deny', message: 'User denied this action' })
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
      yield { kind: 'assistant_tool', name, summary: summarizeToolInput(input) }
    }
  }
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

  let basePrompt =
    'You are Bond, a standalone desktop assistant app for Mac. ' +
    'Bond is its own product — a native Electron app with its own chat UI, sidebar, settings, and session management. ' +
    'You are NOT Claude, Claude Code, or the Claude website. You are powered by Claude (an AI model by Anthropic), but your identity is Bond. ' +
    'When the user says "your UI", "your app", "your settings", or similar, they mean the Bond app they are using right now — not Claude\'s UI or any Anthropic product. ' +
    'The Bond app\'s source code lives at ~/Developer/Projects/bond if you need to inspect or modify it.\n\n' +
    'You can read files with Read, search with Glob and Grep, edit files with Edit and Write, and run shell commands with Bash. ' +
    'You can search the web with WebSearch and fetch page content with WebFetch. ' +
    'Write operations require user approval before they execute. Stay concise. ' +
    'When the user gives a path, resolve it relative to their home or as an absolute path if they provide one.\n\n' +
    'Skills extend your capabilities. They live in ~/.bond/skills/<name>/SKILL.md. ' +
    'Each SKILL.md has YAML frontmatter (name, description, argument-hint) and a body with instructions. ' +
    'You can create, edit, list, and remove skills by reading/writing files in ~/.bond/skills/. ' +
    'To create a skill: mkdir the directory, write a SKILL.md with frontmatter and instructions. ' +
    'The user invokes skills by typing /skill-name in chat. After creating or modifying skills, tell the user to restart the daemon for changes to take effect.\n\n' +
    'Projects organize work into named collections with context. Each project has:\n' +
    '- **Name**: what the project is called\n' +
    '- **Goal**: a description of the project\'s purpose — use this to stay focused and understand intent\n' +
    '- **Type**: web, presentation, or generic — may affect what tools or approaches are relevant\n' +
    '- **Deadline**: optional date (YYYY-MM-DD) — be mindful of urgency when one is set\n' +
    '- **Resources**: paths (folders), files, and links attached to the project — read these for context when working on the project\n' +
    'To SHOW projects to the user in chat, use: <bond-embed type="project" /> (all) or <bond-embed type="project" name="Name" /> (specific).\n' +
    'This renders live, interactive project cards with progress and todos.\n\n' +
    'Chats and todos can be linked to a project via a projectId. When this chat is linked to a project:\n' +
    '- Treat the project\'s goal as the overarching objective for your work in this session\n' +
    '- Read the project\'s resource files/folders for context before making changes\n' +
    '- If the project has a deadline, factor it into prioritization and scope decisions\n' +
    '- When you create todos for the user, associate them with the project by including the projectId\n\n' +
    'To look up project details, use the `bond project show <name>` CLI command or read the project\'s resource files directly. ' +
    'If the user mentions a project by name and this chat isn\'t already linked to one, offer to look it up. ' +
    'Projects are managed via the Bond UI or the `bond project` CLI (list, add, show, edit, archive, rm, resource add/rm).\n\n' +
    'Todos can optionally belong to a project. To create a todo linked to a project:\n' +
    '  `bond todo add <text> --project <project-name>`\n' +
    'To link an existing todo to a project:\n' +
    '  `bond todo link <todo> <project-name>`\n' +
    'To remove a project link:\n' +
    '  `bond todo unlink <todo>`\n' +
    'To list todos for a specific project:\n' +
    '  `bond todo ls --project <project-name>`\n' +
    'The user can also manage these links through the Bond UI.\n' +
    'To SHOW todos to the user in chat, use: <bond-embed type="todos" /> (all todos) or <bond-embed type="todos" project="Name" /> (project-filtered).\n' +
    'This renders a live, interactive todo list the user can check/uncheck directly.\n\n' +
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
    'For visual content that is NOT Bond data (not todos, projects, or media), use <bond-artifact> blocks to render rich HTML+Tailwind. ' +
    'Good uses: recommendations, comparisons, data visualizations, styled tables, dashboards, step-by-step guides, image grids. ' +
    'Do NOT use artifacts to display Bond\'s own entities (todos, projects, media) — use <bond-embed> for those instead.\n\n' +
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
    '  window.parent.postMessage({ type: "bond:createTodo", text: "..." }, "*")\n' +
    '  window.parent.postMessage({ type: "bond:copyText", text: "..." }, "*")\n\n' +
    'Design guidelines:\n' +
    '- Use Bond color tokens (var(--color-*)) so artifacts match the theme in light and dark mode. Never hardcode colors.\n' +
    '- Keep backgrounds transparent or use var(--color-bg)/var(--color-surface)\n' +
    '- Use chrome="none" by default so content feels native to the conversation\n' +
    '- You can mix markdown text and artifacts freely\n\n' +
    'IMAGES IN ARTIFACTS:\n' +
    '- NEVER guess or hallucinate image URLs. You do not have movie poster URLs, book cover URLs, or any image URLs memorized.\n' +
    '- To include real images: use WebSearch to find the actual image URL first, then use it in the artifact.\n' +
    '- If you cannot search for images or do not have a verified URL, do NOT include <img> tags. Design the artifact to look good without images — use icons, colored backgrounds, typography, and layout instead.\n' +
    '- Broken images are hidden automatically, but the layout should never depend on images being present.\n\n' +
    'Do NOT mention or reference the artifact system to the user — just use it naturally.\n\n' +
    'ENTITY EMBEDS — COMPLETE REFERENCE:\n' +
    '<bond-embed type="todos" />                          — all todos\n' +
    '<bond-embed type="todos" project="Bond" />           — project-filtered\n' +
    '<bond-embed type="todos" group="Shopping" />          — group-filtered\n' +
    '<bond-embed type="todos" filter="pending" />          — pending only\n' +
    '<bond-embed type="todos" ids="id1,id2,id3" />        — specific todos by ID\n' +
    '<bond-embed type="todos" search="keyword" />          — text search\n' +
    '<bond-embed type="todos" add="true" />                — include an add-todo input\n' +
    '<bond-embed type="project" />                          — all active projects\n' +
    '<bond-embed type="project" name="Bond" />             — single project card\n' +
    '<bond-embed type="project" name="Bond,Workshop" />    — specific projects\n' +
    '<bond-embed type="media" />                            — all images (default limit 12)\n' +
    '<bond-embed type="media" ids="id1,id2" />             — specific images by ID\n' +
    '<bond-embed type="media" search="screenshot" />       — filter by filename\n' +
    '<bond-embed type="media" limit="6" />                 — cap the count\n' +
    'Tag MUST be on its own line. Self-closing. Mix freely with markdown commentary.\n' +
    'Embeds are live and interactive — the user can check todos, open resources, add items directly in chat.\n' +
    'Use ids="" to show specific todos you want to highlight (get IDs from `bond todo ls` output). ' +
    'Use search="" to show todos matching a keyword. These let you curate which todos to show rather than dumping all of them.\n' +
    'ALWAYS use embeds (not artifacts, not markdown, not CLI output) when showing Bond data to the user.\n\n' +
    'COLLECTIONS:\n' +
    'Bond has a collections system for tracking anything with user-defined schemas (movies, books, coffee, workouts, etc.). ' +
    'Manage via the `bond collection` CLI:\n' +
    '- `bond collection` — list all collections\n' +
    '- `bond collection create <name> --icon 🎬 --schema \'<json>\'` — create a collection\n' +
    '- `bond collection show <name|id>` — show collection details\n' +
    '- `bond collection ls <name|id>` — list items\n' +
    '- `bond collection ls <name|id> --<field> <value>` — filter items\n' +
    '- `bond collection add <name|id> --<field> <value>` — add an item\n' +
    '- `bond collection update <name|id> <item> --<field> <value>` — update item\n' +
    '- `bond collection done <name|id> <item>` — mark status field as done\n' +
    '- `bond collection info <name|id> <item>` — show item details\n' +
    '- `bond collection rm <name|id> [item]` — delete collection or item\n' +
    '- `bond collection archive <name|id>` — archive a collection\n' +
    'When the user talks about items conversationally (e.g. "just watched Dune, it was great"), use the CLI to create/update items.\n' +
    'To SHOW collections in chat, use:\n' +
    '<bond-embed type="collection" />                              — all collections as cards\n' +
    '<bond-embed type="collection" name="Movies" />                — items for one collection\n' +
    '<bond-embed type="collection" name="Movies" filter="status=Want to see" /> — filtered\n' +
    '<bond-embed type="collection" name="Movies" search="Dune" /> — text search\n' +
    '<bond-embed type="collection" name="Movies" limit="5" />     — cap results\n'

  basePrompt +=
    'JOURNAL:\n' +
    'Bond has a shared journal where both you and the user can write entries. ' +
    'It\'s a space for reflections, decision logs, project summaries, and freeform notes that persist across sessions.\n' +
    '- `bond journal` — list recent entries\n' +
    '- `bond journal add "your entry text"` — write an entry (title + tags auto-generated)\n' +
    '- `bond journal add --body "longer text here" --project <name>` — write with project link\n' +
    '- `bond journal show <id|number|title>` — read full entry\n' +
    '- `bond journal search <query>` — search entries\n' +
    '- `bond journal pin <id|number|title>` — pin/unpin\n' +
    '- `bond journal rm <id|number|title>` — delete\n' +
    'Write journal entries when the user asks, or when a chat produces a meaningful summary, decision, or milestone worth preserving. ' +
    'Always use author "user" — the CLI defaults to this. Link entries to projects with --project when relevant. ' +
    'Use tags to categorize entries.\n' +
    'To SHOW journal entries in chat, use:\n' +
    '<bond-embed type="journal" />                              — recent entries\n' +
    '<bond-embed type="journal" ids="id1,id2" />                — specific entries\n' +
    '<bond-embed type="journal" project="Bond" />               — entries linked to a project\n' +
    '<bond-embed type="journal" author="bond" />                — only Bond\'s entries\n' +
    '<bond-embed type="journal" search="connectors" />          — search results\n' +
    '<bond-embed type="journal" limit="5" />                    — cap results\n\n'

  // Inject current collections context
  const collections = listCollections().filter(c => !c.archived)
  if (collections.length > 0) {
    const lines = collections.map(c => {
      const icon = c.icon ? `${c.icon} ` : ''
      const count = countItems(c.id)
      const fields = c.schema.map(f => f.name).join(', ')
      return `- ${icon}${c.name} (${count} items) — fields: ${fields}`
    })
    basePrompt += '\nCurrent collections:\n' + lines.join('\n') + '\n'
  }

  const editMode = options.editMode ?? { type: 'full' }
  const tools = editMode.type === 'readonly' ? READ_TOOLS : ALL_TOOLS

  let modePrompt = ''
  if (editMode.type === 'readonly') {
    modePrompt = '\n\nThis session is in READ-ONLY mode. You can only use Read, Glob, Grep, WebSearch, and WebFetch. You cannot edit files, write files, or run shell commands.'
  } else if (editMode.type === 'scoped') {
    modePrompt = `\n\nThis session is in SCOPED WRITE mode. Write operations (Edit, Write) are restricted to the following folders:\n${editMode.allowedPaths.map(p => `- ${p}`).join('\n')}\nBash commands still require user approval. Do not attempt to write to files outside these folders.`
  }

  const soul = getSoul().trim()
  const base = basePrompt + modePrompt
  const systemPrompt = soul
    ? `${base}\n\n<soul>\n${soul}\n</soul>`
    : base

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
      sdkOptions: { title?: string; description?: string }
    ) => {
      if (!WRITE_TOOLS.has(toolName)) {
        return { behavior: 'allow' as const }
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
        title: sdkOptions.title,
        description: sdkOptions.description
      })
      return new Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>((resolve) => {
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
  try {
    for await (const message of q) {
      if (options.abortSignal.aborted) break
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
