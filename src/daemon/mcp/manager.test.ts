import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpManager, matchTools, McpServerError, type McpToolInfo } from './manager'
import type { McpConnection } from './client'
import { DEFAULT_POLICY, type McpServerConfig } from './config'
import type { McpPolicy } from './policy'

function config(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, name: id, transport: 'stdio', command: 'node', args: [id], enabled: true, policy: { ...DEFAULT_POLICY }, ...overrides }
}

function policy(overrides: Partial<McpPolicy> = {}): McpPolicy {
  return { ...DEFAULT_POLICY, ...overrides }
}

interface FakeServer {
  connection: McpConnection
  listTools: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  hooks: { onToolsChanged?: () => void; onClose?: () => void }
}

function fakeServer(toolNames: string[], stderr = ''): FakeServer {
  const server: Partial<FakeServer> = { hooks: {} }
  const listTools = vi.fn(async () => toolNames.map((name) => ({ name, description: `${name} does things`, inputSchema: { type: 'object' } })))
  const callTool = vi.fn(async (name: string) => ({ content: [{ type: 'text', text: `ran ${name}` }] }))
  const close = vi.fn(async () => { /* noop */ })
  server.listTools = listTools
  server.callTool = callTool
  server.close = close
  server.connection = { listTools, callTool, close, stderr: () => stderr } as unknown as McpConnection
  return server as FakeServer
}

/** A connect() that hands out per-id fake servers and counts spawns. */
function harness(servers: Record<string, FakeServer>) {
  const spawns: string[] = []
  const connect = vi.fn(async (cfg: McpServerConfig, options: { onToolsChanged?: () => void; onClose?: () => void } = {}) => {
    const server = servers[cfg.id]
    if (!server) throw new Error(`spawn ${cfg.command}: ENOENT`)
    server.hooks = options
    spawns.push(cfg.id)
    // A fresh object per spawn (sharing the same mocks) so identity checks in
    // the manager see what a real reconnect would produce.
    return { ...server.connection }
  })
  return { connect: connect as never, spawns }
}

let configs: McpServerConfig[] = []

beforeEach(() => {
  configs = []
})

afterEach(() => {
  vi.useRealTimers()
})

function manager(servers: Record<string, FakeServer>, extra: { idleMs?: number } = {}) {
  const { connect, spawns } = harness(servers)
  return {
    mcp: createMcpManager({ loadServers: () => configs, connect, idleMs: extra.idleMs ?? 0 }),
    spawns,
  }
}

describe('lazy connection', () => {
  it('spawns nothing until the catalog is asked for', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp, spawns } = manager({ alpha })

    expect(spawns).toEqual([])
    expect(mcp.serverStatuses()).toEqual([expect.objectContaining({ id: 'alpha', state: 'disconnected', toolCount: 0 })])

    const catalog = await mcp.listCatalog()
    expect(spawns).toEqual(['alpha'])
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['search'])
  })

  it('reuses one connection across turns and caches tools/list', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp, spawns } = manager({ alpha })

    await mcp.listCatalog()
    await mcp.listCatalog()
    await mcp.describeTool('alpha', 'search')

    expect(spawns).toEqual(['alpha'])
    expect(alpha.listTools).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent first uses into a single spawn', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp, spawns } = manager({ alpha })

    await Promise.all([mcp.listCatalog(), mcp.listCatalog(), mcp.callTool('alpha', 'search', {})])
    expect(spawns).toEqual(['alpha'])
  })

  it('never spawns a disabled server', async () => {
    configs = [config('alpha', { enabled: false })]
    const { mcp, spawns } = manager({ alpha: fakeServer(['search']) })

    expect((await mcp.listCatalog()).tools).toEqual([])
    expect(spawns).toEqual([])
    await expect(mcp.callTool('alpha', 'search', {})).rejects.toThrow(/disabled/)
  })
})

