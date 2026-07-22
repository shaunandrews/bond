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

/** A record the run dropped. Informational — never a reason to fail the run. */
export interface SkippedMemory {
  index?: number
  text?: string
  reason: string
}

export interface ObservedMemory {
  workingState: WorkingState
  memories: SourcedMemoryInput[]
  /** Per-item validation failures. The rest of the batch still persists. */
  skipped: SkippedMemory[]
  /** Fatal only: the response was not parseable JSON. */
  errors: string[]
  prompt: string
}

/** Maps whatever the model wrote back to a canonical message uuid, or null. */
export type SourceIdResolver = (token: string) => string | null

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
    return { workingState: input.currentState ?? createWorkingState({ sessionId: input.sessionId ?? null, projectId: input.projectId ?? null }), memories: [], skipped: [], errors: parsed.errors, prompt }
  }

  const resolve = buildSourceIdResolver(input.messages)
  const skipped: SkippedMemory[] = []
  // artifacts and activeSkill are DETERMINISTIC-ONLY: they come from the tool
  // event stream, which is ground truth. A model guess would silently outrank
  // a fact Bond performed itself. checkpoint is the one field it may write.
  const { artifacts: _ignoredArtifacts, activeSkill: _ignoredSkill, ...modelPatch } = isRecord(parsed.value.workingState) ? parsed.value.workingState : {}
  const workingPatch = validateWorkingState({
    ...modelPatch,
    artifacts: input.currentState?.artifacts ?? [],
    activeSkill: input.currentState?.activeSkill ?? null,
    sessionId: input.sessionId ?? input.currentState?.sessionId ?? null,
    projectId: input.projectId ?? input.currentState?.projectId ?? null,
  })
  // A malformed patch keeps the current state; that is a degraded record, not
  // a failed run.
  if (!workingPatch.ok) skipped.push({ reason: `workingState: ${workingPatch.errors.join('; ')}` })

  const base = input.currentState ?? createWorkingState({ sessionId: input.sessionId ?? null, projectId: input.projectId ?? null })
  const workingState = workingPatch.ok ? mergeWorkingState(base, workingPatch.value) : base
  const memories = validateSourcedMemories(parsed.value.memories, resolve, skipped, input.projectId)
  return { workingState, memories, skipped, errors: [], prompt }
}

/**
 * The model is asked for one identifier and still improvises: bare seqs, `#696`,
 * uppercase uuids, JSON numbers, and outright hallucinated uuids all appear in
 * the log. Everything that CAN be resolved resolves; what cannot is dropped as
 * one record, never as the batch.
 */
export function buildSourceIdResolver(messages: TranscriptMessage[]): SourceIdResolver {
  const map = new Map<string, string>()
  for (const message of messages) {
    map.set(message.id, message.id)
    map.set(message.id.toLocaleLowerCase(), message.id)
    if (message.seq != null) {
      map.set(String(message.seq), message.id)
      map.set(`#${message.seq}`, message.id)
      map.set(`seq=${message.seq}`, message.id)
    }
  }
  return token => {
    const trimmed = token.trim()
    return map.get(trimmed) ?? map.get(trimmed.toLocaleLowerCase()) ?? null
  }
}

/**
 * Provenance never gates the payload: a memory with one resolvable source is
 * kept (the unresolvable tokens are simply dropped), and a memory with none is
 * the only thing lost. Callers get `skipped` for the ledger, not an exception.
 */
export function validateSourcedMemories(raw: unknown, resolve: SourceIdResolver, skipped: SkippedMemory[] = [], defaultProjectId?: string | null): SourcedMemoryInput[] {
  if (!Array.isArray(raw)) return []
  const out: SourcedMemoryInput[] = []
  for (const [index, value] of raw.entries()) {
    if (!isRecord(value)) {
      skipped.push({ index, reason: 'not an object' })
      continue
    }
    const text = typeof value.text === 'string' ? value.text : undefined
    const { ids, invalid } = normalizeSourceIds(value.sourceIds, resolve)
    if (ids.length === 0) {
      skipped.push({ index, text, reason: `unresolvable sourceIds: ${invalid.join(', ') || '(none supplied)'}` })
      continue
    }
    const item = validateMemoryItemInput({ ...value, projectId: value.projectId ?? defaultProjectId ?? null })
    if (!item.ok) {
      skipped.push({ index, text, reason: item.errors.join('; ') })
      continue
    }
    if (invalid.length > 0) skipped.push({ index, text, reason: `kept; dropped unresolvable sourceIds: ${invalid.join(', ')}` })
    out.push({ ...item.value, sourceIds: ids })
  }
  return out
}

export function normalizeSourceIds(raw: unknown, resolve: SourceIdResolver): { ids: string[]; invalid: string[] } {
  if (!Array.isArray(raw)) return { ids: [], invalid: [] }
  const seen = new Set<string>()
  const invalidSeen = new Set<string>()
  const ids: string[] = []
  const invalid: string[] = []
  for (const value of raw) {
    // JSON numbers happen: the prompt now shows bare seqs, and models quote
    // them inconsistently.
    const token = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value : ''
    if (!token.trim()) continue
    const resolved = resolve(token)
    if (!resolved) {
      if (!invalidSeen.has(token)) {
        invalidSeen.add(token)
        invalid.push(token)
      }
      continue
    }
    if (seen.has(resolved)) continue
    seen.add(resolved)
    ids.push(resolved)
  }
  return { ids, invalid }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
