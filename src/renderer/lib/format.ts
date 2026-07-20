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

/**
 * The MCP proxy tool's identity lives in its input, not its name — every call
 * is `mcp`, so an unlabelled row would read "mcp {server: …}".
 */
function formatMcpLabel(input?: Record<string, unknown>): string {
  const server = typeof input?.server === 'string' ? input.server : ''
  const tool = typeof input?.tool === 'string' ? input.tool : ''
  const action = typeof input?.action === 'string' ? input.action : ''
  if (server && tool) return `${server}: ${tool}`
  if (action === 'search') return 'Searched MCP tools'
  return server ? `MCP: ${server}` : 'MCP'
}

/** Human label for a tool call, e.g. "Read useChat.ts" or "context-a8c: search_p2". */
export function formatToolLabel(name: string, summary?: string, input?: Record<string, unknown>): string {
  if (name === 'mcp') return formatMcpLabel(input)
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
  // MCP calls: the server/tool pair is the headline, the arguments the body.
  if (typeof input.server === 'string' && typeof input.tool === 'string') {
    const args = input.arguments && typeof input.arguments === 'object' ? input.arguments : {}
    try {
      return `${input.server}: ${input.tool}\n${JSON.stringify(args, null, 2)}`.slice(0, 300)
    } catch {
      return `${input.server}: ${input.tool}`
    }
  }
  try {
    return JSON.stringify(input, null, 2).slice(0, 300)
  } catch {
    return ''
  }
}
