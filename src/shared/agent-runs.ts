import type { AgentBudgetPreset, AgentSettings } from './agents'

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
  budgetPreset?: AgentBudgetPreset
  wallClockSeconds: number
  maxOutputChars: number
  maxSteps?: number
  maxSubprocesses?: number
  maxDiskBytes?: number
  maxTokens?: number
  maxCostUsd?: number
}

export interface AgentRunSummary {
  status: Extract<AgentRunState, 'succeeded' | 'failed' | 'cancelled'>
  agentLabel: string
  verb: string
  brief: string
  finalReport: string | null
  errorClass: string | null
  errorMessage: string | null
  completedAt: string
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

export type AgentRunPublishStatus = 'pending' | 'publishing' | 'published' | 'failed'
export type AgentRunQReviewStatus = 'not-required' | 'pending' | 'posted' | 'failed'

export interface AgentRunPublication {
  runId: string
  repository: 'shaunandrews/bond'
  remote: 'origin'
  baseRef: string
  headRef: string
  idempotencyKey: string
  status: AgentRunPublishStatus
  prNumber: number | null
  prNodeId: string | null
  prUrl: string | null
  qReviewRequired: boolean
  qReviewStatus: AgentRunQReviewStatus
  qCommentId: number | null
  qCommentUrl: string | null
  errorClass: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

export interface GitHubHandoffConfig {
  enabled: boolean
  repository: 'shaunandrews/bond'
  remote: 'origin'
  credentialRef: string
  credentialConfigured: boolean
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
  summary: AgentRunSummary | null
  status: AgentRunState
  result: string | null
  errorClass: string | null
  errorMessage: string | null
  recoveryCount: number
  attemptCount: number
  retryCount: number
  nextRetryAt: string | null
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
  rawPayloadAvailable?: boolean
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
  publication: AgentRunPublication | null
}

export interface AgentRetentionConfig {
  worktreeDays: number
  rawLogRetention: 7 | 30 | 90 | 'forever'
  maxRawLogBytes: number
}

export interface AgentRunCardData {
  runId: string
  agent: string
  agentLabel: string
  verb: string
  status: AgentRunState
  errorClass?: string | null
  questionId?: string | null
  prNumber?: number | null
  prUrl?: string | null
  qReviewStatus?: AgentRunQReviewStatus | null
  qCommentUrl?: string | null
  publishError?: string | null
}
