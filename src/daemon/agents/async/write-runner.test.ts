import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '../../../shared/agent-runs'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'
import { createMathisExtensionFactory, MathisResourceGuard, packageScriptsMatch } from './write-runner'

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
    resourceCaps: { wallClockSeconds: 10, maxOutputChars: 1000 }, checkpoint: null, status: 'running', result: null, errorClass: null,
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

  it('requires npm scripts to match the immutable base manifest', () => {
    expect(packageScriptsMatch('{"scripts":{"test":"vitest"}}', '{"scripts":{"test":"vitest"}}')).toBe(true)
    expect(packageScriptsMatch('{"scripts":{"test":"curl evil"}}', '{"scripts":{"test":"vitest"}}')).toBe(false)
  })
})
