import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '../../../shared/agent-runs'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'
import { createMathisExtensionFactory, latestMathisResourceSnapshot, MathisResourceGuard, packageScriptsMatch, pendingMathisAcceptanceChecks } from './write-runner'

const roots: string[] = []
function runFixture(): AgentRun {
  const root = join(process.cwd(), '.test-tmp', `mathis-tools-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  const now = new Date().toISOString()
  return {
    id: randomUUID(), idempotencyKey: randomUUID(), agent: 'mathis', agentLabel: 'Mathis', verb: 'build', brief: 'x', paths: [root],
    workspace: { repoRoot: root, isolation: 'worktree', branch: 'bond-agent/test', baseRef: 'main', worktreePath: root, readOnly: false },
    workspaceState: { status: 'ready', createdAt: now, retainedAt: null, discardedAt: null }, baseSha: 'a'.repeat(40), allowedPaths: [root],
    settings: { ...DEFAULT_AGENT_SETTINGS, workspace: 'write' }, agentDefinitionVersion: 'v1', commandPolicyVersion: 'v1', acceptanceChecks: [],
    resourceCaps: { wallClockSeconds: 10, maxOutputChars: 1000 }, checkpoint: null, summary: null, status: 'running', result: null, errorClass: null,
    errorMessage: null, recoveryCount: 0, attemptCount: 1, retryCount: 0, nextRetryAt: null, completionMessageId: null, completionInsertedAt: null, createdAt: now, updatedAt: now,
    startedAt: now, completedAt: null, cancelledAt: null,
  }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Mathis worktree tools', () => {
  it('blocks lexical and symlink paths outside the worktree for every file tool', async () => {
    const run = runFixture()
    const outside = join(run.workspace.repoRoot, '..', `outside-${randomUUID()}`)
    mkdirSync(outside)
    roots.push(outside)
    symlinkSync(outside, join(run.workspace.repoRoot, 'escape'))
    const hooks = new Map<string, (event: any) => Promise<any>>()
    createMathisExtensionFactory({ run, signal: new AbortController().signal, onQuestion: vi.fn() })({
      on: (name: string, value: any) => { hooks.set(name, value) },
      registerTool: vi.fn(),
    } as any)
    for (const toolName of ['read', 'grep', 'find', 'ls', 'edit', 'write']) {
      expect((await hooks.get('tool_call')!({ toolName, input: { path: '../outside' } })).block).toBe(true)
      expect((await hooks.get('tool_call')!({ toolName, input: { path: 'escape/file' } })).block).toBe(true)
    }
  })

  it('provides conservative step, command, and loop guard hooks', () => {
    const guard = new MathisResourceGuard(2, 1, 1)
    guard.recordTool('read', { path: 'a' })
    guard.recordResult('read', { path: 'a' }, 'same')
    expect(() => guard.recordResult('read', { path: 'a' }, 'same')).toThrow('repeated')
    const other = new MathisResourceGuard(1, 1, 4)
    other.recordTool('run_command', { argv: ['git', 'status'] })
    expect(() => other.recordTool('read', { path: 'b' })).toThrow('step')
    const usage = new MathisResourceGuard(10, 10, 4, 100, 1)
    expect(() => usage.recordUsage(101, 0)).toThrow('token')
  })

  it('carries resource consumption and loop fingerprints across fresh sessions', () => {
    const first = new MathisResourceGuard(10, 10, 1, 100, 1)
    first.recordUsage(60, 0.4)
    first.recordResult('read', { path: 'a' }, 'same')
    const resumed = new MathisResourceGuard(10, 10, 1, 100, 1, first.snapshot())
    expect(() => resumed.recordUsage(41, 0)).toThrow('token')
    expect(() => resumed.recordResult('read', { path: 'a' }, 'same')).toThrow('repeated')
  })

  it('requires npm scripts to match the immutable base manifest', () => {
    expect(packageScriptsMatch('{"scripts":{"test":"vitest"}}', '{"scripts":{"test":"vitest"}}')).toBe(true)
    expect(packageScriptsMatch('{"scripts":{"test":"curl evil"}}', '{"scripts":{"test":"vitest"}}')).toBe(false)
  })

  it('reports a durable command-start boundary as soon as the child is spawned', async () => {
    const run = runFixture()
    let commandTool: any
    const onCommandStarted = vi.fn()
    createMathisExtensionFactory({ run, signal: new AbortController().signal, onQuestion: vi.fn(), onCommandStarted })({
      on: vi.fn(),
      registerTool: (_definition: unknown) => { commandTool = _definition },
    } as any)

    await commandTool.execute('tool-1', { argv: ['git', 'rev-parse', '--is-inside-work-tree'], reason: 'inspect repository context' })

    expect(onCommandStarted).toHaveBeenCalledOnce()
    expect(onCommandStarted).toHaveBeenCalledWith(expect.objectContaining({ argv: ['git', 'rev-parse', '--is-inside-work-tree'], rule: 'git rev-parse' }))
    expect(onCommandStarted.mock.calls[0][0].pid).toBeTypeOf('number')
  })

  it('reconstructs pending checks from durable successful command events', () => {
    const run = runFixture()
    run.acceptanceChecks = [JSON.stringify(['npm', 'run', 'typecheck']), JSON.stringify(['npm', 'run', 'test:run'])]
    const events = [{
      id: 1, runId: run.id, sequence: 1, type: 'command_completed', fromState: 'running' as const, toState: 'running' as const,
      data: { argv: ['npm', 'run', 'typecheck'], exitCode: 0 }, createdAt: new Date().toISOString(),
    }]
    expect(pendingMathisAcceptanceChecks(run, events)).toEqual([JSON.stringify(['npm', 'run', 'test:run'])])
  })

  it('selects the latest durable resource checkpoint for recovery', () => {
    const run = runFixture()
    const event = (sequence: number, tokens: number) => ({
      id: sequence, runId: run.id, sequence, type: 'resource_checkpoint', fromState: 'running' as const, toState: 'running' as const,
      data: { usage: { steps: sequence, commands: 0, tokens, costUsd: 0, fingerprints: {} } }, createdAt: new Date().toISOString(),
    })
    expect(latestMathisResourceSnapshot([event(1, 10), event(2, 20)])).toMatchObject({ steps: 2, tokens: 20 })
  })
})
