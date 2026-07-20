/**
 * MCP server configuration — stored as one JSON blob in the settings KV store
 * under `mcp.servers`.
 *
 * No secrets live here. Any header or env value may instead be a reference —
 * `keychain:<ref>` — which mcp/keychain.ts resolves at connect time only. A
 * config that ever holds a bare token is a bug, not a shortcut.
 */

import type { EditMode } from '../../shared/session'
import { getSetting, setSetting } from '../settings'
import { secretRefsIn } from './keychain'
import { DEFAULT_POLICY, parsePolicy, readOnlyToolNames, type McpPolicy } from './policy'

export type McpTransport = 'stdio' | 'http'

export interface McpServerConfig {
  /** Slug, unique across servers — the name the model addresses. */
  id: string
  name: string
  transport: McpTransport
  /** stdio only. */
  command: string
  args: string[]
  env?: Record<string, string>
  /** http only — the Streamable HTTP endpoint. */
  url?: string
  /** http only. Values may be `keychain:<ref>`. */
  headers?: Record<string, string>
  enabled: boolean
  policy: McpPolicy
}

export const MCP_SERVERS_SETTING = 'mcp.servers'

/** Ready-made servers offered by the UI/CLI so nobody hand-writes a command line. */
export interface McpServerPreset extends Omit<McpServerConfig, 'enabled' | 'policy'> {
  description: string
}

export const MCP_PRESETS: McpServerPreset[] = [
  {
    id: 'context-a8c',
    name: 'Context A8C',
    description: 'Automattic internal context — Linear, Slack, and P2 search. Signs in with WordPress.com on first use.',
    transport: 'stdio',
    command: 'npx',
    // Pinned: an unpinned `@latest` silently changes the tool surface mid-session.
    // Verified against npm — a version that doesn't exist fails as an opaque
    // "Connection closed" long after the user has enabled it.
    args: ['-y', '@automattic/mcp-context-a8c@0.2.2'],
  },
]

export function getPreset(id: string): McpServerPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id)
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidServerId(id: string): boolean {
  return ID_RE.test(id)
}

function sanitizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const map: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') map[key] = raw
  }
  return Object.keys(map).length ? map : undefined
}

/** http(s) only — an MCP endpoint on file:// or ws:// is a misconfiguration. */
export function isUsableMcpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Coerce one untrusted record into a config, or null when it can't be one. */
export function parseServerConfig(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!isValidServerId(id)) return null

  const command = typeof record.command === 'string' ? record.command.trim() : ''
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  // The transport is inferred when unstated so a pasted `{id, url}` just works.
  const transport: McpTransport = record.transport === 'http' || (!record.transport && url && !command) ? 'http' : 'stdio'
  if (transport === 'stdio' && !command) return null
  if (transport === 'http' && !isUsableMcpUrl(url)) return null

  return {
    id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
    transport,
    command,
    args: Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === 'string') : [],
    env: sanitizeStringMap(record.env),
    ...(transport === 'http' ? { url } : {}),
    headers: transport === 'http' ? sanitizeStringMap(record.headers) : undefined,
    // Absent means enabled — a hand-pasted JSON config shouldn't land inert.
    enabled: record.enabled === undefined ? true : record.enabled !== false,
    policy: parsePolicy(record.policy),
  }
}

/** Every configured server. Garbage in the settings row degrades to an empty list. */
export function getMcpServers(): McpServerConfig[] {
  try {
    const raw = getSetting(MCP_SERVERS_SETTING)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const servers: McpServerConfig[] = []
    const seen = new Set<string>()
    for (const entry of parsed) {
      const config = parseServerConfig(entry)
      if (!config || seen.has(config.id)) continue
      seen.add(config.id)
      servers.push(config)
    }
    return servers
  } catch {
    return []
  }
}

export function getEnabledMcpServers(): McpServerConfig[] {
  return getMcpServers().filter((server) => server.enabled)
}

export function setMcpServers(servers: McpServerConfig[]): void {
  setSetting(MCP_SERVERS_SETTING, JSON.stringify(servers))
}

