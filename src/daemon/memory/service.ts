import { getDb } from '../db'
import type { EpochHook } from '../epochs'
import { findEpoch } from '../epochs'
import { getLibraryDir } from '../library'
import { getSkillsDir } from '../paths'
import { getSetting, setSetting } from '../settings'
import { getMessagesForRange } from '../transcript'
import { runPiTextPrompt } from '../pi/runtime'
import { redact } from '../sense/redaction'
import { workingPatchFromToolEvent, type ArtifactDeps, type ToolEndEvent } from './artifacts'
import { readCoreMemory, withCoreMemoryLock, writeCoreMemoryAtomic } from './core-memory'
import { recordMemoryRun, type MemoryRunOutcome } from './ledger'
import { observeTranscript, type MemoryModel, type ObservedMemory, type SkippedMemory } from './observer'
import { reflectTranscript, type ReflectionResult } from './reflector'
import { findActiveMemoryByText, getMemoryItemSourceIds, setMemoryItemSources, upsertMemoryItem } from './store'
import { appendUnique, createWorkingState, mergeWorkingState } from './working-state'
import { MEMORY_CAPS, type CoreMemory, type WorkingArtifact, type WorkingState } from './types'

const WORKING_MEMORY_SETTING = 'memory.working'
const OBSERVATION_SEQ_INTERVAL = 24
/** Reflection is expensive and slow-moving; it does not need the observer's cadence. */
const REFLECTION_SEQ_INTERVAL = 200
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

/**
 * Nothing persists without passing `redact()` — the `desk/signature.ts`
 * philosophy. A ref that trips redaction drops the whole artifact (the ref IS
 * the payload); a label that trips it drops only the label.
 */
function safeArtifact(artifact: WorkingArtifact): WorkingArtifact | null {
  if (redact(artifact.ref) !== artifact.ref) return null
  if (artifact.label && redact(artifact.label) !== artifact.label) {
    return { kind: artifact.kind, ref: artifact.ref, lastTouchedAt: artifact.lastTouchedAt }
  }
  return artifact
}

export function writeWorkingMemoryState(working: WorkingState): WorkingState {
  const goal = safeWorkingText(working.goal)
  const facts = working.facts.filter(text => safeWorkingText(text))
  const preferences = working.preferences.filter(text => safeWorkingText(text))
  const decisions = working.decisions.filter(text => safeWorkingText(text))
  const openThreads = working.openThreads.filter(text => safeWorkingText(text))
  const artifacts = working.artifacts.map(safeArtifact).filter((a): a is WorkingArtifact => a !== null)
  const checkpoint = working.checkpoint ? safeWorkingText(working.checkpoint) || null : null
  const activeSkill = working.activeSkill ? safeWorkingText(working.activeSkill) || null : null

  // Fail-closed on redaction is correct; failing closed SILENTLY is the disease
  // this whole work item treats. Counts only — never the dropped content.
  const dropped = (working.goal && !goal ? 1 : 0)
    + (working.checkpoint && !checkpoint ? 1 : 0)
    + (working.activeSkill && !activeSkill ? 1 : 0)
    + (working.facts.length - facts.length)
    + (working.preferences.length - preferences.length)
    + (working.decisions.length - decisions.length)
    + (working.openThreads.length - openThreads.length)
    + (working.artifacts.length - artifacts.length)
  if (dropped > 0) console.warn(`[bond] working memory: ${dropped} item(s) dropped by redaction before persist`)

  const next = createWorkingState({ ...working, goal, facts, preferences, decisions, openThreads, artifacts, activeSkill, checkpoint, updatedAt: new Date().toISOString() })
  setSetting(WORKING_MEMORY_SETTING, JSON.stringify(next))
  return next
}

export function shouldObserveAfterTurn(input: { userText: string; observedThroughSeq: number; toSeq: number }): boolean {
  return EXPLICIT_MEMORY_CUE.test(input.userText) || input.toSeq - input.observedThroughSeq >= OBSERVATION_SEQ_INTERVAL
}

