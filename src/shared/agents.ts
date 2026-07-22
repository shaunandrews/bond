/**
 * Agent roster types shared by daemon, renderer, and the RPC contract.
 *
 * An agent is a specialist Bond consults for focused work. Read-only is the
 * default and remains the invariant for synchronous consultation. A bundled
 * agent may opt into durable worktree writes; that axis is enforced by the
 * async runner and never widens consult_agent.
 */

import type { ModelId } from './models'

/** 'inherit' takes the parent turn's tier. */
export type AgentModelSetting = 'inherit' | ModelId
/** 'default' leaves Pi's own default (medium); the rest map to Pi ThinkingLevel. */
export type AgentThinking = 'default' | 'low' | 'medium' | 'high' | 'max'
export type AgentReportDepth = 'full' | 'quick'
/** How eagerly Bond consults this agent without being asked. */
export type AgentPolicy = 'on-demand' | 'suggest' | 'auto'
export type AgentWorkspaceSetting = 'read-only' | 'write'

export const AGENT_MODEL_SETTINGS: AgentModelSetting[] = ['inherit', 'high', 'balanced', 'fast']
export const AGENT_THINKING_LEVELS: AgentThinking[] = ['default', 'low', 'medium', 'high', 'max']
export const AGENT_REPORT_DEPTHS: AgentReportDepth[] = ['full', 'quick']
export const AGENT_POLICIES: AgentPolicy[] = ['on-demand', 'suggest', 'auto']
export const AGENT_WORKSPACE_SETTINGS: AgentWorkspaceSetting[] = ['read-only', 'write']

/**
 * Bond tools an agent may be granted beyond the read-only base
 * (read/grep/find/ls). Write-capable tools are deliberately absent and must
 * never be added — see the read-only invariant above.
 */
export const GRANTABLE_AGENT_TOOLS = ['web_search', 'fetch_content'] as const
export type GrantableAgentTool = (typeof GRANTABLE_AGENT_TOOLS)[number]

export const AGENT_LEASH_MIN_SECONDS = 30
export const AGENT_LEASH_MAX_SECONDS = 900

export interface AgentSettings {
  model: AgentModelSetting
  thinking: AgentThinking
  report: AgentReportDepth
  policy: AgentPolicy
  /** Write is opt-in and only honored by the durable worktree runner. */
  workspace: AgentWorkspaceSetting
  /** Max consult wall-clock seconds before the session is aborted. */
  leash: number
  /** Per-agent "soul" appended to the agent's system prompt. */
  instructions: string
  tools: string[]
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  model: 'inherit',
  thinking: 'default',
  report: 'full',
  policy: 'suggest',
  workspace: 'read-only',
  leash: 300,
  instructions: '',
  tools: [],
}

export interface AgentVerbSummary {
  name: string
  description: string
}

/**
 * A deterministic evidence source run by the tool (never by the agent) and
 * injected into the consult as a labeled block. `native` runners are Bond
 * code; `shell` runners are commands from a definition file and require
 * one-time user approval before they ever execute.
 */
export interface AgentEvidenceSummary {
  name: string
  command: string
  kind: 'native' | 'shell'
  approved: boolean
}

export interface AgentSummary {
  name: string
  label: string
  role: string
  mark: string
  bio: string
  source: 'builtin' | 'user'
  sourcePath: string | null
  verbs: AgentVerbSummary[]
  evidence: AgentEvidenceSummary[]
  contextDocs: string[]
  /** Effective settings (definition defaults with the settings layer applied). */
  settings: AgentSettings
  /** Definition defaults, so the UI can offer "reset to default". */
  defaults: AgentSettings
}

/** A definition that failed validation — surfaced instead of silently skipped. */
export interface AgentProblem {
  source: string
  reason: string
}

export interface AgentRosterResult {
  agents: AgentSummary[]
  problems: AgentProblem[]
}

export function clampLeash(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_AGENT_SETTINGS.leash
  return Math.max(AGENT_LEASH_MIN_SECONDS, Math.min(AGENT_LEASH_MAX_SECONDS, Math.round(seconds)))
}

/** Narrow arbitrary persisted/user input to a valid settings object. */
export function normalizeAgentSettings(raw: unknown, defaults: AgentSettings = DEFAULT_AGENT_SETTINGS): AgentSettings {
  const value = (raw ?? {}) as Partial<AgentSettings>
  const pick = <T>(candidate: unknown, allowed: T[], fallback: T): T =>
    allowed.includes(candidate as T) ? (candidate as T) : fallback
  return {
    model: pick(value.model, AGENT_MODEL_SETTINGS, defaults.model),
    thinking: pick(value.thinking, AGENT_THINKING_LEVELS, defaults.thinking),
    report: pick(value.report, AGENT_REPORT_DEPTHS, defaults.report),
    policy: pick(value.policy, AGENT_POLICIES, defaults.policy),
    workspace: pick(value.workspace, AGENT_WORKSPACE_SETTINGS, defaults.workspace),
    leash: clampLeash(typeof value.leash === 'number' ? value.leash : defaults.leash),
    instructions: typeof value.instructions === 'string' ? value.instructions : defaults.instructions,
    tools: Array.isArray(value.tools)
      ? value.tools.filter((tool): tool is string => (GRANTABLE_AGENT_TOOLS as readonly string[]).includes(tool))
      : defaults.tools,
  }
}
