import { randomUUID } from 'node:crypto'
import type { AttachedImage, EditMode } from '../shared/session'
import type { BondSendResult } from '../shared/rpc-schema'
import type { BondStreamChunk } from '../shared/stream'
import { parseEditMode } from '../shared/session'
import { runBondQuery, buildAgentContextEnvelope } from './agent'
import { clearTurnApprovals } from './approvals'
import { clearTurnQuestions } from './questions'
import { ensureActiveEpoch } from './epochs'
import { saveImages } from './images'
import { enqueueMemoryTask, finalObserverHook, memoryFlushHook, scheduleEpochObservation } from './memory/service'
import { GLOBAL_TRANSCRIPT_SESSION_ID, ensureGlobalTranscriptSession } from './sessions'
import { getSetting } from './settings'
import { completeTurn, getMaxMessageSeq, insertTurnStart, startTurn, upsertMessages } from './transcript'

/**
 * The turn runner owns the active Bond turn: one query at a time, "a new send
 * aborts the running turn", check-abort-start made atomic by a promise-chain
 * mutex. Broadcasting and Sense stay in server.ts and reach the runner via
 * the transport (same seam style as web/broker.ts's render transport).
 */
export interface TurnTransport {
  broadcastChunk(
    sessionId: string | undefined,
    chunk: BondStreamChunk,
    tags?: { epochId?: string; turnId?: string; assistantMessageId?: string },
  ): void
  imagesChanged(): void
  enableSense?: () => { enabled: boolean; state?: string }
}

let transport: TurnTransport | null = null

export function setTurnTransport(t: TurnTransport | null): void {
  transport = t
}

function broadcast(
  sessionId: string | undefined,
  chunk: BondStreamChunk,
  tags?: { epochId?: string; turnId?: string; assistantMessageId?: string },
): void {
  transport?.broadcastChunk(sessionId, chunk, tags)
}

export interface StartTurnInput {
  /** Already-trimmed user text. */
  text: string
  sessionId?: string
  images?: AttachedImage[]
  turnId?: string
  userMessageId?: string
  assistantMessageId?: string
  activityMessageId?: string
  /** Caller-resolved mode (per-turn input or legacy session); falls back to the persisted global setting. */
  editMode?: EditMode
  model: string
}

export type StartTurnResult = BondSendResult

type ActiveTurn = {
  sessionId?: string
  turnId: string
  epochId?: string
  ac: AbortController
  /** Resolves when the turn's query has fully completed (or failed to start). */
  settled: Promise<void>
}

let active: ActiveTurn | null = null
let sendChain: Promise<void> = Promise.resolve()

