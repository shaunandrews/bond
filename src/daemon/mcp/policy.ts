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

/** How a tool is classified for policy purposes. Only human choices count. */
export function classifyTool(policy: McpPolicy, toolName: string): McpToolClass {
  if (policy.read.includes(toolName)) return 'read'
  if (policy.write.includes(toolName)) return 'write'
  return 'unknown'
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
}): McpDecision {
  const { editMode, policy, toolName } = input
  if (policy.trust === 'disabled') {
    return { kind: 'block', reason: `The MCP server is set to "never run" — change it in Settings → MCP connections.` }
  }

  const toolClass = classifyTool(policy, toolName)
  const alwaysAsk = policy.alwaysAsk.includes(toolName)

  if (editMode.type === 'readonly') {
    if (toolClass !== 'read') {
      return { kind: 'block', reason: `This session is read-only and "${toolName}" is not a confirmed read-only tool.` }
    }
    return alwaysAsk ? { kind: 'ask' } : { kind: 'allow' }
  }

  if (policy.trust === 'ask' || alwaysAsk || toolClass === 'unknown') return { kind: 'ask' }
  if (toolClass === 'read') return { kind: 'allow' }
  // 'write' on a trusted server: full is a standing approval, scoped is not.
  return editMode.type === 'full' ? { kind: 'allow' } : { kind: 'ask' }
}

/** Tools a readonly session may see at all — confirmed reads on a non-disabled server. */
export function readOnlyToolNames(policy: McpPolicy): string[] {
  return policy.trust === 'disabled' ? [] : [...policy.read]
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
