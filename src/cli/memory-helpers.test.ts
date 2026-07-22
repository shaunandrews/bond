import { describe, expect, it } from 'vitest'
import type { MemoryHealth } from '../shared/memory'
import { formatAge, formatMemoryStatus, isDegraded, parseMemoryArgs } from './memory-helpers'

const NOW = Date.parse('2026-07-21T20:26:00.000Z')

function health(overrides: Partial<MemoryHealth> = {}): MemoryHealth {
  return {
    workingUpdatedAt: '2026-07-21T20:20:00.000Z',
    coreUpdatedAt: '2026-07-21T20:00:00.000Z',
    coreItems: 9,
    maxSeq: 867,
    observedThroughSeq: 867,
    reflectedThroughSeq: 860,
    observerLagSeqs: 0,
    consecutiveObserverFailures: 0,
    consecutiveReflectorFailures: 0,
    lastError: null,
    lastRuns: [],
    ...overrides,
  }
}

describe('bond memory status', () => {
  it('parses args', () => {
    expect(parseMemoryArgs([])).toEqual({ subcommand: 'status', json: false })
    expect(parseMemoryArgs(['status', '--json'])).toEqual({ subcommand: 'status', json: true })
  })

  it('formats ages in units a human reads at a glance', () => {
    expect(formatAge(null)).toBe('never')
    expect(formatAge('2026-07-21T20:25:30.000Z', NOW)).toBe('30s ago')
    expect(formatAge('2026-07-21T20:06:00.000Z', NOW)).toBe('20m ago')
    expect(formatAge('2026-07-21T17:10:21.000Z', NOW)).toBe('3h ago')
    expect(formatAge('not-a-date', NOW)).toBe('unknown')
  })

  it('reads as healthy when it is', () => {
    const report = formatMemoryStatus(health(), NOW)
    expect(report).toContain('observer  up to date')
    expect(report).not.toContain('DEGRADED')
    expect(isDegraded(health())).toBe(false)
  })

  it('THE INCIDENT: shows the freeze, the lag, and the streak', () => {
    const frozen = health({
      workingUpdatedAt: '2026-07-21T17:10:21.000Z',
      observedThroughSeq: 832,
      observerLagSeqs: 35,
      consecutiveObserverFailures: 12,
      lastError: 'Memory observer rejected output: memories[1] has unknown sourceIds: 845',
      lastRuns: [{ kind: 'observer', outcome: 'parse_failed', rangeFrom: 833, rangeTo: 867, persistedCount: 0, skippedCount: 10, reason: 'unknown sourceIds: 845', ranAt: '2026-07-21T20:25:00.000Z' }],
    })

    const report = formatMemoryStatus(frozen, NOW)
    expect(report).toContain('working   last written 3h ago')
    expect(report).toContain('35 seqs behind (832 / 867)')
    expect(report).toContain('12 consecutive failures')
    expect(report).toContain('unknown sourceIds: 845')
    expect(report).toContain('DEGRADED')
    expect(isDegraded(frozen)).toBe(true)
  })

  it('treats a large observer lag as degraded even with no failures logged', () => {
    expect(isDegraded(health({ observerLagSeqs: 100 }))).toBe(true)
    expect(isDegraded(health({ observerLagSeqs: 48 }))).toBe(false)
  })
})
