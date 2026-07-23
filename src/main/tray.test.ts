import { describe, expect, it } from 'vitest'
import { shouldNotifyAgentRun } from './tray'

describe('agent run tray notification gating', () => {
  it('only notifies unfocused users for input or terminal state changes', () => {
    expect(shouldNotifyAgentRun('running', 'needs-input', false)).toBe(true)
    expect(shouldNotifyAgentRun('running', 'succeeded', false)).toBe(true)
    expect(shouldNotifyAgentRun('running', 'running', false)).toBe(false)
    expect(shouldNotifyAgentRun('running', 'cancelled', false)).toBe(false)
    expect(shouldNotifyAgentRun('running', 'failed', true)).toBe(false)
    expect(shouldNotifyAgentRun('failed', 'failed', false)).toBe(false)
  })
})
