import { describe, expect, it } from 'vitest'
import { MEMORY_CAPS } from './types'
import { createWorkingState, mergeWorkingState, renderWorkingStateForPrompt } from './working-state'

describe('working state memory', () => {
  it('creates a normalized empty state', () => {
    const state = createWorkingState({ goal: '  ship   memory  ' })
    expect(state.sessionId).toBeNull()
    expect(state.goal).toBe('ship memory')
  })

  it('merges lists with deterministic tail caps', () => {
    const current = createWorkingState({
      facts: Array.from({ length: MEMORY_CAPS.workingFacts }, (_, i) => `old ${i}`),
    })
    const next = mergeWorkingState(current, { facts: ['old 1', 'new 1', 'new 2'] })
    expect(next.facts).toHaveLength(MEMORY_CAPS.workingFacts)
    expect(next.facts).not.toContain('old 0')
    expect(next.facts).toContain('new 1')
    expect(next.facts).toContain('new 2')
  })

  it('renders only populated prompt sections', () => {
    const state = createWorkingState({ goal: 'Fix it', decisions: ['Do the small thing'] })
    expect(renderWorkingStateForPrompt(state)).toBe('Goal: Fix it\n\nDecisions:\n- Do the small thing')
  })
})
