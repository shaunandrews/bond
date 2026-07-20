import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_POLICY } from './policy'

const store = new Map<string, string>()

vi.mock('../settings', () => ({
  getSetting: (key: string) => store.get(key) ?? null,
  setSetting: (key: string, value: string) => { store.set(key, value); return true },
}))

const {
  MCP_PRESETS,
  MCP_SERVERS_SETTING,
  McpConfigError,
  addMcpServer,
  classifyMcpTool,
  getEnabledMcpServers,
  getMcpServer,
  getMcpServers,
  getPreset,
  isUsableMcpUrl,
  isValidServerId,
  mcpProxyAvailable,
  parseServerConfig,
  promoteMcpTool,
  removeMcpServer,
  serverSecretRefs,
  setMcpAlwaysAsk,
  setMcpServers,
  updateMcpPolicy,
  updateMcpServer,
} = await import('./config')

beforeEach(() => {
  store.clear()
})

function stdio(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: id, transport: 'stdio' as const, command: 'npx', args: ['-y', `${id}-server`], enabled: true, ...overrides }
}

function http(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: id, transport: 'http' as const, url: `https://${id}.example.com/mcp`, enabled: true, ...overrides }
}

describe('parseServerConfig — stdio', () => {
  it('accepts a well-formed config', () => {
    expect(parseServerConfig(stdio('context-a8c'))).toEqual({
      id: 'context-a8c',
      name: 'context-a8c',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'context-a8c-server'],
      env: undefined,
      headers: undefined,
      enabled: true,
      policy: DEFAULT_POLICY,
    })
  })

  it('rejects a missing command or a bad id', () => {
    expect(parseServerConfig({ id: 'ok', command: '' })).toBeNull()
    expect(parseServerConfig({ id: 'Bad Id', command: 'npx' })).toBeNull()
    expect(parseServerConfig({ id: '-leading', command: 'npx' })).toBeNull()
    expect(parseServerConfig('nope')).toBeNull()
    expect(parseServerConfig(null)).toBeNull()
  })

  it('defaults enabled to true and drops non-string args and env values', () => {
    const config = parseServerConfig({ id: 'x', command: 'node', args: ['a', 7, null], env: { KEY: 'v', BAD: 3 } })
    expect(config).toMatchObject({ enabled: true, args: ['a'], env: { KEY: 'v' } })
  })

  it('falls back to the id for a blank name', () => {
    expect(parseServerConfig({ id: 'srv', name: '   ', command: 'node' })?.name).toBe('srv')
  })
})

describe('parseServerConfig — http', () => {
  it('accepts an http server with headers', () => {
    expect(parseServerConfig(http('remote', { headers: { Authorization: 'keychain:remote-token' } }))).toMatchObject({
      transport: 'http',
      url: 'https://remote.example.com/mcp',
      headers: { Authorization: 'keychain:remote-token' },
    })
  })

  it('infers the http transport from a url with no command', () => {
    expect(parseServerConfig({ id: 'remote', url: 'https://example.com/mcp' })?.transport).toBe('http')
  })

  it('rejects a non-http url', () => {
    expect(parseServerConfig({ id: 'bad', transport: 'http', url: 'file:///etc/passwd' })).toBeNull()
    expect(parseServerConfig({ id: 'bad', transport: 'http', url: 'ws://example.com' })).toBeNull()
    expect(parseServerConfig({ id: 'bad', transport: 'http', url: 'not a url' })).toBeNull()
    expect(parseServerConfig({ id: 'bad', transport: 'http' })).toBeNull()
  })

  it('drops headers on a stdio server — they would be silently ignored', () => {
    expect(parseServerConfig(stdio('x', { headers: { Authorization: 'secret' } }))?.headers).toBeUndefined()
  })
})

describe('isUsableMcpUrl', () => {
  it('accepts http(s) only', () => {
    expect(isUsableMcpUrl('https://example.com/mcp')).toBe(true)
    expect(isUsableMcpUrl('http://localhost:3000/mcp')).toBe(true)
    expect(isUsableMcpUrl('file:///tmp/x')).toBe(false)
    expect(isUsableMcpUrl('')).toBe(false)
  })
})

describe('isValidServerId', () => {
  it('allows lowercase slugs only', () => {
    expect(isValidServerId('context-a8c')).toBe(true)
    expect(isValidServerId('a')).toBe(true)
    expect(isValidServerId('Context')).toBe(false)
    expect(isValidServerId('has space')).toBe(false)
    expect(isValidServerId('')).toBe(false)
  })
})

