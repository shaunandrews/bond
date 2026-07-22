import type { AgentRun, AgentRunDetail, AgentRunQuestion, DispatchAgentRunInput } from '../../../shared/agent-runs'

export interface AgentRunApi {
  dispatch(input: DispatchAgentRunInput): Promise<{ run: AgentRun; created: boolean }>
  check(runId: string): AgentRunDetail | null
  answer(runId: string, questionId: string, approved: boolean, response?: string): Promise<{ run: AgentRun; question: AgentRunQuestion; changed: boolean }>
}

let api: AgentRunApi | null = null

export function setAgentRunApi(value: AgentRunApi | null): void {
  api = value
}

export function dispatchAgentRunFromTool(input: DispatchAgentRunInput): Promise<{ run: AgentRun; created: boolean }> {
  if (!api) throw new Error('Background agent service is not running.')
  return api.dispatch(input)
}

export function checkAgentRunFromTool(runId: string): AgentRunDetail | null {
  if (!api) throw new Error('Background agent service is not running.')
  return api.check(runId)
}

export function answerAgentQuestionFromTool(runId: string, questionId: string, approved: boolean, response?: string) {
  if (!api) throw new Error('Background agent service is not running.')
  return api.answer(runId, questionId, approved, response)
}
