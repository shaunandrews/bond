import type { TranscriptMessage } from '../../shared/transcript'
import { parseJsonObject, validateMemoryItemInput, validateWorkingState } from './parser'
import { buildObserverPrompt } from './prompts'
import type { MemoryItemInput, WorkingState } from './types'
import { createWorkingState, mergeWorkingState } from './working-state'

export interface MemoryModel {
  generate(prompt: string): Promise<string>
}

export interface SourcedMemoryInput extends MemoryItemInput {
  sourceIds: string[]
}

export interface ObservedMemory {
  workingState: WorkingState
  memories: SourcedMemoryInput[]
  errors: string[]
  prompt: string
}

export async function observeTranscript(input: {
  messages: TranscriptMessage[]
  model: MemoryModel
  currentState?: WorkingState | null
  sessionId?: string | null
  projectId?: string | null
}): Promise<ObservedMemory> {
  const prompt = buildObserverPrompt({ messages: input.messages, currentState: input.currentState, projectId: input.projectId })
  const response = await input.model.generate(prompt)
  const parsed = parseJsonObject(response)
  if (!parsed.ok) {
    return { workingState: input.currentState ?? createWorkingState({ sessionId: input.sessionId ?? null, projectId: input.projectId ?? null }), memories: [], errors: parsed.errors, prompt }
  }

  const allowedIds = new Set(input.messages.map(m => m.id))
  const errors: string[] = []
  const workingPatch = validateWorkingState({
    ...(isRecord(parsed.value.workingState) ? parsed.value.workingState : {}),
    sessionId: input.sessionId ?? input.currentState?.sessionId ?? null,
    projectId: input.projectId ?? input.currentState?.projectId ?? null,
  })
  if (!workingPatch.ok) errors.push(...workingPatch.errors)

  const base = input.currentState ?? createWorkingState({ sessionId: input.sessionId ?? null, projectId: input.projectId ?? null })
  const workingState = workingPatch.ok ? mergeWorkingState(base, workingPatch.value) : base
  const memories = validateSourcedMemories(parsed.value.memories, allowedIds, errors, input.projectId)
  return { workingState, memories, errors, prompt }
}

export function validateSourcedMemories(raw: unknown, allowedSourceIds: Set<string>, errors: string[] = [], defaultProjectId?: string | null): SourcedMemoryInput[] {
  if (!Array.isArray(raw)) return []
  const out: SourcedMemoryInput[] = []
  for (const [index, value] of raw.entries()) {
    if (!isRecord(value)) {
      errors.push(`memories[${index}] must be an object`)
      continue
    }
    const sourceIdResult = normalizeSourceIds(value.sourceIds, allowedSourceIds)
    if (sourceIdResult.invalid.length > 0) errors.push(`memories[${index}] has unknown sourceIds: ${sourceIdResult.invalid.join(', ')}`)
    const sourceIds = sourceIdResult.ids
    if (sourceIds.length === 0) {
      errors.push(`memories[${index}] has no valid sourceIds`)
      continue
    }
    const item = validateMemoryItemInput({ ...value, projectId: value.projectId ?? defaultProjectId ?? null })
    if (!item.ok) {
      errors.push(...item.errors.map(error => `memories[${index}]: ${error}`))
      continue
    }
    out.push({ ...item.value, sourceIds })
  }
  return out
}

export function normalizeSourceIds(raw: unknown, allowedSourceIds: Set<string>): { ids: string[]; invalid: string[] } {
  if (!Array.isArray(raw)) return { ids: [], invalid: [] }
  const seen = new Set<string>()
  const invalidSeen = new Set<string>()
  const ids: string[] = []
  const invalid: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !value.trim()) continue
    if (!allowedSourceIds.has(value)) {
      if (!invalidSeen.has(value)) {
        invalidSeen.add(value)
        invalid.push(value)
      }
      continue
    }
    if (seen.has(value)) continue
    seen.add(value)
    ids.push(value)
  }
  return { ids, invalid }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