export interface MemoryRunReport {
  outcome: MemoryRunOutcome
  persistedCount: number
  skippedCount: number
  reason: string | null
}

export type ObservedRangeResult = ObservedMemory & MemoryRunReport

function skipReason(skipped: SkippedMemory[]): string | null {
  if (skipped.length === 0) return null
  return skipped.slice(0, 3).map(s => (s.index != null ? `memories[${s.index}]: ` : '') + s.reason).join('; ')
}

/**
 * Validation failures degrade the record; they never fail the run. The ONLY
 * exception is a `model.generate` throw (transport/provider failure) — that
 * propagates, because it is the one case where the range genuinely has not
 * been looked at and the caller must not advance its marker.
 */
export async function observeAndPersistRange(input: {
  fromSeq: number
  toSeq: number
  sessionId?: string | null
  projectId?: string | null
  model?: MemoryModel
}): Promise<ObservedRangeResult> {
  const messages = getMessagesForRange(input.fromSeq, input.toSeq)
    .filter(message => (message.role === 'user' || message.role === 'bond') && message.text?.trim())
  const currentState = readWorkingMemoryState()
  if (messages.length === 0) {
    recordMemoryRun({ kind: 'observer', rangeFrom: input.fromSeq, rangeTo: input.toSeq, outcome: 'empty' })
    return { workingState: currentState, memories: [], skipped: [], errors: [], prompt: '', outcome: 'empty', persistedCount: 0, skippedCount: 0, reason: null }
  }

  const run = () => observeTranscript({
    messages,
    model: input.model ?? memoryModel(),
    currentState,
    sessionId: input.sessionId ?? currentState.sessionId,
    projectId: input.projectId ?? currentState.projectId,
  })

  let result: ObservedMemory
  try {
    result = await run()
    // A non-JSON response is usually a one-off formatting slip; one retry is
    // cheap next to losing the range.
    if (result.errors.length) result = await run()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    recordMemoryRun({ kind: 'observer', rangeFrom: input.fromSeq, rangeTo: input.toSeq, outcome: 'transport_failed', reason })
    throw error
  }

  writeWorkingMemoryState(result.workingState)
  let persistedCount = 0
  for (const memory of result.memories) {
    const safeText = redact(memory.text)
    if (safeText === null || safeText !== memory.text) {
      result.skipped.push({ text: memory.text.slice(0, 80), reason: 'redacted before persist' })
      continue
    }
    const item = findActiveMemoryByText(memory.text) ?? upsertMemoryItem(memory)
    setMemoryItemSources(item.id, [...getMemoryItemSourceIds(item.id), ...memory.sourceIds])
    persistedCount += 1
  }

  const outcome: MemoryRunOutcome = result.errors.length ? 'parse_failed' : result.skipped.length ? 'partial' : 'ok'
  const reason = result.errors.length ? result.errors.join('; ') : skipReason(result.skipped)
  recordMemoryRun({ kind: 'observer', rangeFrom: input.fromSeq, rangeTo: input.toSeq, outcome, persistedCount, skippedCount: result.skipped.length, reason })
  if (outcome !== 'ok') console.warn(`[bond] memory observer ${outcome} for seqs ${input.fromSeq}-${input.toSeq}: ${reason ?? 'no detail'}`)
  return { ...result, outcome, persistedCount, skippedCount: result.skipped.length, reason }
}

export type ReflectedRangeResult = ReflectionResult & MemoryRunReport

/**
 * Core memory is ADDITIVE (Finding 7). The reflector may add and rephrase; it
 * may never remove. Removal is a user act — `memory_manage`, `memory.updateCore`,
 * MemoryView. A `fast`-tier model rewriting the whole file every reflection is
 * how a week of daily use produced nine core items.
 */
