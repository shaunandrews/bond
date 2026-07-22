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

export interface ManagedWorktreeWorkspace {
  repoRoot: string
  isolation: 'worktree'
  branch: string
  baseRef: string
  worktreePath: string
  readOnly: false
}

export type AgentRunWorkspace = ReadOnlyAgentWorkspace | ManagedWorktreeWorkspace

export interface AgentRunWorkspaceState {
  status: 'pending' | 'ready' | 'retained' | 'discarded'
  createdAt: string | null
  retainedAt: string | null
  discardedAt: string | null
}

export interface ManagedWorkspaceInspection {
  runId: string
  path: string
  branch: string
  baseSha: string | null
  headSha: string | null
  status: AgentRunWorkspaceState['status']
  porcelain: string
  diffStat: string
}

export interface AgentRunResourceCaps {
  wallClockSeconds: number
  maxOutputChars: number
  maxSteps?: number
  maxSubprocesses?: number
  maxDiskBytes?: number
  maxTokens?: number
  maxCostUsd?: number
}

export type AgentRunQuestionStatus = 'pending' | 'approved' | 'denied'

export interface AgentRunQuestion {
  id: string
  runId: string
  kind: 'command-allowlist'
  argv: string[]
  reason: string
  proposedAllowlistAddition: string
  status: AgentRunQuestionStatus
  response: string | null
  createdAt: string
  answeredAt: string | null
}

export interface AgentRun {
  id: string
  idempotencyKey: string
  agent: string
  agentLabel: string
  verb: string
  brief: string
  paths: string[]
  workspace: AgentRunWorkspace
  workspaceState: AgentRunWorkspaceState
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
  /** Required for write-capable agents after the immutable brief is shown. */
  confirmed?: boolean
}

export interface AgentRunDetail {
  run: AgentRun
  events: AgentRunEvent[]
  questions: AgentRunQuestion[]
}
