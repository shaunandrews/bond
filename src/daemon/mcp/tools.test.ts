import { describe, expect, it, vi } from 'vitest'
import type { BondStreamChunk } from '../../shared/stream'
import { clearTurnApprovals, pendingApprovalTurnIds, resolveApproval } from '../approvals'
import type { EditMode } from '../../shared/session'
import type { McpCallResult } from './content'
import { McpServerError, type McpToolInfo } from './manager'
import { DEFAULT_POLICY, type McpPolicy } from './policy'
import { MCP_TOOL_NAMES, approvalTitle, createMcpExtensionFactory, promotedParameters, registerMcpTools, type McpToolOptions } from './tools'

interface RegisteredToolDef {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ details: any }>
}

function tool(info: Partial<McpToolInfo> = {}): McpToolInfo {
  return { server: 'a8c', serverName: 'Context A8C', name: 'search_p2', description: 'Search internal P2 posts', inputSchema: { type: 'object' }, ...info }
}

function setup(overrides: Partial<McpToolOptions> = {}) {
  const chunks: BondStreamChunk[] = []
  const deps = {
    searchCatalog: vi.fn(async () => ({ tools: [tool()], errors: [] as Array<{ server: string; error: string }> })),
    describeTool: vi.fn(async () => tool()),
    callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'three results' }] })),
    policyFor: vi.fn((): McpPolicy => ({ ...DEFAULT_POLICY })),
  }
  const options: McpToolOptions = {
    turnId: 'turn-1',
    onChunk: (chunk) => chunks.push(chunk),
    deps: deps as never,
    ...overrides,
  }
  const tools = new Map<string, RegisteredToolDef>()
  registerMcpTools({ registerTool: (def: RegisteredToolDef) => tools.set(def.name, def) } as never, options)
  return { mcp: tools.get('mcp')!, chunks, deps }
}

describe('registration', () => {
  it('registers exactly the exported tool name', () => {
    const names: string[] = []
    createMcpExtensionFactory({ turnId: 't', onChunk: () => {} })({ registerTool: (def: any) => names.push(def.name) } as never)
    expect(names).toEqual([...MCP_TOOL_NAMES])
  })
})

describe('search', () => {
  it('returns compact tool summaries without asking for approval', async () => {
    const { mcp, chunks, deps } = setup()

    const { details } = await mcp.execute('call-1', { action: 'search', query: 'p2' })
    expect(deps.searchCatalog).toHaveBeenCalledWith('p2', undefined)
    expect(details.tools).toEqual([{ server: 'a8c', tool: 'search_p2', description: 'Search internal P2 posts' }])
    expect(details.totalMatches).toBe(1)
    expect(chunks).toEqual([])
  })

  it('passes a server filter through', async () => {
    const { mcp, deps } = setup()
    await mcp.execute('call-1', { action: 'search', server: 'a8c' })
    expect(deps.searchCatalog).toHaveBeenCalledWith(undefined, 'a8c')
  })

  it('reports unreachable servers alongside the tools that did load', async () => {
    const { mcp, deps } = setup()
    deps.searchCatalog.mockResolvedValueOnce({ tools: [tool()], errors: [{ server: 'broken', error: 'spawn ENOENT' }] })

    const { details } = await mcp.execute('call-1', { action: 'search' })
    expect(details.tools).toHaveLength(1)
    expect(details.unavailableServers).toEqual([{ server: 'broken', error: 'spawn ENOENT' }])
  })

  it('explains an empty catalog rather than looking broken', async () => {
    const { mcp, deps } = setup()
    deps.searchCatalog.mockResolvedValueOnce({ tools: [], errors: [] })

    const { details } = await mcp.execute('call-1', { action: 'search' })
    expect(details.tools).toEqual([])
    expect(details.note).toContain('MCP servers connected')
  })
})

