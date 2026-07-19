import { getDb } from '../db'
import type { EpochHook } from '../epochs'
import { findEpoch } from '../epochs'
import { getSetting, setSetting } from '../settings'
import { getMessagesForRange } from '../transcript'
import { runPiTextPrompt } from '../pi/runtime'
import { redact } from '../sense/redaction'
import { withCoreMemoryLock, writeCoreMemoryAtomic } from './core-memory'
import { observeTranscript, type MemoryModel, type ObservedMemory } from './observer'
import { reflectTranscript, type ReflectionResult } from './reflector'
import { findActiveMemoryByText, getMemoryItemSourceIds, setMemoryItemSources, upsertMemoryItem } from './store'
import { createWorkingState } from './working-state'
import type { WorkingState } from './types'

const WORKING_MEMORY_SETTING = 'memory.working'
const OBSERVATION_SEQ_INTERVAL = 24
const EXPLICIT_MEMORY_CUE = /\b(remember|don['’]?t forget|keep (?:that|this) in mind|save (?:that|this)|forget (?:that|this)|update (?:your )?memory|correct (?:that|this))\b/i

let observationQueue: Promise<void> = Promise.resolve()

function memoryModel(): MemoryModel {
  return { generate: prompt => runPiTextPrompt(prompt, 'fast') }
}

export function readWorkingMemoryState(): WorkingState {
  const raw = getSetting(WORKING_MEMORY_SETTING)
  if (!raw) return createWorkingState()
  try {
    return createWorkingState(JSON.parse(raw))
  } catch {
    return createWorkingState()
  }
}

function safeWorkingText(text: string): string {
  return redact(text) === text ? text : ''
}

export function writeWorkingMemoryState(working: WorkingState): WorkingState {
  const next = createWorkingState({
    ...working,
    goal: safeWorkingText(working.goal),
    facts: working.facts.filter(text => safeWorkingText(text)),
    preferences: working.preferences.filter(text => safeWorkingText(text)),
    decisions: working.decisions.filter(text => safeWorkingText(text)),
    openThreads: working.openThreads.filter(text => safeWorkingText(text)),
    updatedAt: new Date().toISOString(),
  })
  setSetting(WORKING_MEMORY_SETTING, JSON.stringify(next))
  return next
}

export function shouldObserveAfterTurn(input: { userText: string; observedThroughSeq: number; toSeq: number }): boolean {
  return EXPLICIT_MEMORY_CUE.test(input.userText) || input.toSeq - input.observedThroughSeq >= OBSERVATION_SEQ_INTERVAL
}

export async function observeAndPersistRange(input: {
  fromSeq: number
  toSeq: number
  sessionId?: string | null
  projectId?: string | null
  model?: MemoryModel
}): Promise<ObservedMemory> {
  const messages = getMessagesForRange(input.fromSeq, input.toSeq)
    .filter(message => (message.role === 'user' || message.role === 'bond') && message.text?.trim())
  const currentState = readWorkingMemoryState()
  if (messages.length === 0) return { workingState: currentState, memories: [], errors: [], prompt: '' }

  const result = await observeTranscript({
    messages,
    model: input.model ?? memoryModel(),
    currentState,
    sessionId: input.sessionId ?? currentState.sessionId,
    projectId: input.projectId ?? currentState.projectId,
  })
  if (result.errors.length) throw new Error(`Memory observer rejected output: ${result.errors.join('; ')}`)

  writeWorkingMemoryState(result.workingState)
  for (const memory of result.memories) {
    const safeText = redact(memory.text)
    if (safeText === null || safeText !== memory.text) continue
    const item = findActiveMemoryByText(memory.text) ?? upsertMemoryItem(memory)
    setMemoryItemSources(item.id, [...getMemoryItemSourceIds(item.id), ...memory.sourceIds])
  }
  return result
}

export async function reflectAndPersistRange(input: {
  fromSeq: number
  toSeq: number
  projectId?: string | null
  model?: MemoryModel
}): Promise<ReflectionResult> {
  const messages = getMessagesForRange(input.fromSeq, input.toSeq)
    .filter(message => (message.role === 'user' || message.role === 'bond') && message.text?.trim())
  if (messages.length === 0) {
    return reflectTranscript({ messages: [], model: input.model ?? memoryModel(), projectId: input.projectId, persist: false })
  }
  return withCoreMemoryLock(async () => {
    const result = await reflectTranscript({ messages, model: input.model ?? memoryModel(), projectId: input.projectId, persist: false })
    if (result.errors.length) throw new Error(`Memory reflector rejected output: ${result.errors.join('; ')}`)

    const safeCore = {
      ...result.coreMemory,
      facts: result.coreMemory.facts.filter(text => redact(text) === text),
      preferences: result.coreMemory.preferences.filter(text => redact(text) === text),
      decisions: result.coreMemory.decisions.filter(text => redact(text) === text),
      updatedAt: new Date().toISOString(),
    }
    writeCoreMemoryAtomic(safeCore)

    const memories = []
    for (const sourced of result.sourcedMemories) {
      if (redact(sourced.text) !== sourced.text) continue
      const item = findActiveMemoryByText(sourced.text) ?? upsertMemoryItem(sourced)
      setMemoryItemSources(item.id, [...getMemoryItemSourceIds(item.id), ...sourced.sourceIds])
      memories.push(item)
    }
    return { ...result, coreMemory: safeCore, memories }
  })
}

export async function observeEpochThrough(input: {
  epochId: string
  toSeq: number
  sessionId?: string | null
  model?: MemoryModel
}): Promise<void> {
  const epoch = findEpoch(input.epochId)
  if (!epoch || input.toSeq <= epoch.observedThroughSeq) return
  const fromSeq = epoch.observedThroughSeq + 1
  await observeAndPersistRange({ fromSeq, toSeq: input.toSeq, sessionId: input.sessionId, model: input.model })
  getDb().prepare('UPDATE epochs SET observed_through_seq = ? WHERE id = ?').run(input.toSeq, input.epochId)
}

export function scheduleEpochObservation(input: {
  epochId: string
  toSeq: number
  sessionId?: string | null
  userText: string
  logger?: Pick<Console, 'warn'>
}): void {
  const epoch = findEpoch(input.epochId)
  if (!epoch || !shouldObserveAfterTurn({ userText: input.userText, observedThroughSeq: epoch.observedThroughSeq, toSeq: input.toSeq })) return
  observationQueue = observationQueue
    .then(() => observeEpochThrough(input))
    .catch(error => input.logger?.warn?.(`[bond] background memory observation failed: ${error instanceof Error ? error.message : String(error)}`))
}

export async function waitForMemoryQueue(): Promise<void> {
  await observationQueue
}

/**
 * Run arbitrary deferred memory work on the serialized queue (epoch-rollover
 * hook work rides here so it never blocks the user's send).
 */
export function enqueueMemoryTask(task: () => Promise<void>, logger?: Pick<Console, 'warn'>): void {
  observationQueue = observationQueue
    .then(task)
    .catch(error => logger?.warn?.(`[bond] deferred memory task failed: ${error instanceof Error ? error.message : String(error)}`))
}

export const finalObserverHook: EpochHook = async ({ epoch, toSeq }) => {
  // This hook runs ON the observation queue (via deferHookWork), so awaiting
  // the queue here would deadlock on itself. Ordering after earlier
  // background observations is guaranteed by queue position, and
  // observeEpochThrough re-reads the marker rather than trusting the range
  // captured at scheduling time.
  await observeEpochThrough({ epochId: epoch.id, toSeq, sessionId: epoch.piSessionId })
}

export const memoryFlushHook: EpochHook = async ({ fromSeq, toSeq }) => {
  if (toSeq < fromSeq) return
  await reflectAndPersistRange({ fromSeq, toSeq })
}
