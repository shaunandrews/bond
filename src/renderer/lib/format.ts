/**
 * Shared chat formatting helpers — single source for the tool labels,
 * durations, and approval-input previews rendered by useChat's activity
 * events, MessageBubble's legacy meta rows, and ApprovalPrompt.
 */

const TOOL_VERBS: Record<string, string> = {
  Read: 'Read',
  Edit: 'Edited',
  Write: 'Wrote',
  Bash: 'Ran command',
  Glob: 'Searched files',
  Grep: 'Searched code',
  WebSearch: 'Searched the web',
  WebFetch: 'Fetched page',
  codex_generate_image: 'Generating image',
}

// Prompt-driven tools carry paragraph-length input summaries — verb only.
const VERB_ONLY_TOOLS = ['Bash', 'Glob', 'WebSearch', 'codex_generate_image']

/** Human label for a tool call, e.g. "Read useChat.ts" or "Ran command". */
export function formatToolLabel(name: string, summary?: string): string {
  const filename = summary?.split('/').pop() || summary
  const verb = TOOL_VERBS[name] ?? name
  return filename && !VERB_ONLY_TOOLS.includes(name) ? `${verb} ${filename}` : verb
}

/** Core duration phrasing: 'briefly' | '45s' | '1m 15s' | '2m'. */
export function formatDuration(sec: number): string {
  if (sec < 1) return 'briefly'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

/** Compact preview of a tool-approval input: command, then path, then truncated JSON. */
export function formatApprovalInput(input: Record<string, unknown>): string {
  const command = input.command
  if (typeof command === 'string') return command
  const path = input.file_path ?? input.path
  if (typeof path === 'string') return path
  try {
    return JSON.stringify(input, null, 2).slice(0, 300)
  } catch {
    return ''
  }
}
