import type { AgentRun, AgentRunEvent, AgentRunQuestion, AgentRunState } from '../../../shared/agent-runs'
import {
  getAgentRun,
  approvedAgentRunCommandGrants,
  appendAgentRunEvent,
  listAgentRunEvents,
  listAgentRuns,
  listInterruptedAgentRuns,
  parkAgentRunForCommand,
  runsReadyToResume,
  scheduleAgentRunRetry,
  transitionAgentRun,
} from './store'
import { executeAgentRun, type AsyncAgentExecutor } from './executor'
import { CommandApprovalRequired } from './write-runner'
import { AgentResourceLimitError, classifyAgentRunFailure } from './failures'

export interface AgentRunWorkerOptions {
  execute?: AsyncAgentExecutor
  prepare?: (run: AgentRun, signal: AbortSignal) => Promise<AgentRun>
  intervalMs?: number
  onChanged?: (run: AgentRun) => void
  onTerminal?: (run: AgentRun) => void | Promise<void>
  onQuestion?: (run: AgentRun, question: AgentRunQuestion) => void
  logger?: Pick<Console, 'error' | 'warn' | 'log'>
  maxTransientRetries?: number
  retryDelayMs?: (retryNumber: number) => number
  now?: () => number
}

export interface AgentRunWorker {
  start(): void
  stop(): Promise<void>
  wake(): Promise<void>
  tickNow(): Promise<void>
  cancel(runId: string): AgentRun | null
  resume(runId: string): Promise<void>
  activeRunId(): string | null
  isRunning(): boolean
}

const DEFAULT_INTERVAL_MS = 1_000

export function agentRunActiveWallClockMs(events: AgentRunEvent[], throughMs: number): number {
  let activeSince: number | null = null
  let elapsed = 0
  for (const event of events) {
    const at = Date.parse(event.createdAt)
    if (!Number.isFinite(at)) continue
    if (activeSince === null && ['preparing-workspace', 'running'].includes(event.toState ?? '')) activeSince = at
    if (activeSince !== null && event.fromState && ['preparing-workspace', 'running'].includes(event.fromState) && !['preparing-workspace', 'running'].includes(event.toState ?? '')) {
      elapsed += Math.max(0, at - activeSince)
      activeSince = null
    }
  }
  return elapsed + (activeSince === null ? 0 : Math.max(0, throughMs - activeSince))
}

