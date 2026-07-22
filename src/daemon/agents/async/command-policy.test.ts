import { describe, expect, it } from 'vitest'
import { evaluateMathisCommand, exactCommandGrant } from './command-policy'

describe('Mathis command policy', () => {
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
