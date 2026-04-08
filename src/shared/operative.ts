export type OperativeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Operative {
  id: string
  name: string
  prompt: string
  workingDir: string
  status: OperativeStatus
  sessionId?: string
  sdkSessionId?: string
  worktree?: string
  branch?: string
  model?: string
  resultSummary?: string
  errorMessage?: string
  exitCode?: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  contextWindow?: number
  timeoutMs?: number
  maxBudgetUsd?: number
  startedAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

export interface OperativeEvent {
  id: number
  operativeId: string
  kind: string
  data: Record<string, unknown>
  createdAt: string
}

export interface SpawnOperativeOptions {
  name: string
  prompt: string
  workingDir: string
  sessionId?: string
  worktree?: boolean
  model?: string
  allowedTools?: string[]
  maxBudgetUsd?: number
  timeoutMs?: number
  systemPromptSuffix?: string
}
