import type { AgentRun, AgentRunState } from '../../../shared/agent-runs'
import {
  getAgentRun,
  listAgentRunEvents,
  listAgentRuns,
  transitionAgentRun,
} from './store'
import { executeReadOnlyAgentRun, type AsyncAgentExecutor } from './executor'

export interface AgentRunWorkerOptions {
  execute?: AsyncAgentExecutor
  intervalMs?: number
  onChanged?: (run: AgentRun) => void
  onTerminal?: (run: AgentRun) => void
  logger?: Pick<Console, 'error' | 'warn' | 'log'>
}

export interface AgentRunWorker {
  start(): void
  stop(): Promise<void>
  wake(): Promise<void>
  tickNow(): Promise<void>
  cancel(runId: string): AgentRun | null
  activeRunId(): string | null
  isRunning(): boolean
}

const DEFAULT_INTERVAL_MS = 1_000

export function createAgentRunWorker(options: AgentRunWorkerOptions = {}): AgentRunWorker {
  const execute = options.execute ?? executeReadOnlyAgentRun
  const logger = options.logger ?? console
  let timer: ReturnType<typeof setInterval> | null = null
  let queue: Promise<void> = Promise.resolve()
  let active: { runId: string; controller: AbortController } | null = null
  let pendingRecoveryIds: string[] = []
  let stopping = false

  const emit = (run: AgentRun): void => options.onChanged?.(run)
  const terminal = (run: AgentRun): void => {
    emit(run)
    options.onTerminal?.(run)
  }

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch(error => {
      logger.error('[agents/worker] task failed:', error)
    })
    return queue
  }

  function change(runId: string, to: AgentRunState, eventType: string, data: Record<string, unknown> = {}): AgentRun {
    const run = transitionAgentRun(runId, to, { eventType, data })
    emit(run)
    return run
  }

  async function runOne(initial: AgentRun, recovering: boolean): Promise<void> {
    let prepared: AgentRun
    try {
      prepared = change(initial.id, 'preparing-workspace', recovering ? 'recovery_preparing' : 'workspace_preparing')
    } catch (error) {
      logger.warn('[agents/worker] could not prepare run:', error)
      return
    }

    const controller = new AbortController()
    active = { runId: prepared.id, controller }
    let started = false
    try {
      const report = await execute(prepared, {
        signal: controller.signal,
        events: listAgentRunEvents(prepared.id),
        onStarted: (checkpoint) => {
          if (started) return
          started = true
          const current = getAgentRun(prepared.id)
          if (!current || current.status === 'cancelled') return
          const running = transitionAgentRun(prepared.id, 'running', {
            eventType: recovering ? 'recovery_started' : 'started',
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
      terminal(transitionAgentRun(prepared.id, 'succeeded', { eventType: 'succeeded', result: report }))
    } catch (error) {
      const current = getAgentRun(prepared.id)
      if (!current || current.status === 'cancelled') return
      // Graceful daemon shutdown leaves the durable state live. The next boot
      // marks it interrupted and re-enters from the checkpoint.
      if (stopping && controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      if (recovering && !started && current.status === 'preparing-workspace') {
        const interrupted = transitionAgentRun(prepared.id, 'interrupted', {
          eventType: 'recovery_failed',
          errorClass: 'recovery',
          errorMessage: message,
        })
        emit(interrupted)
        return
      }
      if (current.status === 'preparing-workspace' || current.status === 'running') {
        terminal(transitionAgentRun(prepared.id, 'failed', {
          eventType: 'failed',
          errorClass: 'execution',
          errorMessage: message,
        }))
      }
    } finally {
      if (active?.runId === prepared.id) active = null
    }
  }

  async function drainOne(): Promise<void> {
    if (active || stopping) return
    let candidate: AgentRun | null = null
    let recovering = false
    while (pendingRecoveryIds.length && !candidate) {
      const id = pendingRecoveryIds.shift()!
      const run = getAgentRun(id)
      if (run?.status === 'interrupted') {
        candidate = run
        recovering = true
      }
    }
    candidate ??= listAgentRuns({ statuses: ['queued'], limit: 1 })[0] ?? null
    if (candidate) await runOne(candidate, recovering)
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
    pendingRecoveryIds = listAgentRuns({ statuses: ['interrupted'], limit: 500 }).map(run => run.id)
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
      terminal(cancelled)
      return cancelled
    },

    activeRunId: () => active?.runId ?? null,
    isRunning: () => timer !== null,
  }
}