describe('describe', () => {
  it('returns the full input schema without asking for approval', async () => {
    const { mcp, chunks } = setup()

    const { details } = await mcp.execute('call-1', { action: 'describe', server: 'a8c', tool: 'search_p2' })
    expect(details).toMatchObject({ server: 'a8c', tool: 'search_p2', inputSchema: { type: 'object' } })
    expect(chunks).toEqual([])
  })

  it('returns a structured error for an unknown tool', async () => {
    const { mcp, deps } = setup()
    deps.describeTool.mockRejectedValueOnce(new McpServerError('a8c', 'no tool called "nope"'))

    const { details } = await mcp.execute('call-1', { action: 'describe', server: 'a8c', tool: 'nope' })
    expect(details.error).toContain('no tool called')
  })

  it('asks for the missing identifiers instead of guessing', async () => {
    const { mcp, deps } = setup()
    const { details } = await mcp.execute('call-1', { action: 'describe', server: 'a8c' })
    expect(details.error).toContain('"server" and "tool"')
    expect(deps.describeTool).not.toHaveBeenCalled()
  })
})

describe('call approval', () => {
  it('parks an approval and blocks until a human answers', async () => {
    const { mcp, chunks, deps } = setup({ turnId: 'turn-approve' })

    const pending = mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2', arguments: { query: 'design' } })
    await vi.waitFor(() => expect(chunks).toHaveLength(1))

    const chunk = chunks[0]
    expect(chunk).toMatchObject({
      kind: 'tool_approval',
      toolName: 'mcp',
      title: 'Allow a8c: search_p2?',
      input: { server: 'a8c', tool: 'search_p2', arguments: { query: 'design' } },
    })
    expect(deps.callTool).not.toHaveBeenCalled()
    expect(pendingApprovalTurnIds()).toContain('turn-approve')

    resolveApproval((chunk as { requestId: string }).requestId, true)
    const { details } = await pending
    expect(deps.callTool).toHaveBeenCalledWith('a8c', 'search_p2', { query: 'design' }, undefined)
    expect(details).toMatchObject({ approved: true, isError: false, result: 'three results' })
  })

  it('returns a denied result and never calls the server', async () => {
    const { mcp, chunks, deps } = setup()

    const pending = mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2' })
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    resolveApproval((chunks[0] as { requestId: string }).requestId, false)

    const { details } = await pending
    expect(details).toMatchObject({ approved: false })
    expect(details.error).toContain('denied')
    expect(deps.callTool).not.toHaveBeenCalled()
  })

  it('an aborted turn clears the prompt and denies the call', async () => {
    const { mcp, chunks, deps } = setup({ turnId: 'turn-abort' })

    const pending = mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2' })
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    clearTurnApprovals('turn-abort')

    expect((await pending).details.approved).toBe(false)
    expect(deps.callTool).not.toHaveBeenCalled()
  })

  it('uses arguments edited by the approver', async () => {
    const { mcp, deps } = setup({
      requestApproval: async () => ({ approved: true, input: { arguments: { query: 'edited' } } }),
    })

    await mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2', arguments: { query: 'original' } })
    expect(deps.callTool).toHaveBeenCalledWith('a8c', 'search_p2', { query: 'edited' }, undefined)
  })

  it('titles the prompt with the server and tool', () => {
    expect(approvalTitle('context-a8c', 'search_p2')).toBe('Allow context-a8c: search_p2?')
  })
})

