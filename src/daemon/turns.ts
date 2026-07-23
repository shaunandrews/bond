import { randomUUID } from 'node:crypto'
import type { AttachedImage, EditMode } from '../shared/session'
import type { BondSendResult } from '../shared/rpc-schema'
import type { BondStreamChunk } from '../shared/stream'
import { parseEditMode } from '../shared/session'
import { MAIN_SCOPE, scopeToThreadId, type ConversationScope } from '../shared/threads'
import { runBondQuery, buildAgentContextEnvelope } from './agent'
import { clearTurnApprovals } from './approvals'
import { clearTurnQuestions } from './questions'
import { ensureActiveEpoch } from './epochs'
import { saveImages } from './images'
import { enqueueMemoryTask, finalObserverHook, memoryFlushHook, scheduleEpochObservation, scheduleEpochReflection } from './memory/service'
import { GLOBAL_TRANSCRIPT_SESSION_ID, ensureGlobalTranscriptSession } from './sessions'
import { getSetting } from './settings'
import { completeTurn, getMaxMessageSeq, insertTurnStart, startTurn, upsertMessages } from './transcript'
import { buildThreadContextEnvelope, buildThreadRecapEnvelope, getThread, threadHasPriorTurns, touchThread } from './threads'
import { piSessionFileExists } from './pi/runtime'

/**
 * The turn runner owns every scope's active Bond turn — main and each
 * thread run their own query concurrently (plans/chat-threads.md "Turn
 * scheduling"). Within one scope it's still "a new send aborts the running
 * turn, check-abort-start made atomic by a promise-chain mutex"; starting or
 * cancelling one scope never touches another. Broadcasting and Sense stay in
 * server.ts and reach the runner via the transport (same seam style as
 * web/broker.ts's render transport).
 */
export interface TurnTransport {
  broadcastChunk(
    sessionId: string | undefined,
    chunk: BondStreamChunk,
    tags?: { epochId?: string; turnId?: string; assistantMessageId?: string; scope?: ConversationScope },
  ): void
  imagesChanged(): void
  /** A thread's turn count or status changed server-side (touchThread/insertTurnStart) — clients refresh reply counts. */
  threadChanged?: () => void
  enableSense?: () => { enabled: boolean; state?: string }
}

let transport: TurnTransport | null = null

export function setTurnTransport(t: TurnTransport | null): void {
  transport = t
}

function broadcast(
  sessionId: string | undefined,
  chunk: BondStreamChunk,
  tags?: { epochId?: string; turnId?: string; assistantMessageId?: string; scope?: ConversationScope },
): void {
  transport?.broadcastChunk(sessionId, chunk, tags)
}