describe('cache invalidation', () => {
  it('refetches tools after a list_changed notification', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp } = manager({ alpha })

    await mcp.listCatalog()
    alpha.hooks.onToolsChanged?.()
    await mcp.listCatalog()

    expect(alpha.listTools).toHaveBeenCalledTimes(2)
  })

  it('respawns after the subprocess dies on its own', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp, spawns } = manager({ alpha })

    await mcp.listCatalog()
    alpha.hooks.onClose?.()
    await mcp.listCatalog()

    expect(spawns).toEqual(['alpha', 'alpha'])
  })

  it('drops the connection when the command line changes', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp, spawns } = manager({ alpha })

    await mcp.listCatalog()
    configs = [config('alpha', { args: ['alpha', '--verbose'] })]
    await mcp.listCatalog()

    expect(spawns).toEqual(['alpha', 'alpha'])
    expect(alpha.close).toHaveBeenCalled()
  })

  it('reconnect() forces the next use to respawn', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp, spawns } = manager({ alpha })

    await mcp.listCatalog()
    mcp.reconnect('alpha')
    await mcp.listCatalog()

    expect(spawns).toEqual(['alpha', 'alpha'])
  })
})

describe('idle disconnect', () => {
  it('closes an idle server and reconnects on next use', async () => {
    vi.useFakeTimers()
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp, spawns } = manager({ alpha }, { idleMs: 60_000 })

    await mcp.listCatalog()
    expect(mcp.serverStatuses()[0].state).toBe('connected')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(alpha.close).toHaveBeenCalled()
    expect(mcp.serverStatuses()[0].state).toBe('disconnected')

    await mcp.listCatalog()
    expect(spawns).toEqual(['alpha', 'alpha'])
  })

  it('keeps a server alive while it is being used', async () => {
    vi.useFakeTimers()
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp } = manager({ alpha }, { idleMs: 60_000 })

    await mcp.listCatalog()
    await vi.advanceTimersByTimeAsync(50_000)
    await mcp.callTool('alpha', 'search', {})
    await vi.advanceTimersByTimeAsync(50_000)

    expect(alpha.close).not.toHaveBeenCalled()
  })
})

describe('error containment', () => {
  it('serves healthy servers when another fails to spawn', async () => {
    configs = [config('alpha'), config('broken')]
    const alpha = fakeServer(['search'])
    const { mcp } = manager({ alpha })

    const catalog = await mcp.listCatalog()
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['search'])
    expect(catalog.errors).toEqual([{ server: 'broken', error: expect.stringContaining('ENOENT') }])
    expect(mcp.serverStatuses().find((status) => status.id === 'broken')).toMatchObject({ state: 'error' })
  })

  // Regression: a failed spawn closes the transport BEFORE connect() resolves,
  // so onClose ran against a still-uninitialized const and threw a
  // ReferenceError out of an event handler — killing the whole daemon.
  it('survives a server whose transport closes before connect resolves', async () => {
    configs = [config('flaky')]
    const connect = vi.fn(async (_cfg: McpServerConfig, options: { onClose?: () => void } = {}) => {
      options.onClose?.()
      throw new Error('spawn /nonexistent/binary ENOENT')
    })
    const mcp = createMcpManager({ loadServers: () => configs, connect: connect as never, idleMs: 0 })

    const catalog = await mcp.listCatalog()
    expect(catalog.errors).toEqual([{ server: 'flaky', error: expect.stringContaining('ENOENT') }])
    expect(mcp.serverStatuses()[0]).toMatchObject({ state: 'error' })
  })

  it('ignores a late onClose from a connection it already replaced', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp, spawns } = manager({ alpha })

    await mcp.listCatalog()
    const staleClose = alpha.hooks.onClose!
    mcp.reconnect('alpha')
    await mcp.listCatalog()
    staleClose()

    expect(spawns).toEqual(['alpha', 'alpha'])
    expect(mcp.serverStatuses()[0].state).toBe('connected')
  })

  it('throws a typed error for a call against a dead server', async () => {
    configs = [config('broken')]
    const { mcp } = manager({})

    await expect(mcp.callTool('broken', 'anything', {})).rejects.toBeInstanceOf(McpServerError)
  })

  it('throws for an unconfigured server id', async () => {
    configs = []
    const { mcp } = manager({})

    await expect(mcp.describeTool('ghost', 'x')).rejects.toThrow(/No MCP server called "ghost"/)
  })

  it('names the known tools when the requested one is missing', async () => {
    configs = [config('alpha')]
    const { mcp } = manager({ alpha: fakeServer(['search', 'fetch']) })

    await expect(mcp.describeTool('alpha', 'nope')).rejects.toThrow(/Known tools: search, fetch/)
  })

  it('wraps a failed call and keeps the connection usable', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    alpha.callTool.mockRejectedValueOnce(new Error('request timed out'))
    const { mcp } = manager({ alpha })

    await expect(mcp.callTool('alpha', 'search', {})).rejects.toThrow(/request timed out/)
    await expect(mcp.callTool('alpha', 'search', {})).resolves.toMatchObject({ content: [{ text: 'ran search' }] })
  })
})

