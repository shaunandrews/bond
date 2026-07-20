/**
 * One MCP server connection.
 *
 * A thin wrapper over the official SDK's Client + StdioClientTransport that
 * exposes only what Bond's manager needs (list, call, close) and keeps the
 * last lines of stderr around — a stdio server that fails to authenticate
 * says so on stderr and nowhere else.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig } from './config'
import type { McpCallResult } from './content'
import { resolveSecrets } from './keychain'

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: Record<string, unknown>
}

export interface McpConnection {
  listTools(): Promise<McpToolDescriptor[]>
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<McpCallResult>
  /** Recent stderr from the subprocess — the only place a stdio server reports auth trouble. */
  stderr(): string
  close(): Promise<void>
}

export interface ConnectOptions {
  /** Invalidation hook for the manager's tools/list cache. */
  onToolsChanged?: () => void
  /** Fired when the transport drops so the manager can forget the connection. */
  onClose?: () => void
  /** Test seam — supply a linked InMemoryTransport instead of spawning a process. */
  transport?: Transport
  timeoutMs?: number
  /** How long to wait for a failed launch's stderr to flush before reporting. */
  drainMs?: number
}

const CONNECT_TIMEOUT_MS = 30_000
const STDERR_KEEP_CHARS = 4_000
const STDERR_DRAIN_MS = 400

function drain(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })
}

/** The last few non-empty stderr lines — the tail is where the reason lives. */
export function lastLines(text: string, count: number): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' / ')
}

const CLIENT_INFO = { name: 'bond', version: '1.0.0' }

/**
 * MCP servers are usually launched via npx/node, which the daemon can only
 * find with the user's real PATH. The daemon inherits it from the login shell
 * (see src/main/index.ts); pass it through rather than the SDK's minimal
 * default environment.
 */
export function stdioEnvironment(config: McpServerConfig, env?: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = { ...getDefaultEnvironment() }
  if (process.env.PATH) inherited.PATH = process.env.PATH
  if (process.env.HOME) inherited.HOME = process.env.HOME
  return { ...inherited, ...(env ?? config.env ?? {}) }
}

/** Build the transport for a config, resolving any Keychain references first. */
async function transportFor(config: McpServerConfig): Promise<Transport> {
  if (config.transport === 'http') {
    if (!config.url) throw new Error(`MCP server "${config.id}" has no url.`)
    const headers = await resolveSecrets(config.headers)
    return new StreamableHTTPClientTransport(new URL(config.url), {
      ...(headers ? { requestInit: { headers } } : {}),
    })
  }
  const env = await resolveSecrets(config.env)
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: stdioEnvironment(config, env),
    stderr: 'pipe',
  })
}

export async function connectMcpServer(config: McpServerConfig, options: ConnectOptions = {}): Promise<McpConnection> {
  const client = new Client(CLIENT_INFO, { capabilities: {} })

  let stderrBuffer = ''
  const transport = options.transport ?? await transportFor(config)

  if (!options.transport && transport instanceof StdioClientTransport) {
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString()}`.slice(-STDERR_KEEP_CHARS)
    })
  }

  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    options.onToolsChanged?.()
  })
  // A crashed subprocess must not leave a connection the manager still
  // believes in — the next call would hang until its own timeout.
  client.onclose = () => options.onClose?.()

  try {
    await client.connect(transport, { timeout: options.timeoutMs ?? CONNECT_TIMEOUT_MS })
  } catch (error) {
    // A failed launch says WHY on stderr and nowhere else — "npm error notarget"
    // beats "Connection closed". The buffer can lag the rejection by a tick,
    // so give it a bounded moment to flush before giving up on the detail.
    if (!stderrBuffer.trim()) await drain(options.drainMs ?? STDERR_DRAIN_MS)
    const detail = lastLines(stderrBuffer, 4)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(detail ? `${message} — ${detail}` : message)
  }

  return {
    async listTools() {
      const result = await client.listTools()
      return (result.tools ?? []) as McpToolDescriptor[]
    },
    async callTool(name, args, callOptions = {}) {
      return await client.callTool(
        { name, arguments: args },
        undefined,
        { signal: callOptions.signal },
      ) as McpCallResult
    },
    stderr() {
      return stderrBuffer.trim()
    },
    async close() {
      client.onclose = undefined
      await client.close()
    },
  }
}