export interface StartTurnInput {
  /** Omitted means the main conversation. */
  scope?: ConversationScope
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

/** One in-flight turn per scope; scopes run fully concurrently — no global gate. */
type ScopeKey = 'main' | `thread:${string}`

function scopeKey(scope: ConversationScope): ScopeKey {
  return scope.type === 'main' ? 'main' : `thread:${scope.threadId}`
}

type ActiveTurn = {
  scope: ConversationScope
  sessionId?: string
  turnId: string
  epochId?: string
  ac: AbortController
  /** Resolves when the turn's query has fully completed (or failed to start). */
  settled: Promise<void>
}

const activeByScope = new Map<ScopeKey, ActiveTurn>()
/** Same-scope queue only — a second thread's send is never blocked by main's queue or vice versa. */
const sendChainByScope = new Map<ScopeKey, Promise<void>>()
const whenIdleTasks: Array<() => void> = []

export function hasActiveTurns(): boolean {
  return activeByScope.size > 0
}

function flushWhenIdleTasks(): void {
  if (activeByScope.size > 0 || whenIdleTasks.length === 0) return
  const tasks = whenIdleTasks.splice(0)
  for (const task of tasks) {
    try { task() } catch (error) { console.warn('[bond] deferred off-turn task failed:', error) }
  }
}

/**
 * Run a synchronous transcript mutation only when no user turn is active.
 * The queue is intentionally in-memory; the agent run's durable completion
 * marker lets startup safely retry anything lost with the daemon process.
 */
export function queueWhenNoActiveTurns(task: () => void): void {
  if (activeByScope.size === 0) {
    task()
    return
  }
  whenIdleTasks.push(task)
}

/**
 * Serialize the check-abort-start sequence, but only against other sends in
 * the SAME scope. Without this, two clients sending near-simultaneously into
 * the same scope (desktop + phone) both passed the active-query check across
 * its await points and ran two concurrent Pi queries against the same epoch
 * session file — one of them uncancellable. A different scope's send is
 * never queued behind this chain at all.
 */
function enqueueForScope<T>(key: ScopeKey, task: () => Promise<T>): Promise<T> {
  const prevChain = sendChainByScope.get(key) ?? Promise.resolve()
  const result = prevChain.then(task, task)
  sendChainByScope.set(key, result.then(() => undefined, () => undefined))
  return result
}

export function getActiveTurn(scope: ConversationScope = MAIN_SCOPE): { turnId: string; epochId?: string; sessionId?: string } | null {
  const entry = activeByScope.get(scopeKey(scope))
  return entry ? { turnId: entry.turnId, epochId: entry.epochId, sessionId: entry.sessionId } : null
}

/** Resolves when the turn has STARTED — the query keeps streaming in the background. */
export function startBondTurn(input: StartTurnInput): Promise<StartTurnResult> {
  const scope = input.scope ?? MAIN_SCOPE
  const key = scopeKey(scope)
  const threadId = scopeToThreadId(scope)

  return enqueueForScope(key, async () => {
    const prev = activeByScope.get(key)
    if (prev) {
      prev.ac.abort()
      clearTurnApprovals(prev.turnId)
      clearTurnQuestions(prev.turnId)
      await prev.settled.catch(() => {})
      if (activeByScope.get(key) === prev) activeByScope.delete(key)
    }

    const turnId = input.turnId ?? randomUUID()
    const ac = new AbortController()
    let settle!: () => void
    const entry: ActiveTurn = {
      scope,
      sessionId: input.sessionId,
      turnId,
      ac,
      settled: new Promise<void>((resolve) => { settle = resolve }),
    }
    // Claim before any slow await so cancel/settle can reach a starting turn.
    activeByScope.set(key, entry)

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
      // Automatic memory observation is main-only (plans/chat-threads.md rule
      // 11) — a thread epoch's markers are seeded to never advance anyway
      // (epochs.ts NEVER_OBSERVED_MARKER), but omitting the hooks here means
      // a thread turn never even attempts the work.
      const epochResult = await ensureActiveEpoch({
        threadId,
        finalObserver: threadId ? undefined : finalObserverHook,
        memoryFlush: threadId ? undefined : memoryFlushHook,
        // Rollover observer/reflector work runs on the memory queue instead
        // of blocking this send behind LLM round-trips.
        deferHookWork: threadId ? undefined : (task) => enqueueMemoryTask(task, console),
        logger: console,
      })
      const epoch = epochResult.epoch
      entry.epochId = epoch.id
      const userMessageId = input.userMessageId ?? randomUUID()
      const assistantMessageId = input.assistantMessageId ?? randomUUID()
      const activityMessageId = input.activityMessageId ?? randomUUID()
      const tags = { epochId: epoch.id, turnId, assistantMessageId, scope }

      // Captured BEFORE insertTurnStart below — that call is what creates
      // this turn's own row, so checking after would always see it and never
      // find "no prior turns". The frozen anchor snapshot is injected exactly
      // once, ever, per thread (plans/chat-threads.md "First thread prompt").
      const isFirstThreadTurn = threadId ? !threadHasPriorTurns(threadId) : false
      // Bond's DB says this thread has history, but Pi's own on-disk session
      // for it is gone (deleted, corrupted) — without this check the model
      // would receive this turn's raw text with zero memory of anything
      // (plans/chat-threads.md Failure behavior: Pi thread session file
      // missing). Re-priming from the frozen snapshot plus a full recap of
      // the thread's own turns is the closest recovery to "nothing lost".
      const threadSessionLost = threadId && !isFirstThreadTurn ? !piSessionFileExists(epoch.piSessionId) : false
      if (threadId) touchThread(threadId)

      insertTurnStart({
        epochId: epoch.id,
        threadId,
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
      // The turn row above IS the reply count (replyCountFor counts turns),
      // and touchThread just flipped draft→open — but both happened through
      // daemon-internal calls no RPC handler broadcasts for. Without this,
      // main's cached "Discuss" footer never becomes "Thread · N".
      if (threadId) transport?.threadChanged?.()

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

      // Bond's normal envelope (memory, sense, transcript recall, epoch
      // handoff) still applies in a thread — the frozen snapshot below is
      // additional historical background, not a replacement for it.
      const baseContextEnvelope = buildAgentContextEnvelope({
        query: cleanText,
        sessionId: sessionId ?? epoch.piSessionId,
        excludeMessageIds: [userMessageId, assistantMessageId, activityMessageId],
        previousEpoch: epochResult.previousEpoch,
      })
      const threadContextBlock = (isFirstThreadTurn || threadSessionLost) && threadId ? getThread(threadId) : null
      const threadRecap = threadSessionLost && threadId ? buildThreadRecapEnvelope(threadId) : ''
      const contextEnvelope = threadContextBlock
        ? [buildThreadContextEnvelope(threadContextBlock.contextSnapshot), threadRecap, baseContextEnvelope].filter(Boolean).join('\n\n')
        : baseContextEnvelope

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
            upsertMessages([{ id: assistantMessageId, epochId: epoch.id, turnId, threadId, role: 'bond', text: assistantText }])
          }
          completeTurn({
            turnId,
            status: ac.signal.aborted ? 'cancelled' : succeeded ? 'done' : 'failed',
            contextTokens: result.contextTokens,
            contextWindow: result.contextWindow,
          })
          if (succeeded && !ac.signal.aborted && !threadId) {
            // Memory observation/reflection scheduling is main-only.
            const toSeq = getMaxMessageSeq()
            scheduleEpochObservation({
              epochId: epoch.id,
              toSeq,
              sessionId: sessionId ?? epoch.piSessionId,
              userText: cleanText,
              logger: console,
            })
            // Rollover is a backstop now, so reflection can no longer ride it.
            scheduleEpochReflection({ epochId: epoch.id, toSeq, logger: console })
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
        if (activeByScope.get(key) === entry) activeByScope.delete(key)
        clearTurnApprovals(turnId)
        clearTurnQuestions(turnId)
        broadcast(sessionId, { kind: 'query_end', succeeded }, tags)
        settle()
        flushWhenIdleTasks()
      })

      return { ok: true, queued: false, imageIds, turnId, epochId: epoch.id }
    } catch (error) {
      // Startup failed before the query launched (epoch/insert threw).
      if (activeByScope.get(key) === entry) activeByScope.delete(key)
      clearTurnApprovals(turnId)
      clearTurnQuestions(turnId)
      settle()
      flushWhenIdleTasks()
      throw error
    }
  })
}

