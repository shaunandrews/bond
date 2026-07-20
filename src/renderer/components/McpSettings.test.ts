import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import McpSettings from './McpSettings.vue'

const POLICY = { trust: 'ask', read: [], write: [], alwaysAsk: [], promoted: [] }

function server(overrides: Record<string, unknown> = {}) {
  return {
    id: 'context-a8c',
    name: 'Context A8C',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'ctx'],
    enabled: true,
    policy: { ...POLICY },
    ...overrides,
  }
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    id: 'context-a8c',
    name: 'Context A8C',
    enabled: true,
    transport: 'stdio',
    state: 'connected',
    toolCount: 4,
    trust: 'ask',
    secretRefs: [],
    ...overrides,
  }
}

function toolInfo(overrides: Record<string, unknown> = {}) {
  return {
    server: 'context-a8c',
    serverName: 'Context A8C',
    name: 'search_p2',
    description: 'Search internal P2 posts',
    inputSchema: { type: 'object' },
    toolClass: 'unknown',
    suggestedClass: 'unknown',
    alwaysAsk: false,
    promoted: false,
    ...overrides,
  }
}

/** Mount with one configured server and open its detail panel. */
async function expanded(overrides: Record<string, unknown> = {}) {
  const harness = await render({
    mcpList: vi.fn().mockResolvedValue({ servers: [server()], presets: [] }),
    mcpStatus: vi.fn().mockResolvedValue({ servers: [status()] }),
    mcpListTools: vi.fn().mockResolvedValue({ tools: [toolInfo()], errors: [] }),
    ...overrides,
  })
  await harness.wrapper.find('.disclosure').trigger('click')
  await flushPromises()
  return harness
}

const preset = {
  id: 'context-a8c',
  name: 'Context A8C',
  description: 'Automattic internal context',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', 'ctx'],
}

let changedHandler: (() => void) | null = null

function mockBond(overrides: Record<string, unknown> = {}) {
  const bond = {
    mcpList: vi.fn().mockResolvedValue({ servers: [], presets: [preset] }),
    mcpStatus: vi.fn().mockResolvedValue({ servers: [] }),
    mcpAdd: vi.fn().mockResolvedValue(server()),
    mcpAddPreset: vi.fn().mockResolvedValue(server()),
    mcpUpdate: vi.fn().mockResolvedValue(server()),
    mcpRemove: vi.fn().mockResolvedValue({ ok: true }),
    mcpReconnect: vi.fn().mockResolvedValue({ ok: true }),
    mcpListTools: vi.fn().mockResolvedValue({ tools: [], errors: [] }),
    mcpSetTrust: vi.fn().mockResolvedValue(server()),
    mcpClassifyTool: vi.fn().mockResolvedValue(server()),
    mcpPromoteTool: vi.fn().mockResolvedValue(server()),
    mcpSetAlwaysAsk: vi.fn().mockResolvedValue(server()),
    mcpSetSecret: vi.fn().mockResolvedValue({ ok: true, ref: 'context-a8c-token' }),
    mcpDeleteSecret: vi.fn().mockResolvedValue({ ok: true }),
    onMcpChanged: vi.fn((fn: () => void) => { changedHandler = fn; return () => { changedHandler = null } }),
    ...overrides,
  }
  ;(window as any).bond = bond
  return bond
}

async function render(overrides: Record<string, unknown> = {}) {
  const bond = mockBond(overrides)
  const wrapper = mount(McpSettings)
  await flushPromises()
  return { wrapper, bond }
}

beforeEach(() => {
  changedHandler = null
})

