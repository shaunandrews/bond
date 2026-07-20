import { describe, expect, it, vi } from 'vitest'
import {
  IMPECCABLE_VERSION,
  formatDetectorEvidence,
  parseDetectorOutput,
  runImpeccableDetect,
  type ExecFn,
} from './detector'

function execReturning(result: Partial<Awaited<ReturnType<ExecFn>>>): ExecFn {
  return vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false, ...result })
}

describe('parseDetectorOutput', () => {
  it('parses a bare findings array', () => {
    expect(parseDetectorOutput('[{"antipattern":"low-contrast"}]')).toEqual([{ antipattern: 'low-contrast' }])
  })

  it('parses an object wrapping a findings array', () => {
    expect(parseDetectorOutput('{"findings":[{"antipattern":"side-tab"}]}')).toEqual([{ antipattern: 'side-tab' }])
  })

  it('tolerates a non-JSON prefix (npx install noise)', () => {
    expect(parseDetectorOutput('added 12 packages\n[{"antipattern":"gradient-text"}]')).toEqual([{ antipattern: 'gradient-text' }])
  })

  it('returns undefined for garbage', () => {
    expect(parseDetectorOutput('command not found')).toBeUndefined()
    expect(parseDetectorOutput('{broken json')).toBeUndefined()
  })
})

describe('runImpeccableDetect', () => {
  it('invokes the pinned version with --json and the target paths', async () => {
    const exec = execReturning({ stdout: '[]' })
    await runImpeccableDetect(['/p/src'], { exec })
    expect(exec).toHaveBeenCalledWith(
      'npx',
      ['-y', `impeccable@${IMPECCABLE_VERSION}`, 'detect', '--json', '/p/src'],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    )
  })

  it('treats a nonzero exit with parseable findings as success (linter convention)', async () => {
    const outcome = await runImpeccableDetect(['/p'], { exec: execReturning({ code: 1, stdout: '[{"antipattern":"nested-cards"}]' }) })
    expect(outcome).toEqual({ status: 'ok', findings: [{ antipattern: 'nested-cards' }], truncated: false })
  })

  it('returns a clean ok for a zero exit without JSON', async () => {
    const outcome = await runImpeccableDetect(['/p'], { exec: execReturning({ code: 0, stdout: 'all clean' }) })
    expect(outcome).toEqual({ status: 'ok', findings: [], truncated: false })
  })

  it('maps a spawn failure to unavailable', async () => {
    const exec: ExecFn = vi.fn().mockRejectedValue(new Error('spawn npx ENOENT'))
    const outcome = await runImpeccableDetect(['/p'], { exec })
    expect(outcome.status).toBe('unavailable')
  })

  it('maps a timeout to timeout', async () => {
    const outcome = await runImpeccableDetect(['/p'], { exec: execReturning({ timedOut: true }), timeoutMs: 5_000 })
    expect(outcome).toEqual({ status: 'timeout', message: 'Detector timed out after 5s.' })
  })

  it('maps a nonzero exit without JSON to error with the stderr excerpt', async () => {
    const outcome = await runImpeccableDetect(['/p'], { exec: execReturning({ code: 2, stderr: 'boom' }) })
    expect(outcome).toEqual({ status: 'error', message: 'Detector exited 2: boom' })
  })

  it('errors on an empty path list without spawning', async () => {
    const exec = execReturning({})
    const outcome = await runImpeccableDetect([], { exec })
    expect(outcome.status).toBe('error')
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('formatDetectorEvidence', () => {
  it('renders findings as an evidence block', () => {
    const block = formatDetectorEvidence({ status: 'ok', findings: [{ antipattern: 'side-tab' }], truncated: false })
    expect(block).toContain('source="impeccable-detector"')
    expect(block).toContain('findings="1"')
    expect(block).toContain('side-tab')
  })

  it('marks a clean scan as a floor, not a verdict', () => {
    expect(formatDetectorEvidence({ status: 'ok', findings: [], truncated: false })).toContain('floor, not a verdict')
  })

  it('renders degraded runs honestly', () => {
    const block = formatDetectorEvidence({ status: 'unavailable', message: 'npx missing' })
    expect(block).toContain('status="unavailable"')
    expect(block).toContain('npx missing')
    expect(block).toContain('rely on your own pass')
  })
})