/** bond.cancel semantics: abort the active turn in the given scope (main by default). */
export async function cancelActiveTurn(scope: ConversationScope = MAIN_SCOPE): Promise<void> {
  const key = scopeKey(scope)
  const entry = activeByScope.get(key)
  if (!entry) return
  entry.ac.abort()
  clearTurnApprovals(entry.turnId)
  clearTurnQuestions(entry.turnId)
  await entry.settled.catch(() => {})
  if (activeByScope.get(key) === entry) activeByScope.delete(key)
}

/**
 * Quiesce for a data-dir swap: abort every scope's running turn AND drain
 * anything a client managed to queue behind any of them, so no query touches
 * the swapped store. Loops until a full pass finds nothing active and no
 * scope's queue (including a brand-new scope that raced in) moved.
 */
export async function settleTurns(): Promise<void> {
  for (;;) {
    const activeEntries = [...activeByScope.entries()]
    const chainEntries = [...sendChainByScope.entries()]
    if (activeEntries.length === 0 && chainEntries.length === 0) return

    for (const [key, entry] of activeEntries) {
      entry.ac.abort()
      clearTurnApprovals(entry.turnId)
      clearTurnQuestions(entry.turnId)
      await entry.settled.catch(() => {})
      if (activeByScope.get(key) === entry) activeByScope.delete(key)
    }
    for (const [, chain] of chainEntries) {
      await chain.catch(() => {})
    }

    const nothingNew = sendChainByScope.size === chainEntries.length
      && chainEntries.every(([key, chain]) => sendChainByScope.get(key) === chain)
    if (activeByScope.size === 0 && nothingNew) return
  }
}

/** Synchronous best-effort abort for server close — no draining, every scope. */
export function abortActiveTurnForShutdown(): void {
  for (const entry of activeByScope.values()) {
    entry.ac.abort()
    clearTurnApprovals(entry.turnId)
    clearTurnQuestions(entry.turnId)
  }
  activeByScope.clear()
  // Durable producers retry uninserted completions on the next boot.
  whenIdleTasks.length = 0
}
