import type { TranscriptMessage } from '../../shared/transcript'
import { readCoreMemory, writeCoreMemoryAtomic } from './core-memory'
import type { MemoryModel, SourcedMemoryInput } from './observer'
import { validateSourcedMemories } from './observer'
import { parseJsonObject, validateCoreMemory } from './parser'
import { buildReflectorPrompt } from './prompts'
import { upsertMemoryItem } from './store'
import type { CoreMemory, MemoryItem } from './types'

export interface ReflectionResult {
  coreMemory: CoreMemory
  memories: MemoryItem[]
  sourcedMemories: SourcedMemoryInput[]
  errors: string[]
  prompt: string
}

export async function reflectTranscript(input: {
  messages: TranscriptMessage[]
  model: MemoryModel
  projectId?: string | null
  corePath?: string
  persist?: boolean
  upsert?: (memory: SourcedMemoryInput) => MemoryItem
}): Promise<ReflectionResult> {
  const currentCore = readCoreMemory(input.corePath)
  const prompt = buildReflectorPrompt({ messages: input.messages, coreMemory: currentCore, projectId: input.projectId })
  const response = await input.model.generate(prompt)
  const parsed = parseJsonObject(response)
  if (!parsed.ok) return { coreMemory: currentCore, memories: [], sourcedMemories: [], errors: parsed.errors, prompt }

  const errors: string[] = []
  const allowedIds = new Set(input.messages.map(m => m.id))
  const coreParsed = validateCoreMemory({ ...(isRecord(parsed.value.core) ? parsed.value.core : currentCore), updatedAt: new Date().toISOString() })
  if (!coreParsed.ok) errors.push(...coreParsed.errors)
  const coreMemory = coreParsed.ok ? coreParsed.value : currentCore
  const sourcedMemories = validateSourcedMemories(parsed.value.memories, allowedIds, errors, input.projectId)

  const memories: MemoryItem[] = []
  if (input.persist !== false) {
    if (coreParsed.ok) writeCoreMemoryAtomic(coreMemory, input.corePath)
    const upsert = input.upsert ?? ((memory: SourcedMemoryInput) => upsertMemoryItem(withSourceTags(memory)))
    for (const memory of sourcedMemories) memories.push(upsert(memory))
  }

  return { coreMemory, memories, sourcedMemories, errors, prompt }
}

function withSourceTags(memory: SourcedMemoryInput): SourcedMemoryInput {
  return { ...memory, tags: [...(memory.tags ?? []), ...memory.sourceIds.map(id => `source:${id}`)] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