/**
 * Serialize the whole check-abort-start sequence. Without this, two clients
 * sending near-simultaneously (desktop + phone) both passed the active-query
 * check across its await points and ran two concurrent Pi queries against
 * the same epoch session file — one of them uncancellable.
 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = sendChain.then(task, task)
  sendChain = result.then(() => undefined, () => undefined)
  return result
}

export function getActiveTurn(): { turnId: string; epochId?: string; sessionId?: string } | null {
  return active ? { turnId: active.turnId, epochId: active.epochId, sessionId: active.sessionId } : null
}

/** Resolves when the turn has STARTED — the query keeps streaming in the background. */
export function startBondTurn(input: StartTurnInput): Promise<StartTurnResult> {
  return enqueue(async () => {
    const prev = active
    if (prev) {
      prev.ac.abort()
      clearTurnApprovals(prev.turnId)
      clearTurnQuestions(prev.turnId)
      await prev.settled.catch(() => {})
      if (active === prev) active = null
    }

    const turnId = input.turnId ?? randomUUID()
    const ac = new AbortController()
    let settle!: () => void
    const entry: ActiveTurn = {
      sessionId: input.sessionId,
      turnId,
      ac,
      settled: new Promise<void>((resolve) => { settle = resolve }),
    }
    // Claim before any slow await so cancel/settle can reach a starting turn.
    active = entry

    try {
      const sessionId = input.sessionId
      let imageIds: string[] | undefined
      if (input.images?.length) {
        if (!sessionId) ensureGlobalTranscriptSession()
        imageIds = saveImages(sessionId ?? GLOBAL_TRANSCRIPT_SESSION_ID, input.images)
        // Chat attachments land in the media library too — without this the
        // Media panel sits on "No images uploaded yet" until an app restart.
        transport?.imagesChanged()
      }

      const cleanText = input.text.replace(/@\[([^\]]+)\]\(project:[a-f0-9-]+\)/g, '@$1')
      const epochResult = await ensureActiveEpoch({
        finalObserver: finalObserverHook,
        memoryFlush: memoryFlushHook,
        // Rollover observer/reflector work runs on the memory queue instead
        // of blocking this send behind LLM round-trips.
        deferHookWork: (task) => enqueueMemoryTask(task, console),
        logger: console,
      })
      const epoch = epochResult.epoch
      entry.epochId = epoch.id
      const userMessageId = input.userMessageId ?? randomUUID()
      const assistantMessageId = input.assistantMessageId ?? randomUUID()
      const activityMessageId = input.activityMessageId ?? randomUUID()
      const tags = { epochId: epoch.id, turnId, assistantMessageId }

      insertTurnStart({
        epochId: epoch.id,
        turnId,
        userMessageId,
        assistantMessageId,
        activityMessageId,
        text: cleanText,
        model: input.model,
        imageIds,
        activityData: { turnId, userMessageId, assistantMessageId, status: 'working', startedAt: Date.now(), events: [] },
      })
      startTurn(turnId, epoch.id)

      // Tell every other live viewer about this turn's user message and
      // message ids. Without this, a second client (desktop vs. phone)
      // streams the response but never shows the user bubble, and mints a
      // duplicate activity row under its own id. The sender dedupes by id.
      broadcast(sessionId, {
        kind: 'turn_start',
        turnId,
        userMessageId,
        assistantMessageId,
        activityMessageId,
        text: cleanText,
        imageIds,
      }, tags)

      const contextEnvelope = buildAgentContextEnvelope({
        query: cleanText,
        sessionId: sessionId ?? epoch.piSessionId,
        excludeMessageIds: [userMessageId, assistantMessageId, activityMessageId],
        previousEpoch: epochResult.previousEpoch,
      })

      let assistantText = ''
      const runQuery = async (): Promise<boolean> => {
        // A cancel that lands during startup aborts before Pi launches — an
        // already-aborted signal never fires listeners added later, so check
        // here instead of relying on the abort listener.
        if (ac.signal.aborted) {
          completeTurn({ turnId, status: 'cancelled' })
          return false
        }
        try {
          const result = await runBondQuery(cleanText, {
            abortSignal: ac.signal,
            turnId,
            onChunk: (chunk) => {
              if (chunk.kind === 'assistant_text') assistantText += chunk.text
              // Generated images land in the media library too, like attachments.
              if (chunk.kind === 'generated_image') transport?.imagesChanged()
              broadcast(sessionId, chunk.kind === 'assistant_text' ? { ...chunk, assistantMessageId } : chunk, tags)
            },
            model: input.model,
            sessionId: sessionId ?? epoch.piSessionId,
            piSessionId: epoch.piSessionId,
            imageIds,
            editMode: input.editMode ?? parseEditMode(getSetting('edit_mode')),
            contextEnvelope,
            memorySourceMessageId: userMessageId,
            onboardingHooks: {
              // Lets the tour's enable_sense tool flip Sense on after explicit
              // user consent — same path as the Settings toggle.
              enableSense: () => transport?.enableSense?.() ?? { enabled: false },
            },
          })
          const succeeded = result.succeeded
          if (assistantText.trim()) {
            upsertMessages([{ id: assistantMessageId, epochId: epoch.id, turnId, role: 'bond', text: assistantText }])
          }
          completeTurn({
            turnId,
            status: ac.signal.aborted ? 'cancelled' : succeeded ? 'done' : 'failed',
            contextTokens: result.contextTokens,
            contextWindow: result.contextWindow,
          })
          if (succeeded && !ac.signal.aborted) {
            scheduleEpochObservation({
              epochId: epoch.id,
              toSeq: getMaxMessageSeq(),
              sessionId: sessionId ?? epoch.piSessionId,
              userText: cleanText,
              logger: console,
            })
          }
          return succeeded
        } catch (error) {
          completeTurn({ turnId, status: ac.signal.aborted ? 'cancelled' : 'failed' })
          broadcast(sessionId, { kind: 'raw_error', message: error instanceof Error ? error.message : String(error) }, tags)
          return false
        }
      }

      const queryPromise = runQuery()
      broadcast(sessionId, { kind: 'query_start' }, tags)

      void queryPromise.then((succeeded) => {
        if (active === entry) active = null
        clearTurnApprovals(turnId)
        clearTurnQuestions(turnId)
        broadcast(sessionId, { kind: 'query_end', succeeded }, tags)
        settle()
      })

      return { ok: true, queued: false, imageIds, turnId, epochId: epoch.id }
    } catch (error) {
      // Startup failed before the query launched (epoch/insert threw).
      if (active === entry) active = null
      clearTurnApprovals(turnId)
      clearTurnQuestions(turnId)
      settle()
      throw error
    }
  })
}

/** bond.cancel semantics: abort the active turn (optionally scoped to a legacy session id). */
export async function cancelActiveTurn(sessionId?: string): Promise<void> {
  const entry = active
  if (!entry) return
  if (sessionId && entry.sessionId !== sessionId) return
  entry.ac.abort()
  clearTurnApprovals(entry.turnId)
  clearTurnQuestions(entry.turnId)
  await entry.settled.catch(() => {})
  if (active === entry) active = null
}

/**
 * Quiesce for a data-dir swap: abort the running turn AND drain anything a
 * client managed to queue behind it, so no query touches the swapped store.
 */
export async function settleTurns(): Promise<void> {
  for (;;) {
    const entry = active
    if (entry) {
      entry.ac.abort()
      clearTurnApprovals(entry.turnId)
      clearTurnQuestions(entry.turnId)
      await entry.settled.catch(() => {})
      if (active === entry) active = null
    }
    const chainAtStart = sendChain
    await chainAtStart.catch(() => {})
    if (!active && sendChain === chainAtStart) return
  }
}

/** Synchronous best-effort abort for server close — no draining. */
export function abortActiveTurnForShutdown(): void {
  if (active) {
    active.ac.abort()
    clearTurnApprovals(active.turnId)
    clearTurnQuestions(active.turnId)
    active = null
  }
}