describe('call results', () => {
  const approved: Partial<McpToolOptions> = { requestApproval: async () => ({ approved: true }) }

  it('prefers Pi\'s per-call abort signal over the turn-wide one', async () => {
    const turnSignal = new AbortController().signal
    const callSignal = new AbortController().signal
    const { mcp, deps } = setup({ ...approved, abortSignal: turnSignal })

    await mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2' }, callSignal)
    expect(deps.callTool).toHaveBeenCalledWith('a8c', 'search_p2', {}, callSignal)
  })

  it('falls back to the turn abort signal when Pi supplies none', async () => {
    const abortSignal = new AbortController().signal
    const { mcp, deps } = setup({ ...approved, abortSignal })

    await mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2' })
    expect(deps.callTool).toHaveBeenCalledWith('a8c', 'search_p2', {}, abortSignal)
  })

  it('reports a down server as a result, not a thrown error', async () => {
    const { mcp, deps } = setup(approved)
    deps.callTool.mockRejectedValueOnce(new McpServerError('a8c', 'spawn npx ENOENT'))

    const { details } = await mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2' })
    expect(details.error).toContain('could not run search_p2')
    expect(details.error).toContain('ENOENT')
  })

  it('flattens an isError result without throwing', async () => {
    const { mcp, deps } = setup(approved)
    deps.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'rate limited' }], isError: true })

    const { details } = await mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2' })
    expect(details).toMatchObject({ isError: true, result: 'rate limited' })
  })

  it('truncates an oversized result', async () => {
    const { mcp, deps } = setup({ ...approved, maxResultChars: 500 })
    deps.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'z'.repeat(5_000) }] })

    const { details } = await mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2' })
    expect(details.truncated).toBe(true)
    expect(details.result.length).toBeLessThan(600)
  })

  it('needs both server and tool before prompting anyone', async () => {
    const requestApproval = vi.fn()
    const { mcp } = setup({ requestApproval: requestApproval as never })

    const { details } = await mcp.execute('call-1', { action: 'call', tool: 'search_p2' })
    expect(details.error).toContain('"server" and "tool"')
    expect(requestApproval).not.toHaveBeenCalled()
  })
})

describe('policy gate', () => {
  const FULL: EditMode = { type: 'full' }
  const SCOPED: EditMode = { type: 'scoped', allowedPaths: ['/tmp'] }
  const READONLY: EditMode = { type: 'readonly' }

  function withPolicy(policy: Partial<McpPolicy>, editMode: EditMode = FULL) {
    const harness = setup({ editMode })
    harness.deps.policyFor.mockReturnValue({ ...DEFAULT_POLICY, ...policy })
    return harness
  }

  async function call(harness: ReturnType<typeof setup>) {
    return await harness.mcp.execute('call-1', { action: 'call', server: 'a8c', tool: 'search_p2' })
  }

  it('runs a trusted read with no prompt at all', async () => {
    const harness = withPolicy({ trust: 'trusted', read: ['search_p2'] })

    const { details } = await call(harness)
    expect(harness.chunks).toEqual([])
    expect(details).toMatchObject({ approved: true, autoApproved: true, result: 'three results' })
    expect(harness.deps.callTool).toHaveBeenCalled()
  })

  it('still prompts for a trusted write in scoped mode', async () => {
    const harness = withPolicy({ trust: 'trusted', write: ['search_p2'] }, SCOPED)

    const pending = call(harness)
    await vi.waitFor(() => expect(harness.chunks).toHaveLength(1))
    resolveApproval((harness.chunks[0] as { requestId: string }).requestId, true)
    expect((await pending).details.autoApproved).toBe(false)
  })

  it('blocks everything on a server set to never run', async () => {
    const harness = withPolicy({ trust: 'disabled', read: ['search_p2'] })

    const { details } = await call(harness)
    expect(details).toMatchObject({ approved: false })
    expect(details.error).toContain('never run')
    expect(harness.deps.callTool).not.toHaveBeenCalled()
    expect(harness.chunks).toEqual([])
  })

  it('blocks an unclassified tool in a read-only session without prompting', async () => {
    const harness = withPolicy({ trust: 'trusted' }, READONLY)

    const { details } = await call(harness)
    expect(details.error).toContain('read-only')
    expect(harness.deps.callTool).not.toHaveBeenCalled()
    expect(harness.chunks).toEqual([])
  })

  it('runs a confirmed read in a read-only session', async () => {
    const harness = withPolicy({ read: ['search_p2'] }, READONLY)

    expect((await call(harness)).details).toMatchObject({ approved: true, autoApproved: true })
  })

  it('honours always-ask over trust', async () => {
    const harness = withPolicy({ trust: 'trusted', read: ['search_p2'], alwaysAsk: ['search_p2'] })

    const pending = call(harness)
    await vi.waitFor(() => expect(harness.chunks).toHaveLength(1))
    resolveApproval((harness.chunks[0] as { requestId: string }).requestId, true)
    await pending
  })

  it('leaves search and describe ungated — they touch no server state', async () => {
    const harness = withPolicy({ trust: 'disabled' })

    expect((await harness.mcp.execute('c', { action: 'search' })).details.tools).toHaveLength(1)
    expect((await harness.mcp.execute('c', { action: 'describe', server: 'a8c', tool: 'search_p2' })).details.tool).toBe('search_p2')
  })
})

