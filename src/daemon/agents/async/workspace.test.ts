import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentRun } from '../../../shared/agent-runs'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents'
import { assertContainedPath, createWorkspaceManager, plannedWorktree } from './workspace'

function fixture() {
  const root = join(process.cwd(), '.test-tmp', `bond-managed-worktree-${randomUUID()}`)
  const rel = relative(process.cwd(), root)
  if (rel === '.test-tmp' || !rel.startsWith(`.test-tmp${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to initialize a test repository at an unexpected path: ${root}`)
  }
  const repo = join(root, 'repo')
  const git = (args: string[], cwd = repo): string => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Pre-commit runs the suite with outer-repository GIT_* variables. Never
    // let the fixture's local commits inherit that repository/index.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim()
  mkdirSync(repo, { recursive: true })
  git(['init', '-b', 'main'])
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture"}\n')
  git(['add', 'package.json'])
  git(['-c', 'user.name=Bond Tests', '-c', 'user.email=bond@example.test', 'commit', '-m', 'base'])
  return { root, repo, git }
}

function seedRun(root: string, repo: string, baseSha: string, id = 'run-worktree'): AgentRun {
  const now = new Date().toISOString()
  return {
    id,
    idempotencyKey: id,
    agent: 'mathis',
    agentLabel: 'Mathis',
    verb: 'build',
    brief: 'make a local change',
    paths: [],
    workspace: plannedWorktree(id, repo, 'main', join(root, 'data', 'agent-worktrees')),
    workspaceState: { status: 'pending', createdAt: null, retainedAt: null, discardedAt: null },
    baseSha,
    allowedPaths: [],
    settings: { ...DEFAULT_AGENT_SETTINGS, workspace: 'write' },
    agentDefinitionVersion: 'v1',
    commandPolicyVersion: 'local-only-v1',
    acceptanceChecks: [],
    resourceCaps: { wallClockSeconds: 900, maxOutputChars: 100_000 },
    checkpoint: null,
    status: 'queued',
    result: null,
    errorClass: null,
    errorMessage: null,
    recoveryCount: 0,
    attemptCount: 0,
    retryCount: 0,
    nextRetryAt: null,
    completionMessageId: null,
    completionInsertedAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
  }
}

describe('managed agent worktrees', () => {
  it('creates the run branch from the configured base and retains until explicit discard', async () => {
    const { root, repo, git } = fixture()
    try {
      const manager = createWorkspaceManager({
        managedRoot: join(root, 'data', 'agent-worktrees'),
        exec: async (file, args, options) => ({
          stdout: execFileSync(file, args, {
            cwd: options.cwd,
            env: options.env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
          stderr: '',
        }),
      })
      let run = seedRun(root, repo, git(['rev-parse', 'main']))
      expect(await manager.resolveBase(repo, 'main')).toBe(run.baseSha)

      const workspace = await manager.ensure(run)
      expect(existsSync(workspace.worktreePath)).toBe(true)
      expect(git(['branch', '--show-current'], workspace.worktreePath)).toBe(workspace.branch)
      expect(git(['rev-parse', 'HEAD'], workspace.worktreePath)).toBe(run.baseSha)

      writeFileSync(join(workspace.worktreePath, 'changed.txt'), 'retained\n')
      const readyAt = new Date().toISOString()
      run = {
        ...run,
        status: 'cancelled',
        workspaceState: { status: 'retained', createdAt: readyAt, retainedAt: readyAt, discardedAt: null },
      }

      expect((await manager.inspect(run)).porcelain).toContain('changed.txt')
      expect(existsSync(workspace.worktreePath)).toBe(true)

      await manager.discard(run)
      expect(existsSync(workspace.worktreePath)).toBe(false)
      expect(() => git(['rev-parse', '--verify', workspace.branch])).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects lexical and symlink worktree escapes and protects .git', () => {
    const root = join(process.cwd(), '.test-tmp', `bond-worktree-containment-${randomUUID()}`)
    try {
      const worktree = join(root, 'containment')
      const outside = join(root, 'outside')
      mkdirSync(worktree, { recursive: true })
      mkdirSync(outside, { recursive: true })
      symlinkSync(outside, join(worktree, 'link'))

      expect(assertContainedPath(worktree, 'inside/new.txt')).toBe(join(realpathSync(worktree), 'inside/new.txt'))
      expect(() => assertContainedPath(worktree, '../outside/file')).toThrow('escapes')
      expect(() => assertContainedPath(worktree, 'link/file')).toThrow('outside')
      expect(() => assertContainedPath(worktree, '.git/config')).toThrow('protected')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
