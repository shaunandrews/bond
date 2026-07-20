import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { connectMcpServer, lastLines, stdioEnvironment } from './client'
import { DEFAULT_POLICY, type McpServerConfig } from './config'

const CONFIG: McpServerConfig = {
  id: 'fixture',
  name: 'Fixture',
  transport: 'stdio',
  command: 'node',
  args: [],
  enabled: true,
  policy: { ...DEFAULT_POLICY },
}

/** A real SDK server over a linked in-memory transport pair — no subprocess. */
async function linkedServer(build: (server: McpServer) => void) {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' })
  build(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { server, clientTransport }
}

function withEcho(server: McpServer) {
  server.registerTool(
    'echo',
    { description: 'Echo a message back', inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: 'text', text: `echo: ${message}` }] }),
  )
}

describe('connectMcpServer', () => {
  it('lists the server tools with descriptions and schemas', async () => {
    const { clientTransport } = await linkedServer(withEcho)
    const connection = await connectMcpServer(CONFIG, { transport: clientTransport })

    const tools = await connection.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(tools[0].description).toBe('Echo a message back')
    expect(tools[0].inputSchema).toMatchObject({ type: 'object' })
    await connection.close()
  })

  it('calls a tool and returns its content blocks', async () => {
    const { clientTransport } = await linkedServer(withEcho)
    const connection = await connectMcpServer(CONFIG, { transport: clientTransport })

    const result = await connection.callTool('echo', { message: 'hi' })
    expect(result.content?.[0]).toMatchObject({ type: 'text', text: 'echo: hi' })
    await connection.close()
  })

  it('surfaces a tool error as an isError result rather than throwing', async () => {
    const { clientTransport } = await linkedServer((server) => {
      server.registerTool('boom', { description: 'always fails', inputSchema: {} }, async () => {
        throw new Error('server exploded')
      })
    })
    const connection = await connectMcpServer(CONFIG, { transport: clientTransport })

    const result = await connection.callTool('boom', {})
    expect(result.isError).toBe(true)
    await connection.close()
  })

  it('reports an unknown tool as an isError result', async () => {
    const { clientTransport } = await linkedServer(withEcho)
    const connection = await connectMcpServer(CONFIG, { transport: clientTransport })

    const result = await connection.callTool('missing', {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')
    await connection.close()
  })

  it('fires onToolsChanged when the server announces a new tool', async () => {
    const onToolsChanged = vi.fn()
    const { server, clientTransport } = await linkedServer(withEcho)
    const connection = await connectMcpServer(CONFIG, { transport: clientTransport, onToolsChanged })

    server.registerTool('later', { description: 'added later', inputSchema: {} }, async () => ({ content: [] }))
    server.sendToolListChanged()
    await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalled())

    expect((await connection.listTools()).map((tool) => tool.name).sort()).toEqual(['echo', 'later'])
    await connection.close()
  })

  it('fires onClose when the transport drops', async () => {
    const onClose = vi.fn()
    const { server, clientTransport } = await linkedServer(withEcho)
    await connectMcpServer(CONFIG, { transport: clientTransport, onClose })

    await server.close()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('does not fire onClose for a close we asked for', async () => {
    const onClose = vi.fn()
    const { clientTransport } = await linkedServer(withEcho)
    const connection = await connectMcpServer(CONFIG, { transport: clientTransport, onClose })

    await connection.close()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('stdioEnvironment', () => {
  it('passes the daemon PATH through so npx-launched servers resolve', () => {
    const env = stdioEnvironment(CONFIG)
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('lets per-server env win over inherited values', () => {
    const env = stdioEnvironment({ ...CONFIG, env: { PATH: '/custom/bin', TOKEN: 'abc' } })
    expect(env.PATH).toBe('/custom/bin')
    expect(env.TOKEN).toBe('abc')
  })
})

describe('failed launches', () => {
  // Regression: a preset pinned to a version that was never published failed
  // with a bare "MCP error -32000: Connection closed". The reason —
  // "npm error notarget No matching version found" — went only to stderr,
  // which was reported for connected servers and discarded for dead ones.
  it('folds the subprocess stderr into the connect error', async () => {
    const connection = connectMcpServer(
      { ...CONFIG, command: process.execPath, args: ['-e', 'console.error("npm error notarget No matching version found"); process.exit(1)'] },
      { drainMs: 500 },
    )
    await expect(connection).rejects.toThrow(/No matching version found/)
  })

  it('still reports the underlying error when the process says nothing', async () => {
    const connection = connectMcpServer(
      { ...CONFIG, command: process.execPath, args: ['-e', 'process.exit(1)'] },
      { drainMs: 50 },
    )
    await expect(connection).rejects.toThrow()
  })

  it('reports a command that does not exist at all', async () => {
    const connection = connectMcpServer({ ...CONFIG, command: '/nonexistent/binary', args: [] }, { drainMs: 50 })
    await expect(connection).rejects.toThrow(/ENOENT/)
  })
})

describe('lastLines', () => {
  it('keeps the tail, where the reason lives', () => {
    expect(lastLines('one\n\ntwo\nthree\n', 2)).toBe('two / three')
    expect(lastLines('   \n\n', 3)).toBe('')
  })
})
