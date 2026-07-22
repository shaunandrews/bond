import { describe, expect, it } from 'vitest'
import { AgentResourceLimitError, classifyAgentRunFailure } from './failures'

describe('agent run failure classification', () => {
  it('retries only transient failures', () => {
    expect(classifyAgentRunFailure(new Error('HTTP 503 network unavailable'))).toMatchObject({ errorClass: 'transient', retryable: true })
    expect(classifyAgentRunFailure(new Error('permission denied'))).toMatchObject({ errorClass: 'permission', retryable: false })
    expect(classifyAgentRunFailure(new AgentResourceLimitError('step resource cap'))).toMatchObject({ errorClass: 'resource', retryable: false })
  })
})
