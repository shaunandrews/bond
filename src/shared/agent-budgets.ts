import type { AgentRunResourceCaps } from './agent-runs'
import type { AgentBudgetPreset } from './agents'

export type AgentBudgetOverrides = Partial<Omit<AgentRunResourceCaps, 'budgetPreset'>>

export const AGENT_BUDGET_PRESET_CAPS: Record<AgentBudgetPreset, Omit<AgentRunResourceCaps, 'budgetPreset'>> = {
  conservative: { wallClockSeconds: 300, maxOutputChars: 50_000, maxSteps: 40, maxSubprocesses: 12, maxDiskBytes: 1_073_741_824, maxTokens: 100_000, maxCostUsd: 10 },
  standard: { wallClockSeconds: 900, maxOutputChars: 100_000, maxSteps: 80, maxSubprocesses: 24, maxDiskBytes: 2_147_483_648, maxTokens: 250_000, maxCostUsd: 25 },
  extended: { wallClockSeconds: 1_800, maxOutputChars: 250_000, maxSteps: 160, maxSubprocesses: 48, maxDiskBytes: 4_294_967_296, maxTokens: 500_000, maxCostUsd: 50 },
}

export const AGENT_BUDGET_HARD_CEILINGS: Omit<AgentRunResourceCaps, 'budgetPreset'> = {
  wallClockSeconds: 3_600,
  maxOutputChars: 500_000,
  maxSteps: 240,
  maxSubprocesses: 64,
  maxDiskBytes: 8_589_934_592,
  maxTokens: 1_000_000,
  maxCostUsd: 100,
}

const keys = ['wallClockSeconds', 'maxOutputChars', 'maxSteps', 'maxSubprocesses', 'maxDiskBytes', 'maxTokens', 'maxCostUsd'] as const

/** Internal override seam for later per-run controls; every value remains hard-clamped. */
export function resolveAgentRunBudget(preset: AgentBudgetPreset, overrides: AgentBudgetOverrides = {}): AgentRunResourceCaps {
  const selected = AGENT_BUDGET_PRESET_CAPS[preset]
  const resolved: Record<string, number | string> = { budgetPreset: preset }
  for (const key of keys) {
    const candidate = overrides[key] ?? selected[key]
    const ceiling = AGENT_BUDGET_HARD_CEILINGS[key]!
    resolved[key] = Math.max(1, Math.min(ceiling, Number.isFinite(candidate) ? Number(candidate) : Number(selected[key])))
  }
  return resolved as unknown as AgentRunResourceCaps
}
