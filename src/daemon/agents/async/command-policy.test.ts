import { describe, expect, it } from 'vitest'
import { applyRepositoryCommandProfile, evaluateMathisCommand, exactCommandGrant } from './command-policy'

describe('Mathis command policy', () => {
  it('intersects normal allowances with a repository profile while preserving hard denies and exact run grants', () => {
    expect(applyRepositoryCommandProfile(['npm', 'run', 'build'], evaluateMathisCommand(['npm', 'run', 'build']), ['git status'])).toMatchObject({ kind: 'question' })
    expect(applyRepositoryCommandProfile(['git', 'status'], evaluateMathisCommand(['git', 'status']), ['git status'])).toEqual({ kind: 'allow', rule: 'git status' })
    expect(applyRepositoryCommandProfile(['git', 'push'], evaluateMathisCommand(['git', 'push']), ['*'])).toMatchObject({ kind: 'deny' })
    const argv = ['custom-tool', '--check']
    expect(applyRepositoryCommandProfile(argv, evaluateMathisCommand(argv, new Set([exactCommandGrant(argv)])), [])).toEqual({ kind: 'allow', rule: 'run-scoped exact grant' })
  })
  it('allows broad local Bond development commands', () => {
    expect(evaluateMathisCommand(['npm', 'run', 'typecheck']).kind).toBe('allow')
    expect(evaluateMathisCommand(['npm', 'run', 'build:daemon']).kind).toBe('allow')
    expect(evaluateMathisCommand(['git', 'diff', '--stat']).kind).toBe('allow')
    expect(evaluateMathisCommand(['npx', '--no-install', 'vitest', 'run']).kind).toBe('allow')
  })

  it('hard-denies daemon, app, process, remote, shell, and escape commands', () => {
    for (const argv of [
      ['npm', 'run', 'dev'], ['open', '.'], ['kill', '-9', '1'], ['bash', '-lc', 'pwd'],
      ['git', 'push'], ['git', 'worktree', 'add', 'x'], ['git', '-C', '..', 'status'],
      ['npm', 'test', '--', '../outside'], ['node', '-e', 'require("fs").writeFileSync("/tmp/x", "x")'],
      ['/usr/bin/git', 'status'], ['npm', 'run', 'test', '--', '--output=/tmp/leak'],
    ]) expect(evaluateMathisCommand(argv).kind, argv.join(' ')).toBe('deny')
  })

  it('does not let an exact grant override a hard denial', () => {
    const argv = ['git', 'push']
    expect(evaluateMathisCommand(argv, new Set([exactCommandGrant(argv)])).kind).toBe('deny')
  })

  it('parks unknown commands with an exact proposed run-scoped addition', () => {
    const argv = ['node', 'scripts/check-special.mjs', '--quick']
    const decision = evaluateMathisCommand(argv)
    expect(decision).toEqual({
      kind: 'question',
      reason: 'node is not in the managed command allowlist.',
      proposedAllowlistAddition: `Allow this exact argv for this run only: ${JSON.stringify(argv)}`,
    })
    expect(evaluateMathisCommand(argv, new Set([exactCommandGrant(argv)]))).toEqual({ kind: 'allow', rule: 'run-scoped exact grant' })
  })
})
