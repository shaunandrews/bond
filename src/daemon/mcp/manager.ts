/**
 * Daemon-lifetime MCP connection manager.
 *
 * Same shape as web/broker.ts: persistent daemon state fronted by a thin
 * per-turn Pi extension. Connections are lazy (nothing spawns at boot), warm
 * (they survive across turns — the whole point of a daemon owning them), and
 * contained (a server that won't start is an error string on that server, not
 * an exception that reaches the turn).
 */

import { connectMcpServer, type McpConnection } from './client'
import { getMcpServers, serverSecretRefs, type McpServerConfig } from './config'
import type { McpCallResult } from './content'
import { DEFAULT_POLICY, promotionsForEditMode, type McpPolicy, type PromotionTarget } from './policy'
import type { EditMode } from '../../shared/session'

export interface McpToolInfo {
  server: string
  serverName: string
  name: string
  description: string
  inputSchema: unknown
  /** Server-supplied hints (readOnlyHint/destructiveHint) — a suggestion, never a boundary. */
  annotations?: Record<string, unknown>
}

export type McpServerState = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error'

export interface McpServerStatus {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  state: McpServerState
  toolCount: number
  trust: McpPolicy['trust']
  /** Keychain reference NAMES this server uses — never the secrets. */
  secretRefs: string[]
  error?: string
  stderr?: string
}

export interface McpManagerDeps {
  /** All configured servers, enabled or not. */
  loadServers?: () => McpServerConfig[]
  connect?: typeof connectMcpServer
  /** Disconnect a server after this long with no use. */
  idleMs?: number
  now?: () => number
}

interface ServerEntry {
  config: McpServerConfig
  /** Config fingerprint — a changed command/args must not reuse the old subprocess. */
  signature: string
  connection: McpConnection | null
  connecting: Promise<McpConnection> | null
  tools: McpToolInfo[] | null
  error: string | null
  idleTimer: NodeJS.Timeout | null
}

