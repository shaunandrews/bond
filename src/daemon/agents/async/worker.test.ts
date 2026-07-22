import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'
import { closeDb, getDb } from '../../db'
import { setDataDir } from '../../paths'
import { createAgentRunRecord, getAgentRun, listAgentRunEvents, transitionAgentRun } from './store'
import { createAgentRunWorker } from './worker'

let dir: string

function seed(id: string, key = id) {
  return createAgentRunRecord({
    id,
    idempotencyKey: key,
    agent: 'felix',
    agentLabel: 'Felix',
    verb: 'critique',
    brief: `brief ${id}`,
    paths: [],
    workspace: { repoRoot: '/repo', isolation: 'in-place', branch: null, readOnly: true },
    baseSha: null,
    allowedPaths: [],
    settings: DEFAULT_AGENT_SETTINGS,
    agentDefinitionVersion: 'v1',
    commandPolicyVersion: 'phase0-readonly-no-shell-v1',
    acceptanceChecks: [],
    resourceCaps: { wallClockSeconds: 300, maxOutputChars: 100_000 },
  }).run
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bond-agent-worker-'))
  setDataDir(dir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
  setDataDir(null as never)
})

describe('agent run worker', () => {
  it('drains dispatches with concurrency one', async () => {
    seed('run-1')
    seed('run-2')
    let concurrent = 0
    let maxConcurrent = 0
    const execute = vi.fn(async (_run, context) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      context.onStarted({ phase: 'started' })
      await new Promise(resolve => setTimeout(resolve, 5))
      concurrent--
      return 'report'
    })
    const worker = createAgentRunWorker({ execute, intervalMs: 60_000 })

    await Promise.all([worker.tickNow(), worker.tickNow()])

    expect(maxConcurrent).toBe(1)
    expect(getAgentRun('run-1')?.status).toBe('succeeded')
    expect(getAgentRun('run-2')?.status).toBe('succeeded')
  })

  it('recovers a run stranded in running after a daemon restart', async () => {
    seed('recover-me')
    transitionAgentRun('recover-me', 'preparing-workspace', { eventType: 'workspace_preparing' })
    transitionAgentRun('recover-me', 'running', { eventType: 'started', checkpoint: { phase: 'old-session' } })
    const execute = vi.fn(async (_run, context) => {
      context.onStarted({ phase: 'new-session' })
      return 'recovered report'
    })
    const worker = createAgentRunWorker({ execute, intervalMs: 60_000 })

    worker.start()
    await worker.tickNow()
    worker.stop()

    expect(getAgentRun('recover-me')).toMatchObject({ status: 'succeeded', result: 'recovered report', recoveryCount: 1 })
    expect(listAgentRunEvents('recover-me').map(event => event.type)).toEqual(expect.arrayContaining([
      'daemon_interrupted', 'recovery_preparing', 'recovery_started', 'succeeded',
    ]))
  })

  it('cancels an active session and never overwrites cancelled with success or failure', async () => {
    seed('cancel-me')
    let started!: () => void
    const didStart = new Promise<void>(resolve => { started = resolve })
    const observedSignal: { current?: AbortSignal } = {}
    const worker = createAgentRunWorker({
      execute: async (_run, context) => {
        observedSignal.current = context.signal
        context.onStarted({ phase: 'started' })
        started()
        await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return 'unreachable'
      },
    })

    const ticking = worker.tickNow()
    await didStart
    expect(worker.cancel('cancel-me')?.status).toBe('cancelled')
    await ticking

    expect(observedSignal.current?.aborted).toBe(true)
    expect(worker.activeRunId()).toBeNull()
    expect(getAgentRun('cancel-me')?.status).toBe('cancelled')
    expect(listAgentRunEvents('cancel-me').at(-1)?.type).toBe('cancelled')
  })
})
