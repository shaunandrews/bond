import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/agents'
import type { AgentRun } from '../../shared/agent-runs'
import { agentEventLabel, agentRunElapsed, agentRunStatusLabel, isRawAgentEvent } from './agentRuns'

const run = { createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z', completedAt: null } as AgentRun

describe('agent run presentation', () => {
  it('formats durable states and elapsed time consistently', () => {
    expect(agentRunStatusLabel('needs-input')).toBe('Needs input')
    expect(agentRunElapsed(run, Date.parse('2026-01-01T00:01:06.000Z'))).toBe('1m 5s')
  })

  it('keeps command/resource payloads classified as collapsed raw detail', () => {
    const event = { type: 'command_completed' } as any
    expect(agentEventLabel(event)).toBe('Command Completed')
    expect(isRawAgentEvent(event)).toBe(true)
    expect(DEFAULT_AGENT_SETTINGS.budgetPreset).toBe('standard')
  })
})
