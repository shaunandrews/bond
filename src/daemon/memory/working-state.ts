import { MEMORY_CAPS, type WorkingArtifact, type WorkingState } from './types'
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
    artifacts: input.artifacts ?? [],
    activeSkill: input.activeSkill ?? null,
    checkpoint: input.checkpoint ?? null,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  })
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return parsed.value
}

/** Additive merge with LRU-style overflow. Shared with core memory's reflector merge. */
export function appendUnique(list: string[], values: string[], maxItems: number, maxChars: number = MEMORY_CAPS.workingListItemChars): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of [...list, ...values]) {
    const text = clampText(value, maxChars)
    if (!text) continue
    const key = text.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out.slice(Math.max(0, out.length - maxItems))
}

/** Artifacts merge BY REF: same ref refreshes in place, newest first, LRU past the cap. */
export function mergeArtifacts(current: WorkingArtifact[], patch: WorkingArtifact[]): WorkingArtifact[] {
  const byRef = new Map<string, WorkingArtifact>()
  for (const artifact of current) byRef.set(artifact.ref, artifact)
  for (const artifact of patch) {
    const existing = byRef.get(artifact.ref)
    byRef.set(artifact.ref, { ...existing, ...artifact, label: artifact.label ?? existing?.label })
  }
  return [...byRef.values()]
    .map(artifact => (artifact.label ? artifact : { kind: artifact.kind, ref: artifact.ref, lastTouchedAt: artifact.lastTouchedAt }))
    .sort((a, b) => (a.lastTouchedAt < b.lastTouchedAt ? 1 : a.lastTouchedAt > b.lastTouchedAt ? -1 : 0))
    .slice(0, MEMORY_CAPS.workingArtifacts)
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
    artifacts: patch.artifacts ? mergeArtifacts(current.artifacts, patch.artifacts) : current.artifacts,
    activeSkill: patch.activeSkill !== undefined ? patch.activeSkill : current.activeSkill,
    checkpoint: patch.checkpoint !== undefined ? patch.checkpoint : current.checkpoint,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  })
}

/**
 * Artifacts render FIRST, right under the goal. On 2026-07-21 the one line
 * describing the active artifact read "a Library markdown file" and sat below
 * mobile-composer notes from a different task hours earlier.
 */
export function renderWorkingStateForPrompt(state: WorkingState): string {
  const lines: string[] = []
  if (state.goal) lines.push(`Goal: ${state.goal}`)
  if (state.artifacts.length) {
    lines.push(`Working on:\n${state.artifacts.map(a => `- [${a.kind}] ${a.ref}${a.label ? ` — "${a.label}"` : ''}`).join('\n')}`)
  }
  if (state.activeSkill) lines.push(`Active skill: ${state.activeSkill}`)
  if (state.checkpoint) lines.push(`Checkpoint: ${state.checkpoint}`)
  if (state.facts.length) lines.push(`Facts:\n${state.facts.map(v => `- ${v}`).join('\n')}`)
  if (state.preferences.length) lines.push(`Preferences:\n${state.preferences.map(v => `- ${v}`).join('\n')}`)
  if (state.decisions.length) lines.push(`Decisions:\n${state.decisions.map(v => `- ${v}`).join('\n')}`)
  if (state.openThreads.length) lines.push(`Open threads:\n${state.openThreads.map(v => `- ${v}`).join('\n')}`)
  return lines.join('\n\n')
}
