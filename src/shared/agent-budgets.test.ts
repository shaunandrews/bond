import { describe, expect, it } from 'vitest'
import { AGENT_BUDGET_HARD_CEILINGS, resolveAgentRunBudget } from './agent-budgets'

describe('agent budget presets', () => {
  it('persists the selected preset and leaves an override seam', () => {
    expect(resolveAgentRunBudget('conservative')).toMatchObject({ budgetPreset: 'conservative', maxSteps: 40 })
    expect(resolveAgentRunBudget('standard', { maxSteps: 120 })).toMatchObject({ budgetPreset: 'standard', maxSteps: 120 })
  })

  it('never lets configuration exceed Bond hard ceilings', () => {
    expect(resolveAgentRunBudget('extended', { maxCostUsd: 1_000_000, maxDiskBytes: Number.MAX_SAFE_INTEGER })).toMatchObject({
      maxCostUsd: AGENT_BUDGET_HARD_CEILINGS.maxCostUsd,
      maxDiskBytes: AGENT_BUDGET_HARD_CEILINGS.maxDiskBytes,
    })
  })
})
