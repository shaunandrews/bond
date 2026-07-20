/**
 * MCP tool results → text the model can read.
 *
 * MCP content blocks are a small union (text, image, audio, resource link,
 * embedded resource). Bond's `mcp` tool returns text, so binary blocks become
 * honest placeholders rather than megabytes of base64 in the transcript.
 */

/** Matches web/tools.ts's per-page budget — one tool result shouldn't eat the context window. */
export const MAX_RESULT_CHARS = 20_000

export interface McpContentBlock {
  type?: string
  text?: string
  mimeType?: string
  uri?: string
  name?: string
  data?: string
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string }
  [key: string]: unknown
}

export interface McpCallResult {
  content?: McpContentBlock[]
  structuredContent?: unknown
  isError?: boolean
  [key: string]: unknown
}

function blockToText(block: McpContentBlock): string {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : ''
    case 'image':
      return `[image omitted — ${block.mimeType || 'image'}]`
    case 'audio':
      return `[audio omitted — ${block.mimeType || 'audio'}]`
    case 'resource_link':
      return `[resource link: ${block.name ? `${block.name} — ` : ''}${block.uri || 'unknown uri'}]`
    case 'resource': {
      const resource = block.resource
      if (typeof resource?.text === 'string') {
        return resource.uri ? `<resource uri="${resource.uri}">\n${resource.text}\n</resource>` : resource.text
      }
      return `[binary resource omitted: ${resource?.uri || 'unknown uri'}${resource?.mimeType ? ` — ${resource.mimeType}` : ''}]`
    }
    default:
      // Unknown block types are forward-compatible, not errors: show what's
      // readable rather than dropping the block silently.
      return typeof block.text === 'string' ? block.text : `[unsupported content block: ${block.type ?? 'untyped'}]`
  }
}

export function truncate(text: string, maxChars = MAX_RESULT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated — ${text.length} chars total]`,
    truncated: true,
  }
}

export interface FlattenedResult {
  text: string
  truncated: boolean
  isError: boolean
  structuredContent?: unknown
}

/** Flatten an MCP call result into text plus the flags Bond reports back. */
export function flattenCallResult(result: McpCallResult | undefined, maxChars = MAX_RESULT_CHARS): FlattenedResult {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const joined = blocks.map(blockToText).filter(Boolean).join('\n\n')
  const structured = result?.structuredContent
  // A content-less result falls back to its structured payload as the text —
  // in that case echoing the payload again under structuredContent is pure
  // duplication, so it's only carried when it adds something.
  const usedStructuredAsText = !joined && structured !== undefined
  const source = joined || (usedStructuredAsText ? JSON.stringify(structured, null, 2) : '[the server returned no content]')
  const { text, truncated } = truncate(source, maxChars)
  return {
    text,
    truncated,
    isError: result?.isError === true,
    ...(structured !== undefined && !usedStructuredAsText ? { structuredContent: structured } : {}),
  }
}
