import { describe, it, expect } from 'vitest'
import {
  DESK_HELP,
  dayRange,
  formatBlocks,
  formatMatchers,
  formatStats,
  formatStatus,
  formatThreads,
  parseDeskArgs,
} from './desk-helpers'
import { formatApproxDuration } from '../shared/desk'
import type { DeskBlockDetail, DeskMatcher, DeskStats, DeskStatus, DeskThread } from '../shared/desk'

describe('parseDeskArgs', () => {
  it('defaults to status', () => {
    expect(parseDeskArgs([])).toEqual({ kind: 'status' })
    expect(parseDeskArgs(['status'])).toEqual({ kind: 'status' })
  })

  it('parses on and off', () => {
    expect(parseDeskArgs(['on'])).toEqual({ kind: 'on' })
    expect(parseDeskArgs(['off'])).toEqual({ kind: 'off' })
  })

  it('parses blocks with a day and a limit', () => {
    expect(parseDeskArgs(['blocks'])).toEqual({ kind: 'blocks', day: undefined, limit: 50 })
    expect(parseDeskArgs(['blocks', '--day', '2026-07-20'])).toEqual({
      kind: 'blocks', day: '2026-07-20', limit: 50,
    })
    expect(parseDeskArgs(['blocks', '--limit', '5'])).toMatchObject({ limit: 5 })
  })

  it('falls back to a sane limit for garbage', () => {
    expect(parseDeskArgs(['blocks', '--limit', 'lots'])).toMatchObject({ limit: 50 })
    expect(parseDeskArgs(['blocks', '--limit', '-3'])).toMatchObject({ limit: 50 })
  })

  it('ignores a flag whose value is another flag', () => {
    expect(parseDeskArgs(['blocks', '--day', '--limit', '5'])).toMatchObject({ day: undefined, limit: 5 })
  })

  it('parses threads and matchers with --all', () => {
    expect(parseDeskArgs(['threads'])).toEqual({ kind: 'threads', includeArchived: false })
    expect(parseDeskArgs(['threads', '--all'])).toEqual({ kind: 'threads', includeArchived: true })
    expect(parseDeskArgs(['matchers'])).toEqual({ kind: 'matchers', confirmedOnly: true })
    expect(parseDeskArgs(['matchers', '--all'])).toEqual({ kind: 'matchers', confirmedOnly: false })
  })

  it('answers the pending question with no id', () => {
    expect(parseDeskArgs(['answer', 'yes'])).toEqual({ kind: 'answer', questionId: null, verdict: 'accept' })
    expect(parseDeskArgs(['answer', 'no'])).toEqual({ kind: 'answer', questionId: null, verdict: 'reject' })
    expect(parseDeskArgs(['answer', 'y'])).toMatchObject({ verdict: 'accept' })
    expect(parseDeskArgs(['answer', 'n'])).toMatchObject({ verdict: 'reject' })
  })

  it('answers a specific question id', () => {
    expect(parseDeskArgs(['answer', 'q-123', 'yes'])).toEqual({
      kind: 'answer', questionId: 'q-123', verdict: 'accept',
    })
  })

  it('treats a missing verdict as a usage error, never a silent rejection', () => {
    // A reject becomes a durable negative rule in Phase 3; a forgotten verdict
    // must not mint one. `verdict: null` makes the CLI print usage instead.
    expect(parseDeskArgs(['answer', 'q-123'])).toEqual({ kind: 'answer', questionId: 'q-123', verdict: null })
    expect(parseDeskArgs(['answer'])).toEqual({ kind: 'answer', questionId: null, verdict: null })
  })

  it('parses stats hours', () => {
    expect(parseDeskArgs(['stats'])).toEqual({ kind: 'stats', windowHours: 24 })
    expect(parseDeskArgs(['stats', '--hours', '8'])).toEqual({ kind: 'stats', windowHours: 8 })
    expect(parseDeskArgs(['stats', '--hours', 'nope'])).toEqual({ kind: 'stats', windowHours: 24 })
  })

  it('reports an unknown command instead of silently doing something', () => {
    expect(parseDeskArgs(['frobnicate'])).toEqual({ kind: 'unknown', command: 'frobnicate' })
  })

  it('recognises every help spelling', () => {
    for (const arg of ['help', '-h', '--help']) {
      expect(parseDeskArgs([arg])).toEqual({ kind: 'help' })
    }
  })
})

describe('dayRange', () => {
  it('brackets a full local day', () => {
    const { from, to } = dayRange('2026-07-20')
    expect(new Date(from).getDate()).toBe(20)
    expect(new Date(from).getHours()).toBe(0)
    expect(new Date(to).getHours()).toBe(23)
    expect(new Date(from).getTime()).toBeLessThan(new Date(to).getTime())
  })
})

