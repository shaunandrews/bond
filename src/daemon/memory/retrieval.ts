import type Database from 'better-sqlite3'
import { readCoreMemory } from './core-memory'
import { renderMemoryContext, renderStableMemoryState } from './prompts'
import { searchMemory } from './store'
import type { CoreMemory, RetrievedMemory, WorkingState } from './types'

export interface MemoryRetrievalResult {
  core: CoreMemory
  working: WorkingState | null
  retrieved: RetrievedMemory[]
  /** Volatile, query-specific. Goes in the per-turn context envelope. */
  context: string
  /** Stable core + working state. Goes in the per-request system prompt. */
  stableContext: string
}

export function retrieveMemory(input: {
  query: string
  projectId?: string | null
  limit?: number
  workingState?: WorkingState | null
  corePath?: string
  db?: Database.Database
}): MemoryRetrievalResult {
  const core = readCoreMemory(input.corePath)
  const projectResults = searchMemory(input.query, { projectId: input.projectId, limit: input.limit }, input.db)
  const globalResults = input.projectId == null ? [] : searchMemory(input.query, { projectId: null, limit: input.limit }, input.db)
  const retrieved = dedupeRetrieved([...projectResults, ...globalResults], input.limit ?? 8)
  const context = renderMemoryContext({
    retrieved: retrieved.map(r => ({ id: r.item.id, text: r.item.text, score: r.score })),
  })
  const stableContext = renderStableMemoryState(core, input.workingState ?? null)
  return { core, working: input.workingState ?? null, retrieved, context, stableContext }
}

function dedupeRetrieved(items: RetrievedMemory[], limit: number): RetrievedMemory[] {
  const seen = new Set<string>()
  const out: RetrievedMemory[] = []
  for (const item of items) {
    if (seen.has(item.item.id)) continue
    seen.add(item.item.id)
    out.push(item)
    if (out.length >= Math.max(1, Math.floor(limit))) break
  }
  return out
}
