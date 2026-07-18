import { getMessagesForRange } from '../transcript'
import { observeTranscript, type MemoryModel, type ObservedMemory } from './observer'
import { reflectTranscript, type ReflectionResult } from './reflector'
import { retrieveMemory, type MemoryRetrievalResult } from './retrieval'
import type { WorkingState } from './types'

export interface MemoryCoordinator {
  observeRange(input: { fromSeq: number; toSeq: number; currentState?: WorkingState | null; sessionId?: string | null; projectId?: string | null }): Promise<ObservedMemory>
  reflectRange(input: { fromSeq: number; toSeq: number; projectId?: string | null; corePath?: string; persist?: boolean }): Promise<ReflectionResult>
  retrieve(input: { query: string; projectId?: string | null; limit?: number; workingState?: WorkingState | null; corePath?: string }): MemoryRetrievalResult
}

export function createMemoryCoordinator(options: { model: MemoryModel; logger?: Pick<Console, 'warn'> }): MemoryCoordinator {
  return {
    async observeRange(input) {
      const messages = safeRange(input.fromSeq, input.toSeq, options.logger)
      return observeTranscript({ messages, model: options.model, currentState: input.currentState, sessionId: input.sessionId, projectId: input.projectId })
    },
    async reflectRange(input) {
      const messages = safeRange(input.fromSeq, input.toSeq, options.logger)
      return reflectTranscript({ messages, model: options.model, projectId: input.projectId, corePath: input.corePath, persist: input.persist })
    },
    retrieve(input) {
      return retrieveMemory(input)
    },
  }
}

function safeRange(fromSeq: number, toSeq: number, logger?: Pick<Console, 'warn'>) {
  const from = Math.max(1, Math.floor(fromSeq))
  const to = Math.max(from, Math.floor(toSeq))
  if (from !== fromSeq || to !== toSeq) logger?.warn(`Normalized memory transcript range ${fromSeq}-${toSeq} to ${from}-${to}`)
  return getMessagesForRange(from, to)
}
