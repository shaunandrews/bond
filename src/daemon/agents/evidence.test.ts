import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../settings', () => ({
  getApprovedRunnerHashes: vi.fn(() => approvedHashes),
  approveRunnerHash: vi.fn((hash: string) => void approvedHashes.push(hash)),
}))

vi.mock('../approvals', () => ({
  registerApproval: vi.fn(async () => approvalDecision),
}))

let approvedHashes: string[] = []
let approvalDecision = { approved: false }

import { approveRunnerHash } from '../settings'
import { registerApproval } from '../approvals'
import {
  collectEvidence,
  formatShellEvidence,
  isRunnerApproved,
  runnerHash,
  type ShellExecFn,
} from './evidence'
import type { AgentEvidenceRunner } from './definition'

const shellRunner = (overrides: Partial<AgentEvidenceRunner> = {}): AgentEvidenceRunner => ({
  name: 'tests',
  command: 'npm run test:run',
  kind: 'shell',
  verbs: [],
  ...overrides,
})

const baseContext = {
  paths: ['/p/src'],
  docs: { root: '/p', docs: {} },
  timeoutMs: 30_000,
  turnId: 'turn-1',
  onChunk: vi.fn(),
}

beforeEach(() => {
  approvedHashes = []
  approvalDecision = { approved: false }
  vi.clearAllMocks()
})

describe('runnerHash', () => {
  it('is stable, whitespace-insensitive at the edges, and command-specific', () => {
    expect(runnerHash('npm test')).toBe(runnerHash('  npm test  '))
    expect(runnerHash('npm test')).not.toBe(runnerHash('npm test -- --ui'))
    expect(runnerHash('npm test')).toHaveLength(16)
  })
})

describe('collectEvidence — verb scoping', () => {
  it('runs only runners scoped to the current verb', async () => {
    approvedHashes = [runnerHash('a'), runnerHash('b')]
    const exec: ShellExecFn = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }))
    const blocks = await collectEvidence({
      ...baseContext,
      verb: 'review',
      exec,
      runners: [
        shellRunner({ name: 'scoped-in', command: 'a', verbs: ['review'] }),
        shellRunner({ name: 'scoped-out', command: 'b', verbs: ['plan'] }),
      ],
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('scoped-in')
  })

  it('treats an unscoped runner as applying to every verb', async () => {
    approvedHashes = [runnerHash('npm run test:run')]
    const exec: ShellExecFn = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }))
    const blocks = await collectEvidence({ ...baseContext, verb: 'anything', exec, runners: [shellRunner()] })
    expect(blocks).toHaveLength(1)
  })
})

describe('collectEvidence — shell approval gate', () => {
  it('does not run an unapproved command when the user denies it', async () => {
    approvalDecision = { approved: false }
    const exec: ShellExecFn = vi.fn()
    const blocks = await collectEvidence({ ...baseContext, verb: 'review', exec, runners: [shellRunner()] })

    expect(exec).not.toHaveBeenCalled()
    expect(registerApproval).toHaveBeenCalled()
    expect(blocks[0]).toContain('status="skipped"')
    expect(blocks[0]).toContain('Not approved')
  })

  it('runs and remembers a command the user approves', async () => {
    approvalDecision = { approved: true }
    const exec: ShellExecFn = vi.fn(async () => ({ code: 0, stdout: 'all good', stderr: '', timedOut: false }))
    const blocks = await collectEvidence({ ...baseContext, verb: 'review', exec, runners: [shellRunner()] })

    expect(exec).toHaveBeenCalledWith('npm run test:run', expect.objectContaining({ cwd: '/p' }))
    expect(approveRunnerHash).toHaveBeenCalledWith(runnerHash('npm run test:run'))
    expect(blocks[0]).toContain('status="pass"')
    expect(blocks[0]).toContain('all good')
  })

  it('skips the prompt entirely for an already-approved command', async () => {
    approvedHashes = [runnerHash('npm run test:run')]
    const exec: ShellExecFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }))
    await collectEvidence({ ...baseContext, verb: 'review', exec, runners: [shellRunner()] })
    expect(registerApproval).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalled()
  })

  it('cannot run an unapproved command when no turn owns the consult', async () => {
    const exec: ShellExecFn = vi.fn()
    const blocks = await collectEvidence({
      ...baseContext,
      turnId: undefined,
      onChunk: undefined,
      verb: 'review',
      exec,
      runners: [shellRunner()],
    })
    expect(exec).not.toHaveBeenCalled()
    expect(blocks[0]).toContain('status="skipped"')
  })
})

describe('collectEvidence — failures are evidence, not consult failures', () => {
  it('reports a failing command as fail evidence with its output', async () => {
    approvedHashes = [runnerHash('npm run test:run')]
    const exec: ShellExecFn = vi.fn(async () => ({ code: 1, stdout: '', stderr: '2 tests failed', timedOut: false }))
    const blocks = await collectEvidence({ ...baseContext, verb: 'review', exec, runners: [shellRunner()] })
    expect(blocks[0]).toContain('status="fail"')
    expect(blocks[0]).toContain('2 tests failed')
  })

  it('reports a spawn error as skipped rather than throwing', async () => {
    approvedHashes = [runnerHash('npm run test:run')]
    const exec: ShellExecFn = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const blocks = await collectEvidence({ ...baseContext, verb: 'review', exec, runners: [shellRunner()] })
    expect(blocks[0]).toContain('could not run')
  })

  it('reports an unknown built-in runner instead of crashing', async () => {
    const blocks = await collectEvidence({
      ...baseContext,
      verb: 'critique',
      runners: [{ name: 'x', command: 'builtin:nope', kind: 'native', verbs: [] }],
    })
    expect(blocks[0]).toContain('Unknown built-in runner')
  })

  it('runs native runners through the injected registry', async () => {
    const blocks = await collectEvidence({
      ...baseContext,
      verb: 'critique',
      runners: [{ name: 'detector', command: 'builtin:fake', kind: 'native', verbs: [] }],
      nativeRunners: { fake: async () => '<evidence source="fake">native output</evidence>' },
    })
    expect(blocks[0]).toContain('native output')
  })
})

describe('formatShellEvidence', () => {
  it('labels timeouts distinctly from failures', () => {
    const block = formatShellEvidence(shellRunner(), { code: null, stdout: '', stderr: '', timedOut: true })
    expect(block).toContain('status="timeout"')
  })
})

describe('isRunnerApproved', () => {
  it('matches on the hash of the exact command string', () => {
    const approved = [runnerHash('npm test')]
    expect(isRunnerApproved('npm test', approved)).toBe(true)
    expect(isRunnerApproved('npm test -- --coverage', approved)).toBe(false)
  })
})