describe('formatApproxDuration', () => {
  it('is always approximate — never a precise minute count', () => {
    expect(formatApproxDuration(83 * 60)).toBe('~1h 25m')
    expect(formatApproxDuration(23 * 60)).toBe('~25m')
    expect(formatApproxDuration(30)).toBe('~1m')
  })

  it('drops a zero minute remainder', () => {
    expect(formatApproxDuration(3600)).toBe('~1h')
    expect(formatApproxDuration(7200)).toBe('~2h')
  })

  it('rolls a rounded-up 60 into the next hour', () => {
    expect(formatApproxDuration(3598 + 3540)).toBe('~2h')
  })

  it('never emits a total-hours style figure', () => {
    for (const seconds of [0, 61, 599, 3599, 12345]) {
      expect(formatApproxDuration(seconds)).toMatch(/^~/)
    }
  })
})

function status(over: Partial<DeskStatus> = {}): DeskStatus {
  return {
    running: true,
    senseState: 'recording',
    senseEnabled: true,
    currentBlock: null,
    presenceSeconds: 0,
    pendingQuestion: null,
    lastAssertionAt: null,
    backfilling: false,
    unresolvedSegments: 0,
    ...over,
  }
}

function block(over: Partial<DeskBlockDetail> = {}): DeskBlockDetail {
  return {
    id: 'b1',
    threadId: 't1',
    startedAt: '2026-07-20T09:00:00.000Z',
    endedAt: '2026-07-20T10:20:00.000Z',
    presenceSeconds: 4800,
    state: 'committed',
    summary: null,
    reentryNote: null,
    noteStatus: 'none',
    confidence: 0.9,
    source: 'inferred',
    createdAt: '2026-07-20T09:00:00.000Z',
    updatedAt: '2026-07-20T10:20:00.000Z',
    thread: {
      id: 't1', name: 'Studio sync dialog', normalizedName: 'studio sync dialog', colorSeed: 't1',
      status: 'established', source: 'user', userNote: null, userNoteUpdatedAt: null,
      lastSeenAt: null, archivedAt: null, createdAt: 'x', updatedAt: 'x',
    },
    ...over,
  }
}

describe('formatStatus', () => {
  it('shows the current thread with an approximate duration', () => {
    const out = formatStatus(status({ currentBlock: block(), presenceSeconds: 4800 }))
    expect(out).toContain('Studio sync dialog')
    expect(out).toContain('~1h 20m')
  })

  it('never prints a precise duration', () => {
    const out = formatStatus(status({ currentBlock: block(), presenceSeconds: 4983 }))
    expect(out).not.toMatch(/\d+m\b(?<!~[\dhm ]*m)/)
    expect(out).toContain('~1h 25m')
  })

  it('shows the re-entry note, which is the point of the feature', () => {
    const out = formatStatus(status({
      currentBlock: block({ reentryNote: 'Conflict-state copy unwritten' }),
      presenceSeconds: 600,
    }))
    expect(out).toContain('Conflict-state copy unwritten')
  })

  it('surfaces a pending Ask with the command to answer it', () => {
    const out = formatStatus(status({
      pendingQuestion: {
        id: 'q1', kind: 'thread_switch', blockId: null, proposedThreadId: 't1', itemId: null,
        resourceSignature: 'sig', state: 'pending', presentedAt: null,
        expiresAt: '2099-01-01T00:00:00.000Z', resolvedAt: null, createdAt: 'x',
        proposedThreadName: 'Studio sync dialog', itemTitle: null,
      },
    }))
    expect(out).toContain('Studio sync dialog?')
    expect(out).toContain('bond desk answer yes|no')
  })

  it('says so plainly when Sense is off, without stuttering', () => {
    const out = formatStatus(status({ senseEnabled: false, senseState: 'disabled' }))
    expect(out).toContain('Sense       disabled')
    expect(out).not.toContain('disabled (disabled)')
  })

  it('flags a Sense that is running but switched off in settings', () => {
    expect(formatStatus(status({ senseEnabled: false, senseState: 'armed' }))).toContain('armed (turned off)')
  })

  it('reports back-fill so an empty panel is explainable', () => {
    expect(formatStatus(status({ backfilling: true, running: true }))).toContain('catching up')
  })

  it('does not claim to be catching up while Desk is off', () => {
    expect(formatStatus(status({ backfilling: true, running: false }))).not.toContain('catching up')
  })

  it('has no score, streak, or comparison to yesterday', () => {
    const out = formatStatus(status({ currentBlock: block(), presenceSeconds: 4800 }))
    expect(out.toLowerCase()).not.toMatch(/score|streak|goal|target|yesterday|productiv/)
  })
})