const DEFAULT_IDLE_MS = 5 * 60 * 1000
/** A wedged server must not stall turn startup while its promoted schemas load. */
const PROMOTION_TIMEOUT_MS = 5_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export class McpServerError extends Error {
  constructor(public serverId: string, message: string) {
    super(message)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Config fingerprint for connection reuse. Deliberately excludes `policy`:
 * classifying a tool must not tear down a live subprocess.
 */
function signatureOf(config: McpServerConfig): string {
  return JSON.stringify([config.transport, config.command, config.args, config.env ?? null, config.url ?? null, config.headers ?? null])
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** Rank a catalog against a free-text query; empty query means "everything". */
export function matchTools(tools: McpToolInfo[], query?: string): McpToolInfo[] {
  const terms = tokenize(query ?? '')
  if (!terms.length) return tools
  return tools
    .map((tool) => {
      const name = tokenize(`${tool.server} ${tool.name}`)
      const description = tokenize(tool.description)
      let score = 0
      for (const term of terms) {
        if (name.some((token) => token.startsWith(term))) score += 3
        else if (description.some((token) => token.startsWith(term))) score += 1
      }
      return { tool, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.tool)
}

export function createMcpManager(deps: McpManagerDeps = {}) {
  const loadServers = deps.loadServers ?? getMcpServers
  const connect = deps.connect ?? connectMcpServer
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS
  const entries = new Map<string, ServerEntry>()

  function disposeEntry(entry: ServerEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    const connection = entry.connection
    entry.connection = null
    entry.connecting = null
    entry.tools = null
    if (connection) void connection.close().catch(() => { /* already gone */ })
  }

  /** Reconcile the entry table with current config; returns the live configs. */
  function syncEntries(): McpServerConfig[] {
    const configs = loadServers()
    const seen = new Set<string>()
    for (const config of configs) {
      seen.add(config.id)
      const entry = entries.get(config.id)
      const signature = signatureOf(config)
      if (!entry) {
        entries.set(config.id, { config, signature, connection: null, connecting: null, tools: null, error: null, idleTimer: null })
        continue
      }
      entry.config = config
      // An edited command line or a disabled server drops its subprocess.
      if (entry.signature !== signature || !config.enabled) {
        disposeEntry(entry)
        entry.signature = signature
        entry.error = null
      }
    }
    for (const [id, entry] of entries) {
      if (seen.has(id)) continue
      disposeEntry(entry)
      entries.delete(id)
    }
    return configs
  }

  function touch(entry: ServerEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    if (idleMs <= 0) return
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      disposeEntry(entry)
    }, idleMs)
    entry.idleTimer.unref?.()
  }

  async function ensureConnection(entry: ServerEntry): Promise<McpConnection> {
    if (entry.connection) {
      touch(entry)
      return entry.connection
    }
    if (entry.connecting) return await entry.connecting

    // Declared outside the async body on purpose: a subprocess that fails to
    // spawn closes its transport BEFORE connect() resolves, so onClose fires
    // while a `const` inside the initializer would still be in its temporal
    // dead zone — that ReferenceError escapes as an uncaught exception and
    // takes the whole daemon down. (It did.)
    let established: McpConnection | null = null
    const attempt = (async () => {
      const connection = await connect(entry.config, {
        onToolsChanged: () => { entry.tools = null },
        onClose: () => {
          // The subprocess died on its own. Forget it so the next use
          // respawns instead of talking to a closed transport.
          if (established && entry.connection === established) {
            entry.connection = null
            entry.tools = null
          }
        },
      })
      established = connection
      return connection
    })()

    entry.connecting = attempt
    try {
      const connection = await attempt
      entry.connection = connection
      entry.error = null
      touch(entry)
      return connection
    } catch (error) {
      entry.error = errorMessage(error)
      throw new McpServerError(entry.config.id, entry.error)
    } finally {
      entry.connecting = null
    }
  }

  async function toolsFor(entry: ServerEntry): Promise<McpToolInfo[]> {
    if (entry.tools) {
      touch(entry)
      return entry.tools
    }
    const connection = await ensureConnection(entry)
    try {
      const descriptors = await connection.listTools()
      entry.tools = descriptors.map((tool) => ({
        server: entry.config.id,
        serverName: entry.config.name,
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: tool.inputSchema ?? {},
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      }))
      entry.error = null
      return entry.tools
    } catch (error) {
      entry.error = errorMessage(error)
      throw new McpServerError(entry.config.id, entry.error)
    }
  }

  function entryFor(serverId: string): ServerEntry {
    syncEntries()
    const entry = entries.get(serverId)
    if (!entry) throw new McpServerError(serverId, `No MCP server called "${serverId}" is configured.`)
    if (!entry.config.enabled) throw new McpServerError(serverId, `The MCP server "${serverId}" is disabled.`)
    return entry
  }

  /**
   * Tools across every enabled server. A server that can't be reached
   * contributes an error entry, never an exception — one broken server must
   * not blind the model to the healthy ones.
   */
  async function listCatalog(): Promise<{ tools: McpToolInfo[]; errors: Array<{ server: string; error: string }> }> {
    syncEntries()
    const enabled = [...entries.values()].filter((entry) => entry.config.enabled)
    const results = await Promise.all(enabled.map(async (entry) => {
      try {
        return { tools: await toolsFor(entry), error: null }
      } catch (error) {
        return { tools: [] as McpToolInfo[], error: { server: entry.config.id, error: errorMessage(error) } }
      }
    }))
    return {
      tools: results.flatMap((result) => result.tools),
      errors: results.map((result) => result.error).filter((error): error is { server: string; error: string } => !!error),
    }
  }

  async function searchCatalog(query?: string, serverId?: string) {
    const catalog = await listCatalog()
    const scoped = serverId ? catalog.tools.filter((tool) => tool.server === serverId) : catalog.tools
    return { tools: matchTools(scoped, query), errors: catalog.errors }
  }

  async function describeTool(serverId: string, toolName: string): Promise<McpToolInfo> {
    const entry = entryFor(serverId)
    const tools = await toolsFor(entry)
    const tool = tools.find((candidate) => candidate.name === toolName)
    if (!tool) {
      throw new McpServerError(serverId, `"${serverId}" has no tool called "${toolName}". Known tools: ${tools.map((t) => t.name).join(', ') || '(none)'}`)
    }
    return tool
  }

  async function callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const entry = entryFor(serverId)
    const connection = await ensureConnection(entry)
    touch(entry)
    try {
      return await connection.callTool(toolName, args, { signal })
    } catch (error) {
      throw new McpServerError(serverId, errorMessage(error))
    }
  }

  function serverStatuses(): McpServerStatus[] {
    syncEntries()
    return [...entries.values()].map((entry) => ({
      id: entry.config.id,
      name: entry.config.name,
      enabled: entry.config.enabled,
      transport: entry.config.transport,
      state: !entry.config.enabled ? 'disabled'
        : entry.error ? 'error'
          : entry.connection ? 'connected'
            : entry.connecting ? 'connecting'
              : 'disconnected',
      toolCount: entry.tools?.length ?? 0,
      trust: entry.config.policy.trust,
      secretRefs: serverSecretRefs(entry.config),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.connection?.stderr() ? { stderr: entry.connection.stderr() } : {}),
    }))
  }

  /** The trust policy in force for a server; the default (ask-everything) when unknown. */
  function policyFor(serverId: string): McpPolicy {
    syncEntries()
    return entries.get(serverId)?.config.policy ?? { ...DEFAULT_POLICY }
  }

  /**
   * Schemas for every tool this edit mode may expose as a first-class Pi tool.
   *
   * This is the one place Bond connects before the model asks for anything —
   * a promoted tool has to carry a real schema into the prompt. It is gated
   * on an explicit user pin, bounded by a timeout, and total: a server that
   * won't answer costs its promotions, never the turn.
   */
  async function promotedToolInfos(editMode: EditMode, timeoutMs = PROMOTION_TIMEOUT_MS): Promise<Array<PromotionTarget & { info: McpToolInfo }>> {
    syncEntries()
    const targets = promotionsForEditMode([...entries.values()].map((entry) => entry.config), editMode)
    if (!targets.length) return []

    const byServer = new Map<string, PromotionTarget[]>()
    for (const target of targets) {
      byServer.set(target.server, [...(byServer.get(target.server) ?? []), target])
    }

    const resolved = await Promise.all([...byServer].map(async ([serverId, serverTargets]) => {
      const entry = entries.get(serverId)
      if (!entry) return []
      try {
        const tools = await withTimeout(toolsFor(entry), timeoutMs)
        return serverTargets.flatMap((target) => {
          const info = tools.find((tool) => tool.name === target.tool)
          return info ? [{ ...target, info }] : []
        })
      } catch {
        return []
      }
    }))
    return resolved.flat()
  }

  /** Drop one server's connection (and cached tools) so the next use reconnects. */
  function reconnect(serverId: string): void {
    const entry = entries.get(serverId)
    if (!entry) return
    disposeEntry(entry)
    entry.error = null
  }

  async function shutdown(): Promise<void> {
    const connections = [...entries.values()].map((entry) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
      const connection = entry.connection
      entry.connection = null
      entry.connecting = null
      entry.tools = null
      return connection
    }).filter((connection): connection is McpConnection => !!connection)
    entries.clear()
    await Promise.all(connections.map((connection) => connection.close().catch(() => { /* already gone */ })))
  }

  return { listCatalog, searchCatalog, describeTool, callTool, serverStatuses, policyFor, promotedToolInfos, reconnect, shutdown }
}