export async function reflectAndPersistRange(input: {
  fromSeq: number
  toSeq: number
  projectId?: string | null
  model?: MemoryModel
}): Promise<ReflectedRangeResult> {
  const messages = getMessagesForRange(input.fromSeq, input.toSeq)
    .filter(message => (message.role === 'user' || message.role === 'bond') && message.text?.trim())
  if (messages.length === 0) {
    const empty = await reflectTranscript({ messages: [], model: input.model ?? memoryModel(), projectId: input.projectId, persist: false })
    recordMemoryRun({ kind: 'reflector', rangeFrom: input.fromSeq, rangeTo: input.toSeq, outcome: 'empty' })
    return { ...empty, outcome: 'empty', persistedCount: 0, skippedCount: 0, reason: null }
  }
  return withCoreMemoryLock(async () => {
    const run = () => reflectTranscript({ messages, model: input.model ?? memoryModel(), projectId: input.projectId, persist: false })

    let result: ReflectionResult
    try {
      result = await run()
      if (result.errors.length) result = await run()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      recordMemoryRun({ kind: 'reflector', rangeFrom: input.fromSeq, rangeTo: input.toSeq, outcome: 'transport_failed', reason })
      throw error
    }

    const existing = readCoreMemory()
    const additions = result.errors.length ? { facts: [], preferences: [], decisions: [] } : {
      facts: result.coreMemory.facts.filter(text => redact(text) === text),
      preferences: result.coreMemory.preferences.filter(text => redact(text) === text),
      decisions: result.coreMemory.decisions.filter(text => redact(text) === text),
    }
    const mergedCore: CoreMemory = {
      version: 1,
      facts: appendUnique(existing.facts, additions.facts, MEMORY_CAPS.coreFacts, MEMORY_CAPS.coreItemChars),
      preferences: appendUnique(existing.preferences, additions.preferences, MEMORY_CAPS.corePreferences, MEMORY_CAPS.coreItemChars),
      decisions: appendUnique(existing.decisions, additions.decisions, MEMORY_CAPS.coreDecisions, MEMORY_CAPS.coreItemChars),
      updatedAt: new Date().toISOString(),
    }
    const addedCore = (mergedCore.facts.length - existing.facts.length)
      + (mergedCore.preferences.length - existing.preferences.length)
      + (mergedCore.decisions.length - existing.decisions.length)
    writeCoreMemoryAtomic(mergedCore)

    const memories = []
    let persistedCount = 0
    for (const sourced of result.sourcedMemories) {
      if (redact(sourced.text) !== sourced.text) {
        result.skipped.push({ text: sourced.text.slice(0, 80), reason: 'redacted before persist' })
        continue
      }
      const item = findActiveMemoryByText(sourced.text) ?? upsertMemoryItem(sourced)
      setMemoryItemSources(item.id, [...getMemoryItemSourceIds(item.id), ...sourced.sourceIds])
      memories.push(item)
      persistedCount += 1
    }

    const outcome: MemoryRunOutcome = result.errors.length ? 'parse_failed' : result.skipped.length ? 'partial' : 'ok'
    const detail = result.errors.length ? result.errors.join('; ') : skipReason(result.skipped)
    const reason = [`+${addedCore} core`, detail].filter(Boolean).join(' · ')
    recordMemoryRun({ kind: 'reflector', rangeFrom: input.fromSeq, rangeTo: input.toSeq, outcome, persistedCount, skippedCount: result.skipped.length, reason })
    if (outcome !== 'ok') console.warn(`[bond] memory reflector ${outcome} for seqs ${input.fromSeq}-${input.toSeq}: ${detail ?? 'no detail'}`)
    return { ...result, coreMemory: mergedCore, memories, outcome, persistedCount, skippedCount: result.skipped.length, reason }
  })
}

/**
 * An epoch's duty is its OWN messages. `createEpoch` seeds markers at birth,
 * but epochs created before that fix still carry 0 — and a 0 marker means
 * "reflect/observe from seq 1", i.e. the entire transcript. Clamping to the
 * epoch's first message heals those rows lazily instead of requiring a
 * migration, and is a no-op for correctly seeded epochs.
 */