describe('formatBlocks', () => {
  it('says so when there is nothing', () => {
    expect(formatBlocks([])).toBe('No blocks.')
  })

  it('leads with the span and thread, and puts the note on its own line', () => {
    const out = formatBlocks([block({ reentryNote: 'Left at SyncDialog.tsx' })])
    expect(out).toContain('Studio sync dialog')
    expect(out).toContain('~1h 20m')
    expect(out.split('\n')[1]).toContain('Left at SyncDialog.tsx')
  })

  it('marks an open block as running to now', () => {
    expect(formatBlocks([block({ endedAt: null })])).toContain('–now')
  })

  it('handles a block with no thread', () => {
    expect(formatBlocks([block({ thread: null, threadId: null })])).toContain('(unknown)')
  })
})

describe('formatThreads', () => {
  it('says so when there is nothing', () => {
    expect(formatThreads([])).toBe('No threads yet.')
  })

  it('shows status, source, and a graduated note', () => {
    const thread: DeskThread = {
      id: 't1', name: 'ISP problem', normalizedName: 'isp problem', colorSeed: 't1',
      status: 'established', source: 'user', userNote: 'Router swap pending',
      userNoteUpdatedAt: '2026-07-19T00:00:00.000Z', lastSeenAt: '2026-07-20T09:00:00.000Z',
      archivedAt: null, createdAt: 'x', updatedAt: 'x',
    }
    const out = formatThreads([thread])
    expect(out).toContain('ISP problem')
    expect(out).toContain('established/user')
    expect(out).toContain('Router swap pending')
  })
})

describe('formatMatchers', () => {
  const matcher: DeskMatcher = {
    id: 'm1', threadId: 't1', field: 'title', operator: 'prefix',
    pattern: 'Studio — Sync', normalizedPattern: 'studio — sync', confirmed: true,
    source: 'user', confidence: 1, specificity: 213,
    example: { titles: ['Studio — Sync Dialog'] }, enabled: true, hits: 12,
    lastSeenAt: null, exampleUpdatedAt: null, createdAt: 'x', updatedAt: 'x',
  }

  it('says so when there is nothing', () => {
    expect(formatMatchers([])).toBe('No matchers.')
  })

  it('shows the pattern, its authority, and its captured example', () => {
    const out = formatMatchers([matcher])
    expect(out).toContain('confirmed')
    expect(out).toContain('title:prefix "Studio — Sync"')
    expect(out).toContain('12 hits')
    expect(out).toContain('Studio — Sync Dialog')
  })

  it('distinguishes inferred and disabled matchers', () => {
    expect(formatMatchers([{ ...matcher, confirmed: false }])).toContain('inferred')
    expect(formatMatchers([{ ...matcher, enabled: false }])).toContain('disabled')
  })
})

describe('formatStats', () => {
  const stats: DeskStats = {
    windowHours: 24,
    modelCalls: 34, failedCalls: 1, immediateCalls: 6, sweptCalls: 28,
    segmentsInferred: 190, promptChars: 48_000, avgLatencyMs: 820,
    cacheHitRate: 0.82, segmentsResolvedByMatcher: 164, segmentsResolvedByModel: 36,
    unresolvedSegments: 3, medianUnknownLatencySeconds: 47,
    blocks: 21, threads: 9, matchers: 40, confirmedMatchers: 6,
  }

  it('reports every number the go/no-go needs', () => {
    const out = formatStats(stats)
    expect(out).toContain('34')                 // model calls
    expect(out).toContain('6 immediate, 28 swept')
    expect(out).toContain('82%')                // cache hit rate
    expect(out).toContain('47s median')         // unknown-resource latency
    expect(out).toContain('820ms')
    expect(out).toContain('~12000')             // approx tokens
  })

  it('projects calls per day so it can be compared to the batched estimate', () => {
    expect(formatStats(stats)).toContain('~34.0 calls/day')
    expect(formatStats({ ...stats, windowHours: 8, modelCalls: 10 })).toContain('~30.0 calls/day')
  })

  it('survives an empty day without dividing by zero', () => {
    const empty: DeskStats = {
      ...stats, modelCalls: 0, failedCalls: 0, immediateCalls: 0, sweptCalls: 0,
      segmentsInferred: 0, promptChars: 0, avgLatencyMs: 0, cacheHitRate: 0,
      segmentsResolvedByMatcher: 0, segmentsResolvedByModel: 0, unresolvedSegments: 0,
      medianUnknownLatencySeconds: null, blocks: 0, threads: 0, matchers: 0, confirmedMatchers: 0,
    }
    const out = formatStats(empty)
    expect(out).toContain('~0.0 calls/day')
    expect(out).toContain('—')
    expect(out).not.toContain('NaN')
  })
})

describe('DESK_HELP', () => {
  it('documents every command parseDeskArgs accepts', () => {
    for (const command of ['blocks', 'threads', 'matchers', 'answer', 'stats', 'on', 'off']) {
      expect(DESK_HELP).toContain(command)
    }
  })
})