export type McpManager = ReturnType<typeof createMcpManager>

// --- Daemon singleton ---

let singleton: McpManager | null = null

function manager(): McpManager {
  if (!singleton) singleton = createMcpManager({ loadServers: getMcpServers })
  return singleton
}

export const listCatalog: McpManager['listCatalog'] = () => manager().listCatalog()
export const searchCatalog: McpManager['searchCatalog'] = (query, serverId) => manager().searchCatalog(query, serverId)
export const describeTool: McpManager['describeTool'] = (serverId, toolName) => manager().describeTool(serverId, toolName)
export const callTool: McpManager['callTool'] = (serverId, toolName, args, signal) => manager().callTool(serverId, toolName, args, signal)
export const serverStatuses: McpManager['serverStatuses'] = () => manager().serverStatuses()
export const policyFor: McpManager['policyFor'] = (serverId) => manager().policyFor(serverId)
export const promotedToolInfos: McpManager['promotedToolInfos'] = (editMode, timeoutMs) => manager().promotedToolInfos(editMode, timeoutMs)
export const reconnectMcpServer: McpManager['reconnect'] = (serverId) => manager().reconnect(serverId)

/** Kill every MCP subprocess. Called from the daemon's exit path. */
export async function shutdownMcp(): Promise<void> {
  if (!singleton) return
  const current = singleton
  singleton = null
  await current.shutdown()
}
