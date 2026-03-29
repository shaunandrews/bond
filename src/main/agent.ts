import { homedir } from 'node:os'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BondStreamChunk } from '../shared/stream'
import { getSoul } from './settings'

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
  options: { abortSignal: AbortSignal; onChunk: (c: BondStreamChunk) => void; model?: string }
): Promise<void> {
  const cwd = homedir()
  const ac = new AbortController()

  const basePrompt =
    'You are Bond, a careful local assistant running on the user\'s Mac. ' +
    'You can read files with Read, search with Glob and Grep. Stay concise. ' +
    'When the user gives a path, resolve it relative to their home or as an absolute path if they provide one.'

  const soul = getSoul().trim()
  const systemPrompt = soul
    ? `${basePrompt}\n\n<soul>\n${soul}\n</soul>`
    : basePrompt

  const q = query({
    prompt,
    options: {
      abortController: ac,
      cwd,
      allowedTools: ['Read', 'Glob', 'Grep'],
      model: options.model,
      includePartialMessages: true,
      permissionMode: 'acceptEdits',
      systemPrompt,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'bond-electron/0.1.0'
      } as Record<string, string | undefined>
    }
  })

  options.abortSignal.addEventListener(
    'abort',
    () => {
      ac.abort()
      try {
        q.close()
      } catch {
        /* ignore */
      }
    },
    { once: true }
  )

  try {
    for await (const message of q) {
      if (options.abortSignal.aborted) break
      for (const chunk of bondMessageToChunks(message)) {
        options.onChunk(chunk)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    options.onChunk({ kind: 'raw_error', message: msg })
  }
}
