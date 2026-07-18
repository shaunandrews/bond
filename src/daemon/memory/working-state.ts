import { MEMORY_CAPS, type WorkingState } from './types'
import { clampText, validateWorkingState } from './parser'

export function createWorkingState(input: Partial<WorkingState> = {}): WorkingState {
  const parsed = validateWorkingState({
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
    goal: input.goal ?? '',
    facts: input.facts ?? [],
    preferences: input.preferences ?? [],
    decisions: input.decisions ?? [],
    openThreads: input.openThreads ?? [],
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  })
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return parsed.value
}

function appendUnique(list: string[], values: string[], maxItems: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of [...list, ...values]) {
    const text = clampText(value, MEMORY_CAPS.workingListItemChars)
    if (!text) continue
    const key = text.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out.slice(Math.max(0, out.length - maxItems))
}

export function mergeWorkingState(current: WorkingState, patch: Partial<WorkingState>): WorkingState {
  return createWorkingState({
    sessionId: patch.sessionId !== undefined ? patch.sessionId : current.sessionId,
    projectId: patch.projectId !== undefined ? patch.projectId : current.projectId,
    goal: patch.goal !== undefined ? patch.goal : current.goal,
    facts: patch.facts ? appendUnique(current.facts, patch.facts, MEMORY_CAPS.workingFacts) : current.facts,
    preferences: patch.preferences ? appendUnique(current.preferences, patch.preferences, MEMORY_CAPS.workingPreferences) : current.preferences,
    decisions: patch.decisions ? appendUnique(current.decisions, patch.decisions, MEMORY_CAPS.workingDecisions) : current.decisions,
    openThreads: patch.openThreads ? appendUnique(current.openThreads, patch.openThreads, MEMORY_CAPS.workingOpenThreads) : current.openThreads,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  })
}

export function renderWorkingStateForPrompt(state: WorkingState): string {
  const lines: string[] = []
  if (state.goal) lines.push(`Goal: ${state.goal}`)
  if (state.facts.length) lines.push(`Facts:\n${state.facts.map(v => `- ${v}`).join('\n')}`)
  if (state.preferences.length) lines.push(`Preferences:\n${state.preferences.map(v => `- ${v}`).join('\n')}`)
  if (state.decisions.length) lines.push(`Decisions:\n${state.decisions.map(v => `- ${v}`).join('\n')}`)
  if (state.openThreads.length) lines.push(`Open threads:\n${state.openThreads.map(v => `- ${v}`).join('\n')}`)
  return lines.join('\n\n')
}
