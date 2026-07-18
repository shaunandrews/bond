import type Database from 'better-sqlite3'
import { getSourceMessages } from '../transcript'
import { getMemoryItem, searchMemory, upsertMemoryItem } from './store'
import type { MemoryItem, MemoryItemInput, RetrievedMemory } from './types'

export interface MemoryToolResult<T> {
  ok: boolean
  value?: T
  errors: string[]
}

export function rememberMemory(input: MemoryItemInput & { sourceIds?: string[] }, options: { db?: Database.Database; validateSources?: boolean } = {}): MemoryToolResult<MemoryItem> {
  const errors = validateToolSourceIds(input.sourceIds, options.validateSources ?? false)
  if (errors.length > 0) return { ok: false, errors }
  try {
    const tags = [...(input.tags ?? []), ...(input.sourceIds ?? []).map(id => `source:${id}`)]
    return { ok: true, value: upsertMemoryItem({ ...input, tags }, options.db), errors: [] }
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
  }
}

export function forgetMemory(id: string, options: { db?: Database.Database } = {}): MemoryToolResult<MemoryItem> {
  const current = getMemoryItem(id, options.db)
  if (!current) return { ok: false, errors: [`Memory not found: ${id}`] }
  try {
    return { ok: true, value: upsertMemoryItem({ ...current, active: false, updatedAt: new Date().toISOString() }, options.db), errors: [] }
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
  }
}

export function searchMemoryTool(query: string, options: { projectId?: string | null; limit?: number; db?: Database.Database } = {}): MemoryToolResult<RetrievedMemory[]> {
  try {
    return { ok: true, value: searchMemory(query, { projectId: options.projectId, limit: options.limit }, options.db), errors: [] }
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
  }
}

export function validateToolSourceIds(sourceIds: unknown, checkTranscript: boolean): string[] {
  if (sourceIds === undefined) return []
  if (!Array.isArray(sourceIds) || !sourceIds.every(id => typeof id === 'string' && id.trim())) return ['sourceIds must be an array of non-empty strings']
  if (!checkTranscript) return []
  const unique = [...new Set(sourceIds)]
  const found = new Set(getSourceMessages(unique).map(message => message.id))
  const missing = unique.filter(id => !found.has(id))
  return missing.length ? [`Unknown sourceIds: ${missing.join(', ')}`] : []
}
