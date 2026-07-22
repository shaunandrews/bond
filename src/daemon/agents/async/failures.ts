export type AgentRunFailureClass = 'validation' | 'authentication' | 'permission' | 'policy' | 'resource' | 'transient' | 'execution' | 'recovery'

export class AgentRunFailure extends Error {
  constructor(readonly failureClass: AgentRunFailureClass, message: string, readonly retryable = false) {
    super(message)
    this.name = 'AgentRunFailure'
  }
}

export class AgentResourceLimitError extends AgentRunFailure {
  constructor(message: string) { super('resource', message, false); this.name = 'AgentResourceLimitError' }
}

export function classifyAgentRunFailure(error: unknown): { errorClass: AgentRunFailureClass; message: string; retryable: boolean } {
  if (error instanceof AgentRunFailure) return { errorClass: error.failureClass, message: error.message, retryable: error.retryable }
  const message = error instanceof Error ? error.message : String(error)
  if (/\b(401|unauthenticated|invalid credential|credential is missing)\b/i.test(message)) return { errorClass: 'authentication', message, retryable: false }
  if (/\b(403|permission denied|forbidden|EACCES|EPERM)\b/i.test(message)) return { errorClass: 'permission', message, retryable: false }
  if (/\b(policy|hard-denied|command denied|outside the managed|path escapes)\b/i.test(message)) return { errorClass: 'policy', message, retryable: false }
  if (/\b(resource cap|output exceeded|token resource|wall-clock cap|ENOSPC)\b/i.test(message)) return { errorClass: 'resource', message, retryable: false }
  if (/\b(408|429|5\d\d|timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network unavailable|socket hang up)\b/i.test(message)) {
    return { errorClass: 'transient', message, retryable: true }
  }
  if (/\b(invalid|required|unknown agent|unknown verb|validation)\b/i.test(message)) return { errorClass: 'validation', message, retryable: false }
  return { errorClass: 'execution', message, retryable: false }
}