describe('search and status', () => {
  it('ranks name matches above description matches and drops non-matches', async () => {
    const tools: McpToolInfo[] = [
      { server: 'a8c', serverName: 'A8C', name: 'fetch_page', description: 'download something', inputSchema: {} },
      { server: 'a8c', serverName: 'A8C', name: 'search_p2', description: 'search internal P2 posts', inputSchema: {} },
      { server: 'a8c', serverName: 'A8C', name: 'list_users', description: 'find people by search term', inputSchema: {} },
    ]
    expect(matchTools(tools, 'search').map((tool) => tool.name)).toEqual(['search_p2', 'list_users'])
    expect(matchTools(tools, '')).toEqual(tools)
    expect(matchTools(tools, 'nonsense')).toEqual([])
  })

  it('scopes searchCatalog to one server', async () => {
    configs = [config('alpha'), config('beta')]
    const { mcp } = manager({ alpha: fakeServer(['search']), beta: fakeServer(['search']) })

    const scoped = await mcp.searchCatalog(undefined, 'beta')
    expect(scoped.tools.map((tool) => tool.server)).toEqual(['beta'])
  })

  it('reports stderr on a connected server for diagnosing auth failures', async () => {
    configs = [config('alpha')]
    const { mcp } = manager({ alpha: fakeServer(['search'], 'not logged in to WordPress.com') })

    await mcp.listCatalog()
    expect(mcp.serverStatuses()[0]).toMatchObject({ state: 'connected', toolCount: 1, stderr: 'not logged in to WordPress.com' })
  })

  it('lists a disabled server as disabled', async () => {
    configs = [config('alpha', { enabled: false })]
    const { mcp } = manager({ alpha: fakeServer([]) })
    expect(mcp.serverStatuses()[0]).toMatchObject({ state: 'disabled', enabled: false })
  })

  it('forgets servers removed from config', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp } = manager({ alpha })

    await mcp.listCatalog()
    configs = []
    expect(mcp.serverStatuses()).toEqual([])
    expect(alpha.close).toHaveBeenCalled()
  })
})

describe('shutdown', () => {
  it('closes every live connection', async () => {
    configs = [config('alpha'), config('beta')]
    const alpha = fakeServer(['a'])
    const beta = fakeServer(['b'])
    const { mcp } = manager({ alpha, beta })

    await mcp.listCatalog()
    await mcp.shutdown()

    expect(alpha.close).toHaveBeenCalled()
    expect(beta.close).toHaveBeenCalled()
    expect(mcp.serverStatuses()).toEqual([expect.objectContaining({ state: 'disconnected' }), expect.objectContaining({ state: 'disconnected' })])
  })
})