function rangeStartFor(epochId: string, markerSeq: number): number {
  const fromMarker = markerSeq + 1
  const row = getDb().prepare('SELECT MIN(seq) AS seq FROM messages WHERE epoch_id = ?').get(epochId) as { seq: number | null }
  return row.seq == null ? fromMarker : Math.max(fromMarker, row.seq)
}

export async function observeEpochThrough(input: {
  epochId: string
  toSeq: number
  sessionId?: string | null
  model?: MemoryModel
}): Promise<void> {
  const epoch = findEpoch(input.epochId)
  if (!epoch || input.toSeq <= epoch.observedThroughSeq) return
  const fromSeq = rangeStartFor(epoch.id, epoch.observedThroughSeq)
  // Throws only on transport failure — the one case where the range was never
  // looked at. Everything else advances: a range that failed validation and
  // stays unmarked is retried forever, growing each time, failing harder each
  // time, and burning a model call on every turn while it does.
  await observeAndPersistRange({ fromSeq, toSeq: input.toSeq, sessionId: input.sessionId, model: input.model })
  getDb().prepare('UPDATE epochs SET observed_through_seq = ? WHERE id = ?').run(input.toSeq, input.epochId)
}

/**
 * Reflection used to run ONLY at rollover. With rollover demoted to a rare
 * backstop (epochs.ts's soft-limit ratio), an epoch can live for days, so
 * reflection has to have its own cadence or core memory would never grow.
 * Safe to run mid-epoch now that core is additive.
 */
export async function reflectEpochThrough(input: {
  epochId: string
  toSeq: number
  model?: MemoryModel
}): Promise<void> {
  const epoch = findEpoch(input.epochId)
  if (!epoch || input.toSeq <= epoch.reflectedThroughSeq) return
  const fromSeq = rangeStartFor(epoch.id, epoch.reflectedThroughSeq)
  await reflectAndPersistRange({ fromSeq, toSeq: input.toSeq, model: input.model })
  getDb().prepare('UPDATE epochs SET reflected_through_seq = ? WHERE id = ?').run(input.toSeq, input.epochId)
}

export function shouldReflectAfterTurn(input: { reflectedThroughSeq: number; toSeq: number }): boolean {
  return input.toSeq - input.reflectedThroughSeq >= REFLECTION_SEQ_INTERVAL
}

export function scheduleEpochReflection(input: {
  epochId: string
  toSeq: number
  logger?: Pick<Console, 'warn'>
}): void {
  const epoch = findEpoch(input.epochId)
  if (!epoch || !shouldReflectAfterTurn({ reflectedThroughSeq: epoch.reflectedThroughSeq, toSeq: input.toSeq })) return
  observationQueue = observationQueue
    .then(() => reflectEpochThrough(input))
    .catch(error => input.logger?.warn?.(`[bond] background memory reflection failed: ${error instanceof Error ? error.message : String(error)}`))
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

/**
 * Runs ON the memory queue: the observer also read-modify-writes
 * `memory.working`, and two unserialized writers would lose updates. Never
 * throws — an artifact-capture bug must not break a turn or stall the queue.
 */
export function recordToolEventArtifacts(event: ToolEndEvent, deps?: Partial<ArtifactDeps>): void {
  let patch: Partial<WorkingState> | null = null
  try {
    patch = workingPatchFromToolEvent(event, {
      libraryDir: deps?.libraryDir ?? getLibraryDir(),
      skillsDir: deps?.skillsDir ?? getSkillsDir(),
      now: deps?.now,
    })
  } catch (error) {
    console.warn(`[bond] artifact capture failed for ${event.toolName}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!patch) return

  const resolved = patch
  enqueueMemoryTask(async () => {
    writeWorkingMemoryState(mergeWorkingState(readWorkingMemoryState(), resolved))
  }, console)
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
