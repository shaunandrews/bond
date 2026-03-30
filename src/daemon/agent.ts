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

function extractTextDelta(msg: SDKMessage): BondStreamChunk | null {
  if (msg.type !== 'stream_event') return null
  const evt = msg.event as { type: string; delta?: { type: string; text?: string } }
  if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
    return { kind: 'assistant_text', text: evt.delta.text }
  }
  return null
}

export function* bondMessageToChunks(message: SDKMessage): Generator<BondStreamChunk> {
  if (message.type === 'stream_event') {
    const delta = extractTextDelta(message)
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

  const basePrompt =
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
    'The user invokes skills by typing /skill-name in chat. After creating or modifying skills, tell the user to restart the daemon for changes to take effect.'

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
    options.onChunk({ kind: 'raw_error', message: msg })
  }
  if (chunkCount === 0) {
    console.warn('[bond] query completed with no chunks emitted')
  }

  return succeeded
}