describe('promoted tools', () => {
  function promotedSetup(overrides: Partial<McpToolOptions> = {}) {
    const chunks: BondStreamChunk[] = []
    const deps = {
      searchCatalog: vi.fn(async () => ({ tools: [tool()], errors: [] as Array<{ server: string; error: string }> })),
      describeTool: vi.fn(async () => tool()),
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'three results' }] })),
      policyFor: vi.fn((): McpPolicy => ({ ...DEFAULT_POLICY, trust: 'trusted', read: ['search_p2'], promoted: ['search_p2'] })),
    }
    const tools = new Map<string, RegisteredToolDef>()
    registerMcpTools({ registerTool: (def: RegisteredToolDef) => tools.set(def.name, def) } as never, {
      turnId: 'turn-1',
      onChunk: (chunk) => chunks.push(chunk),
      deps: deps as never,
      promoted: [{ server: 'a8c', tool: 'search_p2', piName: 'mcp__a8c__search_p2', info: tool() }],
      ...overrides,
    })
    return { tools, chunks, deps }
  }

  it('registers a pinned tool alongside the proxy', () => {
    const { tools } = promotedSetup()
    expect([...tools.keys()].sort()).toEqual(['mcp', 'mcp__a8c__search_p2'])
  })

  it('runs through the same policy gate as the proxy', async () => {
    const { tools, deps, chunks } = promotedSetup()

    const { details } = await tools.get('mcp__a8c__search_p2')!.execute('c', { query: 'design' })
    expect(deps.callTool).toHaveBeenCalledWith('a8c', 'search_p2', { query: 'design' }, undefined)
    expect(details).toMatchObject({ approved: true, autoApproved: true })
    expect(chunks).toEqual([])
  })

  it('prompts when the policy says ask, exactly like the proxy', async () => {
    const { tools, chunks, deps } = promotedSetup()
    deps.policyFor.mockReturnValue({ ...DEFAULT_POLICY })

    const pending = tools.get('mcp__a8c__search_p2')!.execute('c', {})
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    expect(chunks[0]).toMatchObject({ kind: 'tool_approval', title: 'Allow a8c: search_p2?' })
    resolveApproval((chunks[0] as { requestId: string }).requestId, false)
    expect((await pending).details.approved).toBe(false)
  })

  it('reports a down server as a result rather than throwing', async () => {
    const { tools, deps } = promotedSetup()
    deps.callTool.mockRejectedValueOnce(new McpServerError('a8c', 'connection lost'))

    expect((await tools.get('mcp__a8c__search_p2')!.execute('c', {})).details.error).toContain('connection lost')
  })

  it('registers only the proxy when nothing is pinned', () => {
    const { tools } = promotedSetup({ promoted: [] })
    expect([...tools.keys()]).toEqual(['mcp'])
  })
})

describe('promotedParameters', () => {
  it('passes an object schema through unchanged', () => {
    const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    expect(promotedParameters(schema)).toBe(schema)
  })

  // A server that reports a non-object (or missing) schema must still yield a
  // registrable tool rather than crashing the whole extension.
  it('falls back to a free-form object for anything else', () => {
    for (const bad of [undefined, null, 'nope', { type: 'string' }, 42]) {
      expect(promotedParameters(bad)).toMatchObject({ type: 'object' })
    }
  })
})