export function createAgentRunWorker(options: AgentRunWorkerOptions = {}): AgentRunWorker {
  const execute = options.execute ?? executeAgentRun
  const prepare = options.prepare ?? (async run => run)
  const logger = options.logger ?? console
  let timer: ReturnType<typeof setInterval> | null = null
  let queue: Promise<void> = Promise.resolve()
  let active: { runId: string; controller: AbortController } | null = null
  let pendingRecoveryIds: string[] = []
  let pendingResumeIds: string[] = []
  let stopping = false
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const maxTransientRetries = options.maxTransientRetries ?? 2
  const now = options.now ?? Date.now
  const retryDelayMs = options.retryDelayMs ?? (retryNumber => Math.min(30_000, 1_000 * 2 ** (retryNumber - 1)) + Math.floor(Math.random() * 500))

  const emit = (run: AgentRun): void => options.onChanged?.(run)
  const terminal = async (run: AgentRun): Promise<void> => {
    emit(run)
    await options.onTerminal?.(run)
  }

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch(error => {
      logger.error('[agents/worker] task failed:', error)
    })
    return queue
  }

  const scheduleRecovery = (run: AgentRun): void => {
    if (pendingRecoveryIds.includes(run.id) || retryTimers.has(run.id)) return
    const delay = run.nextRetryAt ? Math.max(0, Date.parse(run.nextRetryAt) - now()) : 0
    if (delay <= 0) {
      pendingRecoveryIds.push(run.id)
      return
    }
    const timer = setTimeout(() => {
      retryTimers.delete(run.id)
      if (!pendingRecoveryIds.includes(run.id)) pendingRecoveryIds.push(run.id)
      void enqueue(drainOne)
    }, delay)
    timer.unref?.()
    retryTimers.set(run.id, timer)
  }

  function change(runId: string, to: AgentRunState, eventType: string, data: Record<string, unknown> = {}): AgentRun {
    const run = transitionAgentRun(runId, to, { eventType, data })
    emit(run)
    return run
  }

  async function runOne(initial: AgentRun, recovering: boolean, resuming = false): Promise<void> {
    let prepared: AgentRun
    try {
      prepared = resuming ? initial : change(initial.id, 'preparing-workspace', recovering ? 'recovery_preparing' : 'workspace_preparing')
    } catch (error) {
      logger.warn('[agents/worker] could not prepare run:', error)
      return
    }

    const controller = new AbortController()
    active = { runId: prepared.id, controller }
    let started = false
    let wallClockExpired = false
    const wallClockBudgetMs = Math.max(1, prepared.resourceCaps.wallClockSeconds) * 1_000
    const wallClockRemainingMs = Math.max(1, wallClockBudgetMs - agentRunActiveWallClockMs(listAgentRunEvents(prepared.id), now()))
    const wallClockTimer = setTimeout(() => {
      wallClockExpired = true
      controller.abort()
    }, wallClockRemainingMs)
    wallClockTimer.unref?.()
    try {
      prepared = await prepare(prepared, controller.signal)
      const report = await execute(prepared, {
        signal: controller.signal,
        events: listAgentRunEvents(prepared.id),
        exactCommandGrants: approvedAgentRunCommandGrants(prepared.id),
        onProgress: (type, data, checkpoint) => {
          const updated = appendAgentRunEvent(prepared.id, type, data, { checkpoint })
          emit(updated)
        },
        onStarted: (checkpoint) => {
          if (started) return
          started = true
          const current = getAgentRun(prepared.id)
          if (!current || current.status === 'cancelled') return
          const running = transitionAgentRun(prepared.id, 'running', {
            eventType: resuming ? 'command_resume_started' : recovering ? 'recovery_started' : 'started',
            checkpoint,
          })
          emit(running)
        },
      })

      const current = getAgentRun(prepared.id)
      if (!current || current.status === 'cancelled' || controller.signal.aborted) return
      if (!started || current.status !== 'running') {
        throw new Error('Background agent executor returned before recording its start checkpoint.')
      }
      await terminal(transitionAgentRun(prepared.id, 'succeeded', { eventType: 'succeeded', result: report }))
    } catch (caught) {
      const current = getAgentRun(prepared.id)
      if (!current || current.status === 'cancelled') return
      const error = wallClockExpired
        ? new AgentResourceLimitError(`Agent run exceeded the ${prepared.resourceCaps.wallClockSeconds}s wall-clock cap.`)
        : caught
      if (error instanceof CommandApprovalRequired && current.status === 'running') {
        const parked = parkAgentRunForCommand(prepared.id, error.question, {
          phase: 'awaiting-command-approval',
          worktree: prepared.workspace.isolation === 'worktree' ? prepared.workspace.worktreePath : null,
          pendingArgv: error.question.argv,
          lastCompletedAction: 'agent-requested-command',
        })
        emit(parked.run)
        options.onQuestion?.(parked.run, parked.question)
        return
      }
      // Graceful daemon shutdown leaves the durable state live. The next boot
      // marks it interrupted and re-enters from the checkpoint.
      if (stopping && controller.signal.aborted) return
      const failure = classifyAgentRunFailure(error)
      const message = failure.message
      if (failure.retryable && current.retryCount < maxTransientRetries && ['preparing-workspace', 'running'].includes(current.status)) {
        const retryNumber = current.retryCount + 1
        const nextRetryAt = new Date(now() + retryDelayMs(retryNumber)).toISOString()
        const interrupted = scheduleAgentRunRetry(prepared.id, failure.errorClass, message, nextRetryAt)
        emit(interrupted)
        scheduleRecovery(interrupted)
        return
      }
      if (recovering && !started && current.status === 'preparing-workspace') {
        await terminal(transitionAgentRun(prepared.id, 'failed', {
          eventType: 'recovery_failed',
          errorClass: 'recovery',
          errorMessage: message,
        }))
        return
      }
      if (current.status === 'preparing-workspace' || current.status === 'running') {
        await terminal(transitionAgentRun(prepared.id, 'failed', {
          eventType: 'failed',
          errorClass: failure.errorClass,
          errorMessage: message,
        }))
      }
    } finally {
      clearTimeout(wallClockTimer)
      if (active?.runId === prepared.id) active = null
    }
  }

  async function drainOne(): Promise<void> {
    if (active || stopping) return
    let candidate: AgentRun | null = null
    let recovering = false
    let resuming = false
    while (pendingResumeIds.length && !candidate) {
      const id = pendingResumeIds.shift()!
      const run = getAgentRun(id)
      if (run?.status === 'needs-input' && approvedAgentRunCommandGrants(id).size) {
        candidate = run
        resuming = true
      }
    }
    while (pendingRecoveryIds.length && !candidate) {
      const id = pendingRecoveryIds.shift()!
      const run = getAgentRun(id)
      if (run?.status === 'interrupted') {
        candidate = run
        recovering = true
      }
    }
    candidate ??= listAgentRuns({ statuses: ['queued'], limit: 1 })[0] ?? null
    if (candidate) await runOne(candidate, recovering, resuming)
  }

  function reconcileStrandedRuns(): void {
    const stranded = listAgentRuns({ statuses: ['preparing-workspace', 'running'], limit: 500 })
    for (const run of stranded) {
      const interrupted = transitionAgentRun(run.id, 'interrupted', {
        eventType: 'daemon_interrupted',
        data: { previousState: run.status },
        errorClass: 'interrupted',
        errorMessage: 'The daemon stopped before this read-only run completed.',
      })
      emit(interrupted)
    }
    // Existing interrupted rows and the rows just reconciled each receive one
    // recovery attempt this boot. A failed checkpoint recovery stays parked.
    pendingRecoveryIds = []
    for (const run of listInterruptedAgentRuns()) {
      if (run.recoveryCount >= 3) {
        void terminal(transitionAgentRun(run.id, 'failed', {
          eventType: 'recovery_exhausted',
          errorClass: 'recovery',
          errorMessage: 'The run was interrupted repeatedly and exhausted its recovery budget.',
        }))
      } else {
        scheduleRecovery(run)
      }
    }
    pendingResumeIds = runsReadyToResume().map(run => run.id)
  }

  return {
    start(): void {
      if (timer) return
      stopping = false
      reconcileStrandedRuns()
      timer = setInterval(() => {
        // Do not accumulate interval callbacks behind a minutes-long run.
        if (!active) void enqueue(drainOne)
      }, options.intervalMs ?? DEFAULT_INTERVAL_MS)
      timer.unref?.()
      void enqueue(drainOne)
    },

    async stop(): Promise<void> {
      stopping = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      active?.controller.abort()
      pendingRecoveryIds = []
      pendingResumeIds = []
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      await queue
    },

    wake: () => enqueue(drainOne),
    tickNow: () => enqueue(drainOne),

    cancel(runId: string): AgentRun | null {
      const current = getAgentRun(runId)
      if (!current) return null
      if (['succeeded', 'failed', 'cancelled'].includes(current.status)) return current
      const cancelled = transitionAgentRun(runId, 'cancelled', { eventType: 'cancelled' })
      if (active?.runId === runId) active.controller.abort()
      void terminal(cancelled)
      return cancelled
    },

    resume(runId: string): Promise<void> {
      if (!pendingResumeIds.includes(runId)) pendingResumeIds.push(runId)
      return enqueue(drainOne)
    },

    activeRunId: () => active?.runId ?? null,
    isRunning: () => timer !== null,
  }
}