describe('storage round-trip', () => {
  it('persists and reads back servers', () => {
    setMcpServers([parseServerConfig(stdio('one'))!, parseServerConfig(stdio('two', { enabled: false }))!])
    expect(getMcpServers().map((s) => s.id)).toEqual(['one', 'two'])
    expect(getEnabledMcpServers().map((s) => s.id)).toEqual(['one'])
    expect(getMcpServer('two')?.enabled).toBe(false)
    expect(getMcpServer('missing')).toBeUndefined()
  })

  it('tolerates unparseable and non-array settings rows', () => {
    store.set(MCP_SERVERS_SETTING, '{not json')
    expect(getMcpServers()).toEqual([])
    store.set(MCP_SERVERS_SETTING, '{"servers":[]}')
    expect(getMcpServers()).toEqual([])
  })

  it('skips unusable entries and duplicate ids instead of failing the whole list', () => {
    store.set(MCP_SERVERS_SETTING, JSON.stringify([stdio('good'), { id: 'broken' }, stdio('good', { command: 'other' })]))
    expect(getMcpServers().map((s) => s.id)).toEqual(['good'])
    expect(getMcpServers()[0].command).toBe('npx')
  })

  it('returns an empty list when nothing is configured', () => {
    expect(getMcpServers()).toEqual([])
  })

  it('gives every stored server a policy, even one written before policies existed', () => {
    store.set(MCP_SERVERS_SETTING, JSON.stringify([{ id: 'legacy', command: 'node', args: [] }]))
    expect(getMcpServer('legacy')?.policy).toEqual(DEFAULT_POLICY)
  })
})

describe('add / update / remove', () => {
  it('adds a server', () => {
    expect(addMcpServer(stdio('one')).id).toBe('one')
    expect(getMcpServers()).toHaveLength(1)
  })

  it('rejects a duplicate id', () => {
    addMcpServer(stdio('one'))
    expect(() => addMcpServer(stdio('one'))).toThrow(McpConfigError)
  })

  it('rejects an unusable config', () => {
    expect(() => addMcpServer({ id: 'one' })).toThrow(/command \(stdio\) or an http\(s\) url/)
  })

  it('patches fields in place and keeps the id', () => {
    addMcpServer(stdio('one'))
    const updated = updateMcpServer('one', { enabled: false, name: 'One Server' })
    expect(updated).toMatchObject({ id: 'one', enabled: false, name: 'One Server', command: 'npx' })
    expect(getMcpServer('one')?.enabled).toBe(false)
  })

  it('returns null when updating an unknown server', () => {
    expect(updateMcpServer('ghost', { enabled: false })).toBeNull()
  })

  it('refuses an update that would remove the command', () => {
    addMcpServer(stdio('one'))
    expect(() => updateMcpServer('one', { command: '' })).toThrow(McpConfigError)
  })

  it('removes a server and reports an unknown id', () => {
    addMcpServer(stdio('one'))
    expect(removeMcpServer('one')).toBe(true)
    expect(removeMcpServer('one')).toBe(false)
    expect(getMcpServers()).toEqual([])
  })
})

