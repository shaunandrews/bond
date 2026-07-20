/**
 * Per-server MCP trust policy — what runs without asking, what always asks,
 * and what a read-only session may touch at all.
 *
 * The classification is HUMAN-owned. A server's `readOnlyHint` /
 * `destructiveHint` annotations only pre-fill a suggestion: they are supplied
 * by the same third party whose tool we are deciding to run, so they are a
 * convenience, never a security boundary.
 *
 * Default policy is `trust: 'ask'` with nothing classified, which reproduces
 * M1's behaviour exactly — every call prompts — so an existing server keeps
 * behaving the way it did until a human says otherwise.
 */

import type { EditMode } from '../../shared/session'

export type McpTrust = 'ask' | 'trusted' | 'disabled'
export type McpToolClass = 'read' | 'write' | 'unknown'

export interface McpPolicy {
  trust: McpTrust
  /** Tool names a human confirmed are read-only. */
  read: string[]
  /** Tool names a human confirmed write or otherwise act. */
  write: string[]
  /** Tools that prompt even on a trusted server. */
  alwaysAsk: string[]
  /** Tools registered as first-class Pi tools instead of hiding behind the proxy. */
  promoted: string[]
}

export const DEFAULT_POLICY: McpPolicy = { trust: 'ask', read: [], write: [], alwaysAsk: [], promoted: [] }

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()).map((entry) => entry.trim()))]
}

export function parsePolicy(value: unknown): McpPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_POLICY }
  const record = value as Record<string, unknown>
  const trust = record.trust === 'trusted' || record.trust === 'disabled' ? record.trust : 'ask'
  const read = names(record.read)
  // A tool can't be both; the stricter classification wins so a stale config
  // can never widen access by accident.
  const write = names(record.write).filter((name) => !read.includes(name))
  return { trust, read, write, alwaysAsk: names(record.alwaysAsk), promoted: names(record.promoted) }
}

/** What the server's own annotations suggest — a starting point for a human. */
export function suggestToolClass(annotations: Record<string, unknown> | undefined): McpToolClass {
  if (annotations?.readOnlyHint === true) return 'read'
  if (annotations?.destructiveHint === true || annotations?.readOnlyHint === false) return 'write'
  return 'unknown'
}

// --- Sub-tool routing ---
//
// A proxy tool is one tool name fronting many operations, selected by its
// arguments: `execute-tool {provider: linear, subtool: create-issue}`. Judging
// it by tool name alone means one classification governs both reads and
// writes, so classifying it read auto-approves issue creation. Routing gives
// the policy a finer key — `linear/create-issue` — derived from the call.

export interface RouteSegment {
  name: string
  /** Other argument names carrying the same value (legacy aliases). */
  aliases: string[]
}

export type RouteSpec = RouteSegment[]

/** Rules are stored as `tool` or `tool:provider[/subtool]`. */
export const ROUTE_SEPARATOR = ':'

