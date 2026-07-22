import type { AgentSettings } from './agents'

export const AGENT_RUN_STATES = [
  'queued',
  'preparing-workspace',
  'running',
  'needs-input',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const

export type AgentRunState = (typeof AGENT_RUN_STATES)[number]

export const TERMINAL_AGENT_RUN_STATES: readonly AgentRunState[] = [
  'succeeded',
  'failed',
  'cancelled',
]

/** Phase 0 reads an existing directory in place and never grants write tools. */
export interface ReadOnlyAgentWorkspace {
  repoRoot: string
  isolation: 'in-place'
  branch: null
  readOnly: true
}

export interface AgentRunResourceCaps {
  wallClockSeconds: number
  maxOutputChars: number
}

export interface AgentRun {
  id: string
  idempotencyKey: string
  agent: string
  agentLabel: string
  verb: string
  brief: string
  paths: string[]
  workspace: ReadOnlyAgentWorkspace
  baseSha: string | null
  allowedPaths: string[]
  settings: AgentSettings
  agentDefinitionVersion: string
  commandPolicyVersion: string
  acceptanceChecks: string[]
  resourceCaps: AgentRunResourceCaps
  checkpoint: Record<string, unknown> | null
  status: AgentRunState
  result: string | null
  errorClass: string | null
  errorMessage: string | null
  recoveryCount: number
  completionMessageId: string | null
  completionInsertedAt: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
}

export interface AgentRunEvent {
  id: number
  runId: string
  sequence: number
  type: string
  fromState: AgentRunState | null
  toState: AgentRunState | null
  data: Record<string, unknown>
  createdAt: string
}

export interface DispatchAgentRunInput {
  agent: string
  verb: string
  brief: string
  paths?: string[]
  idempotencyKey: string
  parentModel?: string
}

export interface AgentRunDetail {
  run: AgentRun
  events: AgentRunEvent[]
}