describe('policy writes', () => {
  beforeEach(() => {
    store.clear()
    addMcpServer(stdio('a8c'))
  })

  it('starts every server at ask-everything', () => {
    expect(getMcpServer('a8c')?.policy).toEqual(DEFAULT_POLICY)
  })

  it('sets trust', () => {
    expect(updateMcpPolicy('a8c', { trust: 'trusted' })?.policy.trust).toBe('trusted')
  })

  it('classifies a tool and moves it between buckets', () => {
    expect(classifyMcpTool('a8c', 'search_p2', 'read')?.policy).toMatchObject({ read: ['search_p2'], write: [] })
    expect(classifyMcpTool('a8c', 'search_p2', 'write')?.policy).toMatchObject({ read: [], write: ['search_p2'] })
    expect(classifyMcpTool('a8c', 'search_p2', 'unknown')?.policy).toMatchObject({ read: [], write: [] })
  })

  it('promotes and unpromotes a tool without duplicating it', () => {
    promoteMcpTool('a8c', 'search_p2', true)
    expect(promoteMcpTool('a8c', 'search_p2', true)?.policy.promoted).toEqual(['search_p2'])
    expect(promoteMcpTool('a8c', 'search_p2', false)?.policy.promoted).toEqual([])
  })

  it('toggles always-ask for one tool', () => {
    expect(setMcpAlwaysAsk('a8c', 'delete_post', true)?.policy.alwaysAsk).toEqual(['delete_post'])
    expect(setMcpAlwaysAsk('a8c', 'delete_post', false)?.policy.alwaysAsk).toEqual([])
  })

  it('returns null for policy writes against an unknown server', () => {
    expect(updateMcpPolicy('ghost', { trust: 'trusted' })).toBeNull()
    expect(classifyMcpTool('ghost', 'x', 'read')).toBeNull()
    expect(promoteMcpTool('ghost', 'x', true)).toBeNull()
    expect(setMcpAlwaysAsk('ghost', 'x', true)).toBeNull()
  })

  it('survives a round trip through storage', () => {
    classifyMcpTool('a8c', 'search_p2', 'read')
    promoteMcpTool('a8c', 'search_p2', true)
    updateMcpPolicy('a8c', { trust: 'trusted' })
    expect(getMcpServer('a8c')?.policy).toEqual({ trust: 'trusted', read: ['search_p2'], write: [], alwaysAsk: [], promoted: ['search_p2'] })
  })
})

describe('secret references', () => {
  it('reports the refs a server points at, never a value', () => {
    const config = parseServerConfig(http('remote', {
      headers: { Authorization: 'keychain:remote-token', 'X-Plain': 'not-a-secret' },
    }))!
    expect(serverSecretRefs(config)).toEqual(['remote-token'])
  })

  it('collects refs from stdio env too', () => {
    const config = parseServerConfig(stdio('local', { env: { API_KEY: 'keychain:local-key' } }))!
    expect(serverSecretRefs(config)).toEqual(['local-key'])
  })

  it('is empty when nothing is referenced', () => {
    expect(serverSecretRefs(parseServerConfig(stdio('plain'))!)).toEqual([])
  })
})

describe('mcpProxyAvailable', () => {
  it('is always true outside readonly mode', () => {
    expect(mcpProxyAvailable({ type: 'full' })).toBe(true)
    expect(mcpProxyAvailable({ type: 'scoped', allowedPaths: ['/tmp'] })).toBe(true)
  })

  it('is false in readonly until a human confirms a read-only tool', () => {
    addMcpServer(stdio('a8c'))
    expect(mcpProxyAvailable({ type: 'readonly' })).toBe(false)
    classifyMcpTool('a8c', 'search_p2', 'read')
    expect(mcpProxyAvailable({ type: 'readonly' })).toBe(true)
  })

  it('ignores read tools on a disabled or never-run server', () => {
    addMcpServer(stdio('a8c'))
    classifyMcpTool('a8c', 'search_p2', 'read')
    updateMcpServer('a8c', { enabled: false })
    expect(mcpProxyAvailable({ type: 'readonly' })).toBe(false)
    updateMcpServer('a8c', { enabled: true })
    updateMcpPolicy('a8c', { trust: 'disabled' })
    expect(mcpProxyAvailable({ type: 'readonly' })).toBe(false)
  })
})

describe('presets', () => {
  it('offers context-a8c with a pinned version', () => {
    const preset = getPreset('context-a8c')
    expect(preset).toBeDefined()
    expect(preset!.command).toBe('npx')
    expect(preset!.args.join(' ')).toMatch(/@automattic\/mcp-context-a8c@\d/)
  })

  // Regression: the preset shipped pinned to a version that was never
  // published. npx failed with ETARGET and the user saw only "Connection
  // closed" — a made-up pin is indistinguishable from a broken server.
  it('pins every preset to a version that exists on the registry', () => {
    for (const preset of MCP_PRESETS) {
      const pinned = preset.args.find((arg) => arg.includes('@') && !arg.startsWith('-'))
      expect(pinned, `${preset.id} must pin an explicit version`).toMatch(/@\d+\.\d+\.\d+$/)
    }
  })

  it('every preset parses as a config', () => {
    for (const preset of MCP_PRESETS) {
      expect(parseServerConfig({ ...preset, enabled: true })).not.toBeNull()
    }
  })

  it('returns undefined for an unknown preset', () => {
    expect(getPreset('nope')).toBeUndefined()
  })
})
