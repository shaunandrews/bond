import { describe, it, expect } from 'vitest'
import { formatToolLabel, formatDuration, formatApprovalInput } from './format'

describe('formatToolLabel', () => {
  it('combines the verb with the summary basename', () => {
    expect(formatToolLabel('Read', '/Users/shaun/project/useChat.ts')).toBe('Read useChat.ts')
    expect(formatToolLabel('Edit', 'src/components/App.vue')).toBe('Edited App.vue')
    expect(formatToolLabel('Write', 'notes.md')).toBe('Wrote notes.md')
  })

  it('maps known tools to verbs', () => {
    expect(formatToolLabel('Grep', 'pattern')).toBe('Searched code pattern')
    expect(formatToolLabel('WebFetch', 'https://example.com/page')).toBe('Fetched page page')
  })

  it('renders the verb only for prompt-driven tools even with a summary', () => {
    expect(formatToolLabel('Bash', 'npm run test:run')).toBe('Ran command')
    expect(formatToolLabel('Glob', '**/*.ts')).toBe('Searched files')
    expect(formatToolLabel('WebSearch', 'a very long paragraph of query text')).toBe('Searched the web')
    expect(formatToolLabel('codex_generate_image', 'a watercolor fox')).toBe('Generating image')
  })

  it('falls back to the raw tool name for unknown tools', () => {
    expect(formatToolLabel('memory_search', 'preferences')).toBe('memory_search preferences')
    expect(formatToolLabel('custom_tool')).toBe('custom_tool')
  })

  it('renders the verb only when there is no summary', () => {
    expect(formatToolLabel('Read')).toBe('Read')
    expect(formatToolLabel('Read', '')).toBe('Read')
  })

  // Every MCP call arrives as the same `mcp` tool name — the identity is in
  // the input, so an unlabelled row would read "mcp {server: …}".
  it('names the MCP server and tool instead of the proxy tool', () => {
    expect(formatToolLabel('mcp', undefined, { action: 'call', server: 'context-a8c', tool: 'search_p2' }))
      .toBe('context-a8c: search_p2')
    expect(formatToolLabel('mcp', undefined, { action: 'search', query: 'p2' })).toBe('Searched MCP tools')
    expect(formatToolLabel('mcp', undefined, { action: 'describe', server: 'context-a8c' })).toBe('MCP: context-a8c')
    expect(formatToolLabel('mcp')).toBe('MCP')
  })
})

describe('formatDuration', () => {
  it('returns briefly under one second', () => {
    expect(formatDuration(0)).toBe('briefly')
  })

  it('formats seconds', () => {
    expect(formatDuration(1)).toBe('1s')
    expect(formatDuration(45)).toBe('45s')
  })

  it('formats minutes with remainder seconds', () => {
    expect(formatDuration(75)).toBe('1m 15s')
  })

  it('drops the seconds part on exact minutes', () => {
    expect(formatDuration(120)).toBe('2m')
  })
})

describe('formatApprovalInput — MCP calls', () => {
  it('leads with the server and tool, then the arguments', () => {
    expect(formatApprovalInput({ server: 'context-a8c', tool: 'search_p2', arguments: { query: 'design' } }))
      .toBe('context-a8c: search_p2\n{\n  "query": "design"\n}')
  })

  it('handles a call with no arguments', () => {
    expect(formatApprovalInput({ server: 'a8c', tool: 'whoami' })).toBe('a8c: whoami\n{}')
  })
})

describe('formatApprovalInput', () => {
  it('prefers command over everything else', () => {
    expect(formatApprovalInput({ command: 'rm -rf build', file_path: '/tmp/x' })).toBe('rm -rf build')
  })

  it('falls back to file_path, then path', () => {
    expect(formatApprovalInput({ file_path: '/tmp/a.ts' })).toBe('/tmp/a.ts')
    expect(formatApprovalInput({ path: '/tmp/b.ts' })).toBe('/tmp/b.ts')
    expect(formatApprovalInput({ file_path: '/tmp/a.ts', path: '/tmp/b.ts' })).toBe('/tmp/a.ts')
  })

  it('ignores non-string command and path values', () => {
    expect(formatApprovalInput({ command: 42, path: true, other: 'x' }))
      .toBe(JSON.stringify({ command: 42, path: true, other: 'x' }, null, 2))
  })

  it('truncates the JSON fallback at 300 characters', () => {
    const input = { prompt: 'x'.repeat(500) }
    const result = formatApprovalInput(input)
    expect(result).toHaveLength(300)
    expect(result).toBe(JSON.stringify(input, null, 2).slice(0, 300))
  })

  it('returns an empty string when the input cannot be serialized', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatApprovalInput(circular)).toBe('')
  })
})