describe('McpSettings', () => {
  it('invites a first connection when nothing is configured', async () => {
    const { wrapper } = await render()
    expect(wrapper.text()).toContain('No MCP servers connected yet.')
    expect(wrapper.text()).toContain('Automattic internal context')
  })

  it('lists configured servers with their live state and tool count', async () => {
    const { wrapper } = await render({
      mcpList: vi.fn().mockResolvedValue({ servers: [server()], presets: [preset] }),
      mcpStatus: vi.fn().mockResolvedValue({ servers: [status()] }),
    })

    expect(wrapper.text()).toContain('Context A8C')
    expect(wrapper.text()).toContain('connected')
    expect(wrapper.text()).toContain('4 tools')
    expect(wrapper.text()).toContain('npx -y ctx')
    expect(wrapper.find('.state-dot.connected').exists()).toBe(true)
  })

  it('shows the last error on a server that will not start', async () => {
    const { wrapper } = await render({
      mcpList: vi.fn().mockResolvedValue({ servers: [server()], presets: [] }),
      mcpStatus: vi.fn().mockResolvedValue({ servers: [status({ state: 'error', toolCount: 0, error: 'spawn npx ENOENT' })] }),
    })

    expect(wrapper.text()).toContain('spawn npx ENOENT')
    expect(wrapper.find('.state-dot.error').exists()).toBe(true)
  })

  it('hides a preset that is already configured', async () => {
    const { wrapper } = await render({
      mcpList: vi.fn().mockResolvedValue({ servers: [server()], presets: [preset] }),
    })
    expect(wrapper.text()).not.toContain('Automattic internal context')
  })

  it('connects a preset and reloads', async () => {
    const { wrapper, bond } = await render()

    await wrapper.findAll('button').find(button => button.text() === 'Connect')!.trigger('click')
    await flushPromises()

    expect(bond.mcpAddPreset).toHaveBeenCalledWith('context-a8c')
    expect(bond.mcpList).toHaveBeenCalledTimes(2)
  })

  it('toggles a server off', async () => {
    const { wrapper, bond } = await render({
      mcpList: vi.fn().mockResolvedValue({ servers: [server()], presets: [] }),
      mcpStatus: vi.fn().mockResolvedValue({ servers: [status()] }),
    })

    await wrapper.find('.toggle-switch').trigger('click')
    await flushPromises()

    expect(bond.mcpUpdate).toHaveBeenCalledWith('context-a8c', { enabled: false })
  })

  it('reconnects a server', async () => {
    const { wrapper, bond } = await render({
      mcpList: vi.fn().mockResolvedValue({ servers: [server()], presets: [] }),
      mcpStatus: vi.fn().mockResolvedValue({ servers: [status()] }),
    })

    await wrapper.find('[aria-label="Reconnect Context A8C"]').trigger('click')
    await flushPromises()

    expect(bond.mcpReconnect).toHaveBeenCalledWith('context-a8c')
  })

  it('needs a second click to remove a server', async () => {
    const { wrapper, bond } = await render({
      mcpList: vi.fn().mockResolvedValue({ servers: [server()], presets: [] }),
      mcpStatus: vi.fn().mockResolvedValue({ servers: [status()] }),
    })
    const removeButton = wrapper.find('[aria-label="Remove Context A8C"]')

    await removeButton.trigger('click')
    await flushPromises()
    expect(bond.mcpRemove).not.toHaveBeenCalled()

    await removeButton.trigger('click')
    await flushPromises()
    expect(bond.mcpRemove).toHaveBeenCalledWith('context-a8c')
  })

  it('adds a server from pasted JSON', async () => {
    const { wrapper, bond } = await render()

    await wrapper.findAll('button').find(button => button.text() === 'Add from JSON')!.trigger('click')
    await wrapper.find('textarea').setValue('{"id":"custom","command":"node","args":["s.js"]}')
    await wrapper.findAll('button').find(button => button.text() === 'Add server')!.trigger('click')
    await flushPromises()

    expect(bond.mcpAdd).toHaveBeenCalledWith({ id: 'custom', command: 'node', args: ['s.js'] })
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('reports invalid JSON without calling the daemon', async () => {
    const { wrapper, bond } = await render()

    await wrapper.findAll('button').find(button => button.text() === 'Add from JSON')!.trigger('click')
    await wrapper.find('textarea').setValue('{ nope')
    await wrapper.findAll('button').find(button => button.text() === 'Add server')!.trigger('click')
    await flushPromises()

    expect(bond.mcpAdd).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain("isn't valid JSON")
  })

  it('surfaces a daemon rejection instead of failing silently', async () => {
    const { wrapper, bond } = await render({
      mcpAddPreset: vi.fn().mockRejectedValue(new Error('An MCP server called "context-a8c" already exists.')),
    })

    await wrapper.findAll('button').find(button => button.text() === 'Connect')!.trigger('click')
    await flushPromises()

    expect(bond.mcpAddPreset).toHaveBeenCalled()
    expect(wrapper.text()).toContain('already exists')
  })

  it('reloads when another window changes the MCP config', async () => {
    const { bond } = await render()

    changedHandler?.()
    await flushPromises()

    expect(bond.mcpList).toHaveBeenCalledTimes(2)
  })

  it('drops its subscription on unmount', async () => {
    const { wrapper } = await render()
    wrapper.unmount()
    expect(changedHandler).toBeNull()
  })
})

describe('McpSettings — trust policy', () => {
  it('loads the server catalog when a row is expanded', async () => {
    const { wrapper, bond } = await expanded()

    expect(bond.mcpListTools).toHaveBeenCalledWith('context-a8c')
    expect(wrapper.text()).toContain('search_p2')
    expect(wrapper.text()).toContain('Search internal P2 posts')
  })

  it('explains what the current trust level actually does', async () => {
    const { wrapper } = await expanded()
    expect(wrapper.text()).toContain('Every call asks you first.')
  })

  it('tells a trusted server with nothing classified that nothing runs unasked', async () => {
    const { wrapper } = await expanded({
      mcpList: vi.fn().mockResolvedValue({ servers: [server({ policy: { ...POLICY, trust: 'trusted' } })], presets: [] }),
    })
    expect(wrapper.text()).toContain('Nothing runs unasked yet')
  })

  it('counts the confirmed read-only tools on a trusted server', async () => {
    const { wrapper } = await expanded({
      mcpList: vi.fn().mockResolvedValue({ servers: [server({ policy: { ...POLICY, trust: 'trusted', read: ['search_p2'] } })], presets: [] }),
    })
    expect(wrapper.text()).toContain('1 read-only tool runs without asking')
  })

  it('changes trust through the daemon', async () => {
    const { wrapper, bond } = await expanded()

    const select = wrapper.findAllComponents({ name: 'BondSelect' })[0]
    select.vm.$emit('update:modelValue', 'trusted')
    await flushPromises()

    expect(bond.mcpSetTrust).toHaveBeenCalledWith('context-a8c', 'trusted')
  })

  it('classifies a tool and refreshes the catalog', async () => {
    const { wrapper, bond } = await expanded()

    const toolSelect = wrapper.findAllComponents({ name: 'BondSelect' })[1]
    toolSelect.vm.$emit('update:modelValue', 'read')
    await flushPromises()

    expect(bond.mcpClassifyTool).toHaveBeenCalledWith('context-a8c', 'search_p2', 'read')
    expect(bond.mcpListTools).toHaveBeenCalledTimes(2)
  })

  // Server annotations are a suggestion a human confirms, never a classification.
  it('surfaces the server hint as something to confirm', async () => {
    const { wrapper } = await expanded({
      mcpListTools: vi.fn().mockResolvedValue({ tools: [toolInfo({ suggestedClass: 'read' })], errors: [] }),
    })
    expect(wrapper.text()).toContain('The server says this is read-only — confirm it yourself.')
  })

  it('pins and unpins a tool', async () => {
    const { wrapper, bond } = await expanded()

    await wrapper.find('[aria-label="Pin search_p2"]').trigger('click')
    await flushPromises()
    expect(bond.mcpPromoteTool).toHaveBeenCalledWith('context-a8c', 'search_p2', true)

    const pinned = await expanded({
      mcpListTools: vi.fn().mockResolvedValue({ tools: [toolInfo({ promoted: true })], errors: [] }),
    })
    expect(pinned.wrapper.text()).toContain('pinned')
    await pinned.wrapper.find('[aria-label="Pin search_p2"]').trigger('click')
    await flushPromises()
    expect(pinned.bond.mcpPromoteTool).toHaveBeenCalledWith('context-a8c', 'search_p2', false)
  })

  it('toggles always-ask for a tool', async () => {
    const { wrapper, bond } = await expanded()

    await wrapper.find('[aria-label="Always ask before search_p2"]').trigger('click')
    await flushPromises()

    expect(bond.mcpSetAlwaysAsk).toHaveBeenCalledWith('context-a8c', 'search_p2', true)
  })

  it('reports a catalog that could not be loaded', async () => {
    const { wrapper } = await expanded({
      mcpListTools: vi.fn().mockResolvedValue({ tools: [], errors: [{ server: 'context-a8c', error: 'spawn npx ENOENT' }] }),
    })
    expect(wrapper.text()).toContain('spawn npx ENOENT')
  })

  it('collapses without refetching', async () => {
    const { wrapper, bond } = await expanded()

    await wrapper.find('.disclosure').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('search_p2')

    await wrapper.find('.disclosure').trigger('click')
    await flushPromises()
    expect(bond.mcpListTools).toHaveBeenCalledTimes(1)
  })
})

describe('McpSettings — http servers and tokens', () => {
  const httpServer = server({ id: 'remote', name: 'Remote', transport: 'http', url: 'https://remote.example.com/mcp', command: '', args: [] })
  const httpStatus = status({ id: 'remote', name: 'Remote', transport: 'http' })

  async function httpExpanded(overrides: Record<string, unknown> = {}) {
    const harness = await render({
      mcpList: vi.fn().mockResolvedValue({ servers: [httpServer], presets: [] }),
      mcpStatus: vi.fn().mockResolvedValue({ servers: [httpStatus] }),
      mcpListTools: vi.fn().mockResolvedValue({ tools: [], errors: [] }),
      ...overrides,
    })
    await harness.wrapper.find('.disclosure').trigger('click')
    await flushPromises()
    return harness
  }

  it('shows the endpoint url instead of a command line', async () => {
    const { wrapper } = await httpExpanded()
    expect(wrapper.text()).toContain('https://remote.example.com/mcp')
  })

  // The token goes to the Keychain; the config only ever gets the reference.
  it('stores a token in the Keychain and points the header at the reference', async () => {
    const { wrapper, bond } = await httpExpanded()

    await wrapper.findAll('button').find(button => button.text() === 'Set token')!.trigger('click')
    await wrapper.find('input[type="password"]').setValue('sk-live-123')
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()

    expect(bond.mcpSetSecret).toHaveBeenCalledWith('remote-token', 'sk-live-123')
    expect(bond.mcpUpdate).toHaveBeenCalledWith('remote', { headers: { Authorization: 'Bearer keychain:remote-token' } })
  })

  it('never renders a stored secret, only its reference', async () => {
    const { wrapper } = await httpExpanded({
      mcpStatus: vi.fn().mockResolvedValue({ servers: [status({ id: 'remote', name: 'Remote', transport: 'http', secretRefs: ['remote-token'] })] }),
    })

    expect(wrapper.text()).toContain('Stored in your Keychain as remote-token')
    expect(wrapper.find('.key-badge').exists()).toBe(true)
  })

  it('clears a token from both the config and the Keychain', async () => {
    const withToken = server({
      id: 'remote',
      name: 'Remote',
      transport: 'http',
      url: 'https://remote.example.com/mcp',
      command: '',
      args: [],
      headers: { Authorization: 'Bearer keychain:remote-token', 'X-Plain': 'keep' },
    })
    const { wrapper, bond } = await httpExpanded({
      mcpList: vi.fn().mockResolvedValue({ servers: [withToken], presets: [] }),
      mcpStatus: vi.fn().mockResolvedValue({ servers: [status({ id: 'remote', name: 'Remote', transport: 'http', secretRefs: ['remote-token'] })] }),
    })

    await wrapper.findAll('button').find(button => button.text() === 'Clear')!.trigger('click')
    await flushPromises()

    expect(bond.mcpUpdate).toHaveBeenCalledWith('remote', { headers: { 'X-Plain': 'keep' } })
    expect(bond.mcpDeleteSecret).toHaveBeenCalledWith('remote-token')
  })

  it('offers no token field for a stdio server', async () => {
    const { wrapper } = await expanded()
    expect(wrapper.findAll('button').some(button => button.text() === 'Set token')).toBe(false)
  })
})