const MAX_ROUTE_SEGMENTS = 2
const LEGACY_ALIAS_RE = /legacy alias for [`'"]?([A-Za-z0-9_]+)/i

/**
 * Derive routing arguments from a tool's input schema: the leading string
 * properties are what select the operation, and object properties are the
 * payload passed along to it.
 *
 * A tool with no leading string properties (an ordinary `get-sum`) routes to
 * nothing and keeps behaving exactly as it did before routing existed.
 */
export function routeSpecFromSchema(schema: unknown): RouteSpec {
  if (!schema || typeof schema !== 'object') return []
  const properties = (schema as { properties?: unknown }).properties
  if (!properties || typeof properties !== 'object') return []

  const aliasOf = new Map<string, string[]>()
  const ordered: string[] = []

  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    const property = (raw ?? {}) as { type?: unknown; description?: unknown }
    if (property.type !== 'string') continue
    // "Legacy alias for `subtool`" — the same operation under another name.
    // Missing this is a real bypass: a rule on subtool would not see `tool`.
    const alias = typeof property.description === 'string' ? property.description.match(LEGACY_ALIAS_RE) : null
    if (alias) {
      aliasOf.set(alias[1], [...(aliasOf.get(alias[1]) ?? []), name])
      continue
    }
    ordered.push(name)
  }

  return ordered
    .slice(0, MAX_ROUTE_SEGMENTS)
    .map((name) => ({ name, aliases: aliasOf.get(name) ?? [] }))
}

/** Enumerated values for a routing segment, when the schema declares them. */
export function firstSegmentOptions(schema: unknown, segmentName: string): string[] {
  if (!schema || typeof schema !== 'object') return []
  const properties = (schema as { properties?: Record<string, unknown> }).properties
  const property = properties?.[segmentName] as { enum?: unknown } | undefined
  if (!Array.isArray(property?.enum)) return []
  return property.enum.filter((value): value is string => typeof value === 'string')
}

function segmentValue(segment: RouteSegment, args: Record<string, unknown>): string | null {
  for (const key of [segment.name, ...segment.aliases]) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * The route a call targets, e.g. `linear/search`. Null when the tool doesn't
 * route or the call omits its leading segment — an unroutable call on a
 * routed tool must never inherit a route-specific allowance.
 */
export function routeKeyFor(spec: RouteSpec, args: Record<string, unknown> | undefined): string | null {
  if (!spec.length) return null
  const values: string[] = []
  for (const segment of spec) {
    const value = segmentValue(segment, args ?? {})
    if (!value) break
    values.push(value)
  }
  return values.length ? values.join('/') : null
}

/** The policy key for a tool, optionally scoped to a route. */
export function policyKey(toolName: string, route?: string | null): string {
  return route ? `${toolName}${ROUTE_SEPARATOR}${route}` : toolName
}

/** Every key a call could match, most specific first. */
export function candidateKeys(toolName: string, route: string | null): string[] {
  if (!route) return [toolName]
  const parts = route.split('/')
  const keys: string[] = []
  for (let end = parts.length; end > 0; end -= 1) {
    keys.push(policyKey(toolName, parts.slice(0, end).join('/')))
  }
  keys.push(toolName)
  return keys
}

/**
 * How a call is classified. Only human choices count, and the most specific
 * rule wins: a `linear/create-issue` rule beats a `linear` rule, which beats
 * a blanket rule on the tool.
 */
export function classifyTool(policy: McpPolicy, toolName: string, route: string | null = null): McpToolClass {
  for (const key of candidateKeys(toolName, route)) {
    if (policy.read.includes(key)) return 'read'
    if (policy.write.includes(key)) return 'write'
  }
  return 'unknown'
}

/** True when any candidate key is flagged always-ask. */
export function isAlwaysAsk(policy: McpPolicy, toolName: string, route: string | null = null): boolean {
  return candidateKeys(toolName, route).some((key) => policy.alwaysAsk.includes(key))
}

export type McpDecision =
  | { kind: 'allow' }
  | { kind: 'ask' }
  | { kind: 'block'; reason: string }

/**
 * The single gate every MCP call passes through — proxy calls and promoted
 * tools alike.
 *
 * - `disabled` blocks outright.
 * - readonly sessions allow ONLY confirmed read-only tools, and never
 *   auto-allow one a human flagged alwaysAsk.
 * - `ask` (the default) prompts for everything, in every mode.
 * - `trusted` auto-allows confirmed reads everywhere and confirmed writes in
 *   full mode; scoped mode still prompts for writes because a checked
 *   boundary is its whole purpose, and `unknown` always prompts.
 */
export function decideMcpCall(input: {
  editMode: EditMode
  policy: McpPolicy
  toolName: string
  /** Sub-operation this call targets, when the tool routes (see routeKeyFor). */
  route?: string | null
}): McpDecision {
  const { editMode, policy, toolName } = input
  const route = input.route ?? null
  if (policy.trust === 'disabled') {
    return { kind: 'block', reason: `The MCP server is set to "never run" — change it in Settings → MCP connections.` }
  }

  const toolClass = classifyTool(policy, toolName, route)
  const alwaysAsk = isAlwaysAsk(policy, toolName, route)
  const label = route ? `${toolName} (${route})` : toolName

  if (editMode.type === 'readonly') {
    if (toolClass !== 'read') {
      return { kind: 'block', reason: `This session is read-only and "${label}" is not a confirmed read-only tool.` }
    }
    return alwaysAsk ? { kind: 'ask' } : { kind: 'allow' }
  }

  if (policy.trust === 'ask' || alwaysAsk || toolClass === 'unknown') return { kind: 'ask' }
  if (toolClass === 'read') return { kind: 'allow' }
  // A confirmed write ALWAYS asks, even on a trusted server in full mode.
  // Full mode is a standing approval for Bond's own workspace tools, where the
  // blast radius is this machine and git has your back. An MCP write lands in
  // someone else's system — a Linear issue, a Slack message, a Zendesk ticket
  // — with no undo, so "trusted" buys silence on reads only.
  return { kind: 'ask' }
}

/**
 * Tools a readonly session may see at all — confirmed reads on a non-disabled
 * server. A route-scoped rule (`tool:linear/search`) counts: the tool must be
 * reachable for the route to ever be used.
 */
export function readOnlyToolNames(policy: McpPolicy): string[] {
  if (policy.trust === 'disabled') return []
  return [...new Set(policy.read.map((key) => key.split(ROUTE_SEPARATOR)[0]))]
}

/** The Pi tool name a promoted MCP tool is registered under. */
export function promotedToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId.replace(/-/g, '_')}__${toolName.replace(/[^A-Za-z0-9_]/g, '_')}`
}

export interface PromotionTarget {
  server: string
  tool: string
  piName: string
}

/** Which promoted tools a given edit mode may expose. */
export function promotionsForEditMode(
  servers: Array<{ id: string; enabled: boolean; policy: McpPolicy }>,
  editMode: EditMode,
): PromotionTarget[] {
  const targets: PromotionTarget[] = []
  for (const server of servers) {
    if (!server.enabled || server.policy.trust === 'disabled') continue
    for (const tool of server.policy.promoted) {
      // A readonly session only sees confirmed reads, matching decideMcpCall
      // — a promoted tool the gate would block must not be advertised at all.
      if (editMode.type === 'readonly' && classifyTool(server.policy, tool) !== 'read') continue
      targets.push({ server: server.id, tool, piName: promotedToolName(server.id, tool) })
    }
  }
  return targets
}
