import { MEMORY_CAPS, type CoreMemory, type MemoryItem, type MemoryItemInput, type MemoryValidationResult, type WorkingArtifact, type WorkingState, isMemoryItemKind, isMemorySource, isWorkingArtifactKind } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function clampText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars).trimEnd()
}

export function uniqueCappedStrings(values: unknown, itemCap: number, charCap: number): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const text = clampText(value, charCap)
    if (!text) continue
    const key = text.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= itemCap) break
  }
  return out
}

export function parseJsonObject(input: string): MemoryValidationResult<Record<string, unknown>> {
  const trimmed = input.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) return { ok: false, errors: ['No JSON object found'] }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1))
    if (!isRecord(parsed)) return { ok: false, errors: ['Parsed JSON is not an object'] }
    return { ok: true, value: parsed }
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

export function validateMemoryItemInput(input: unknown): MemoryValidationResult<MemoryItemInput> {
  if (!isRecord(input)) return { ok: false, errors: ['Memory item must be an object'] }
  const errors: string[] = []

  const text = typeof input.text === 'string' ? clampText(input.text, MEMORY_CAPS.textChars) : ''
  if (!text) errors.push('text is required')

  const rawKind = input.kind === undefined ? 'fact' : input.kind
  if (!isMemoryItemKind(rawKind)) errors.push('kind is invalid')
  const kind = isMemoryItemKind(rawKind) ? rawKind : 'fact'

  const rawSource = input.source === undefined ? 'assistant' : input.source
  if (!isMemorySource(rawSource)) errors.push('source is invalid')
  const source = isMemorySource(rawSource) ? rawSource : 'assistant'

  const projectId = input.projectId === undefined || input.projectId === null
    ? null
    : typeof input.projectId === 'string'
      ? clampText(input.projectId, 200)
      : (errors.push('projectId must be a string or null'), null)

  const confidence = input.confidence === undefined
    ? 1
    : typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence))
      : (errors.push('confidence must be a finite number'), 1)

  const active = input.active === undefined ? true : input.active === true
  const tags = uniqueCappedStrings(input.tags ?? [], MEMORY_CAPS.tags, MEMORY_CAPS.tagChars)

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined,
      kind,
      text,
      source,
      projectId,
      tags,
      confidence,
      active,
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : undefined,
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : undefined,
    },
  }
}

export function validateMemoryItem(input: unknown): MemoryValidationResult<MemoryItem> {
  const base = validateMemoryItemInput(input)
  if (!base.ok) return base
  if (!base.value.id) return { ok: false, errors: ['id is required'] }
  const now = new Date().toISOString()
  return {
    ok: true,
    value: {
      id: base.value.id,
      kind: base.value.kind ?? 'fact',
      text: base.value.text,
      source: base.value.source ?? 'assistant',
      projectId: base.value.projectId ?? null,
      tags: base.value.tags ?? [],
      confidence: base.value.confidence ?? 1,
      active: base.value.active ?? true,
      createdAt: base.value.createdAt ?? now,
      updatedAt: base.value.updatedAt ?? base.value.createdAt ?? now,
    },
  }
}

/**
 * Every field defaults, so `memory.working` JSON persisted before artifacts
 * existed still loads cleanly. A malformed artifact entry is dropped on its
 * own — never fatal to the state.
 */
export function validateWorkingArtifacts(input: unknown): WorkingArtifact[] {
  if (!Array.isArray(input)) return []
  const byRef = new Map<string, WorkingArtifact>()
  for (const value of input) {
    if (!isRecord(value)) continue
    if (!isWorkingArtifactKind(value.kind)) continue
    if (typeof value.ref !== 'string') continue
    const ref = clampText(value.ref, MEMORY_CAPS.artifactRefChars)
    if (!ref) continue
    const label = typeof value.label === 'string' ? clampText(value.label, MEMORY_CAPS.artifactLabelChars) : ''
    const lastTouchedAt = typeof value.lastTouchedAt === 'string' && value.lastTouchedAt ? value.lastTouchedAt : new Date().toISOString()
    byRef.set(ref, { kind: value.kind, ref, ...(label ? { label } : {}), lastTouchedAt })
  }
  return [...byRef.values()]
    .sort((a, b) => (a.lastTouchedAt < b.lastTouchedAt ? 1 : a.lastTouchedAt > b.lastTouchedAt ? -1 : 0))
    .slice(0, MEMORY_CAPS.workingArtifacts)
}

function optionalText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const text = clampText(value, maxChars)
  return text || null
}

export function validateWorkingState(input: unknown): MemoryValidationResult<WorkingState> {
  if (!isRecord(input)) return { ok: false, errors: ['Working state must be an object'] }
  return {
    ok: true,
    value: {
      sessionId: typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null,
      projectId: typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : null,
      goal: typeof input.goal === 'string' ? clampText(input.goal, MEMORY_CAPS.workingGoalChars) : '',
      facts: uniqueCappedStrings(input.facts, MEMORY_CAPS.workingFacts, MEMORY_CAPS.workingListItemChars),
      preferences: uniqueCappedStrings(input.preferences, MEMORY_CAPS.workingPreferences, MEMORY_CAPS.workingListItemChars),
      decisions: uniqueCappedStrings(input.decisions, MEMORY_CAPS.workingDecisions, MEMORY_CAPS.workingListItemChars),
      openThreads: uniqueCappedStrings(input.openThreads, MEMORY_CAPS.workingOpenThreads, MEMORY_CAPS.workingListItemChars),
      artifacts: validateWorkingArtifacts(input.artifacts),
      activeSkill: optionalText(input.activeSkill, MEMORY_CAPS.activeSkillChars),
      checkpoint: optionalText(input.checkpoint, MEMORY_CAPS.checkpointChars),
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
    },
  }
}

export function validateCoreMemory(input: unknown): MemoryValidationResult<CoreMemory> {
  if (!isRecord(input)) return { ok: false, errors: ['Core memory must be an object'] }
  return {
    ok: true,
    value: {
      version: 1,
      facts: uniqueCappedStrings(input.facts, MEMORY_CAPS.coreFacts, MEMORY_CAPS.coreItemChars),
      preferences: uniqueCappedStrings(input.preferences, MEMORY_CAPS.corePreferences, MEMORY_CAPS.coreItemChars),
      decisions: uniqueCappedStrings(input.decisions, MEMORY_CAPS.coreDecisions, MEMORY_CAPS.coreItemChars),
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
    },
  }
}