export function getMcpServer(id: string): McpServerConfig | undefined {
  return getMcpServers().find((server) => server.id === id)
}

/** Every Keychain reference a server points at — names only, never values. */
export function serverSecretRefs(config: McpServerConfig): string[] {
  return [...new Set([...secretRefsIn(config.headers), ...secretRefsIn(config.env)])]
}

/**
 * Whether the `mcp` proxy tool should exist at all this turn. Only readonly
 * sessions can answer "no": there, the proxy is pointless (and misleading)
 * unless a human has confirmed at least one read-only tool somewhere.
 */
export function mcpProxyAvailable(editMode: EditMode): boolean {
  if (editMode.type !== 'readonly') return true
  return getEnabledMcpServers().some((server) => readOnlyToolNames(server.policy).length > 0)
}

export class McpConfigError extends Error {}

/** Add a server. Throws McpConfigError on a duplicate or unusable config. */
export function addMcpServer(input: unknown): McpServerConfig {
  const config = parseServerConfig(input)
  if (!config) {
    throw new McpConfigError('An MCP server needs a slug id (a-z0-9-) plus either a command (stdio) or an http(s) url.')
  }
  const servers = getMcpServers()
  if (servers.some((server) => server.id === config.id)) {
    throw new McpConfigError(`An MCP server called "${config.id}" already exists.`)
  }
  setMcpServers([...servers, config])
  return config
}

export type McpServerUpdates = Partial<Omit<McpServerConfig, 'id'>>

/** Patch a server in place. Returns null when the id is unknown. */
export function updateMcpServer(id: string, updates: McpServerUpdates): McpServerConfig | null {
  const servers = getMcpServers()
  const index = servers.findIndex((server) => server.id === id)
  if (index === -1) return null
  const merged = parseServerConfig({ ...servers[index], ...updates, id })
  if (!merged) throw new McpConfigError('Those updates would leave the server without a command or a usable url.')
  servers[index] = merged
  setMcpServers(servers)
  return merged
}

/** Patch just the trust policy — the common write once a server exists. */
export function updateMcpPolicy(id: string, updates: Partial<McpPolicy>): McpServerConfig | null {
  const current = getMcpServer(id)
  if (!current) return null
  return updateMcpServer(id, { policy: { ...current.policy, ...updates } })
}

/**
 * Move one tool between classifications. `'unknown'` clears it back to
 * "ask every time", which is what an uncertain human should pick.
 */
export function classifyMcpTool(id: string, tool: string, toolClass: 'read' | 'write' | 'unknown'): McpServerConfig | null {
  const current = getMcpServer(id)
  if (!current) return null
  const read = current.policy.read.filter((name) => name !== tool)
  const write = current.policy.write.filter((name) => name !== tool)
  if (toolClass === 'read') read.push(tool)
  if (toolClass === 'write') write.push(tool)
  return updateMcpPolicy(id, { read, write })
}

/** Pin or unpin a tool as a first-class Pi tool. */
export function promoteMcpTool(id: string, tool: string, promoted: boolean): McpServerConfig | null {
  const current = getMcpServer(id)
  if (!current) return null
  const next = current.policy.promoted.filter((name) => name !== tool)
  if (promoted) next.push(tool)
  return updateMcpPolicy(id, { promoted: next })
}

/** Toggle "always ask" for one tool, which outranks a trusted server. */
export function setMcpAlwaysAsk(id: string, tool: string, alwaysAsk: boolean): McpServerConfig | null {
  const current = getMcpServer(id)
  if (!current) return null
  const next = current.policy.alwaysAsk.filter((name) => name !== tool)
  if (alwaysAsk) next.push(tool)
  return updateMcpPolicy(id, { alwaysAsk: next })
}

/** Remove a server. False when the id was already gone. */
export function removeMcpServer(id: string): boolean {
  const servers = getMcpServers()
  const remaining = servers.filter((server) => server.id !== id)
  if (remaining.length === servers.length) return false
  setMcpServers(remaining)
  return true
}

export { DEFAULT_POLICY }
export type { McpPolicy }