describe('policy surface', () => {
  it('serves a server\'s policy and defaults to ask-everything for an unknown id', () => {
    configs = [config('alpha', { policy: policy({ trust: 'trusted', read: ['search'] }) })]
    const { mcp } = manager({ alpha: fakeServer(['search']) })

    expect(mcp.policyFor('alpha')).toMatchObject({ trust: 'trusted', read: ['search'] })
    expect(mcp.policyFor('ghost')).toEqual(DEFAULT_POLICY)
  })

  it('reports transport, trust, and secret refs in status', async () => {
    configs = [config('remote', {
      transport: 'http',
      url: 'https://remote.example.com/mcp',
      headers: { Authorization: 'keychain:remote-token' },
      policy: policy({ trust: 'trusted' }),
    })]
    const { mcp } = manager({ remote: fakeServer(['search']) })

    expect(mcp.serverStatuses()[0]).toMatchObject({
      transport: 'http',
      trust: 'trusted',
      secretRefs: ['remote-token'],
    })
  })

  // Classifying a tool must not tear down a live subprocess.
  it('keeps the connection when only the policy changes', async () => {
    configs = [config('alpha')]
    const alpha = fakeServer(['search'])
    const { mcp, spawns } = manager({ alpha })

    await mcp.listCatalog()
    configs = [config('alpha', { policy: policy({ trust: 'trusted', read: ['search'] }) })]
    await mcp.listCatalog()

    expect(spawns).toEqual(['alpha'])
    expect(alpha.close).not.toHaveBeenCalled()
  })

  it('drops the connection when an http url or header changes', async () => {
    configs = [config('remote', { transport: 'http', url: 'https://one.example.com/mcp' })]
    const remote = fakeServer(['search'])
    const { mcp, spawns } = manager({ remote })

    await mcp.listCatalog()
    configs = [config('remote', { transport: 'http', url: 'https://two.example.com/mcp' })]
    await mcp.listCatalog()

    expect(spawns).toEqual(['remote', 'remote'])
  })
})

describe('promotedToolInfos', () => {
  const FULL = { type: 'full' as const }
  const READONLY = { type: 'readonly' as const }

  it('is empty — and connects to nothing — when no tool is pinned', async () => {
    configs = [config('alpha')]
    const { mcp, spawns } = manager({ alpha: fakeServer(['search']) })

    expect(await mcp.promotedToolInfos(FULL)).toEqual([])
    expect(spawns).toEqual([])
  })

  it('resolves schemas for pinned tools', async () => {
    configs = [config('alpha', { policy: policy({ promoted: ['search'] }) })]
    const { mcp } = manager({ alpha: fakeServer(['search']) })

    const promoted = await mcp.promotedToolInfos(FULL)
    expect(promoted).toHaveLength(1)
    expect(promoted[0]).toMatchObject({ server: 'alpha', tool: 'search', piName: 'mcp__alpha__search' })
    expect(promoted[0].info.inputSchema).toEqual({ type: 'object' })
  })

  it('drops a pinned tool the server no longer offers', async () => {
    configs = [config('alpha', { policy: policy({ promoted: ['search', 'gone'] }) })]
    const { mcp } = manager({ alpha: fakeServer(['search']) })

    expect((await mcp.promotedToolInfos(FULL)).map((entry) => entry.tool)).toEqual(['search'])
  })

  it('exposes only confirmed reads in a readonly session', async () => {
    configs = [config('alpha', { policy: policy({ promoted: ['search', 'post'], read: ['search'], write: ['post'] }) })]
    const { mcp } = manager({ alpha: fakeServer(['search', 'post']) })

    expect((await mcp.promotedToolInfos(READONLY)).map((entry) => entry.tool)).toEqual(['search'])
  })

  // A wedged server costs its promotions, never the turn.
  it('returns nothing for an unreachable server instead of throwing', async () => {
    configs = [config('broken', { policy: policy({ promoted: ['search'] }) })]
    const { mcp } = manager({})

    await expect(mcp.promotedToolInfos(FULL)).resolves.toEqual([])
  })

  it('gives up on a server that never answers, without stalling the turn', async () => {
    configs = [config('slow', { policy: policy({ promoted: ['search'] }) })]
    const slow = fakeServer(['search'])
    slow.listTools.mockImplementation(() => new Promise(() => {}))
    const { mcp } = manager({ slow })

    await expect(mcp.promotedToolInfos(FULL, 20)).resolves.toEqual([])
  })
})
