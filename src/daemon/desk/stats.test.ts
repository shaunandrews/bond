import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import { computeStats } from './stats'
import { attributeSegment, createBlock, createSegment, createThread } from './store'
import { confirmMatcher, writeInferredMatcher } from './matchers'
import { recordMetrics } from './inference'
import type { InferenceResult } from './inference'

let testDir: string
const NOW = new Date('2026-07-20T12:00:00.000Z')

function metric(over: Partial<InferenceResult> = {}): InferenceResult {
  return {
    segments: 5, resolved: 5, failed: 0, threadsProposed: 0,
    promptChars: 1200, latencyMs: 800, ok: true, problems: [], ...over,
  }
}

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-stats-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

const stats = (windowHours = 24) => computeStats({ windowHours, now: NOW })

describe('computeStats', () => {
  it('returns zeros on an empty database without dividing by zero', () => {
    const result = stats()
    expect(result.modelCalls).toBe(0)
    expect(result.cacheHitRate).toBe(0)
    expect(result.avgLatencyMs).toBe(0)
    expect(result.medianUnknownLatencySeconds).toBeNull()
    expect(Number.isNaN(result.cacheHitRate)).toBe(false)
  })

  it('splits immediate from swept calls', () => {
    recordMetrics('immediate', metric(), '2026-07-20T11:00:00.000Z')
    recordMetrics('sweep', metric(), '2026-07-20T11:15:00.000Z')
    recordMetrics('sweep', metric(), '2026-07-20T11:30:00.000Z')

    const result = stats()
    expect(result.modelCalls).toBe(3)
    expect(result.immediateCalls).toBe(1)
    expect(result.sweptCalls).toBe(2)
  })

  it('counts failed calls', () => {
    recordMetrics('sweep', metric({ ok: false }), '2026-07-20T11:00:00.000Z')
    recordMetrics('sweep', metric(), '2026-07-20T11:15:00.000Z')
    expect(stats().failedCalls).toBe(1)
  })

  it('sums prompt chars and averages latency', () => {
    recordMetrics('sweep', metric({ promptChars: 1000, latencyMs: 600 }), '2026-07-20T11:00:00.000Z')
    recordMetrics('sweep', metric({ promptChars: 2000, latencyMs: 1000 }), '2026-07-20T11:15:00.000Z')

    const result = stats()
    expect(result.promptChars).toBe(3000)
    expect(result.avgLatencyMs).toBe(800)
  })

  it('ignores metrics outside the window', () => {
    recordMetrics('sweep', metric(), '2026-07-19T11:00:00.000Z')
    recordMetrics('sweep', metric(), '2026-07-20T11:00:00.000Z')
    expect(stats(24).modelCalls).toBe(1)
    expect(stats(48).modelCalls).toBe(2)
  })

  it('cache hit rate is the share resolved without a model call', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const matcher = confirmMatcher({ field: 'resource', operator: 'exact', pattern: 'sig', threadId: t.id })

    for (let i = 0; i < 8; i++) {
      const s = createSegment({
        blockId: null, startedAt: '2026-07-20T11:00:00.000Z', resourceSignature: `sig-${i}`, evidence: {},
      })
      attributeSegment(s.id, { threadId: t.id, matcherId: matcher.id, confidence: 1 })
    }
    for (let i = 0; i < 2; i++) {
      const s = createSegment({
        blockId: null, startedAt: '2026-07-20T11:00:00.000Z', resourceSignature: `model-${i}`, evidence: {},
      })
      attributeSegment(s.id, { threadId: t.id, matcherId: null, confidence: 0.7 })
    }

    const result = stats()
    expect(result.segmentsResolvedByMatcher).toBe(8)
    expect(result.segmentsResolvedByModel).toBe(2)
    expect(result.cacheHitRate).toBeCloseTo(0.8)
  })

  it('reports median unknown-resource latency in seconds', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const latencies = [10, 40, 300]
    for (const [i, seconds] of latencies.entries()) {
      const started = '2026-07-20T11:00:00.000Z'
      const s = createSegment({ blockId: null, startedAt: started, resourceSignature: `s-${i}`, evidence: {} })
      attributeSegment(s.id, { threadId: t.id, matcherId: null, confidence: 0.7 })
      getDb().prepare('UPDATE desk_segments SET attributed_at = ? WHERE id = ?')
        .run(new Date(Date.parse(started) + seconds * 1000).toISOString(), s.id)
    }
    expect(stats().medianUnknownLatencySeconds).toBe(40)
  })

  it('excludes matcher-resolved segments from the unknown-latency figure', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const matcher = confirmMatcher({ field: 'resource', operator: 'exact', pattern: 'sig', threadId: t.id })
    const s = createSegment({
      blockId: null, startedAt: '2026-07-20T11:00:00.000Z', resourceSignature: 'sig', evidence: {},
    })
    attributeSegment(s.id, { threadId: t.id, matcherId: matcher.id, confidence: 1 })
    expect(stats().medianUnknownLatencySeconds).toBeNull()
  })

  it('counts unresolved segments across every non-resolved state', () => {
    for (const state of ['unresolved', 'queued', 'failed'] as const) {
      const s = createSegment({
        blockId: null, startedAt: '2026-07-20T11:00:00.000Z', resourceSignature: state, evidence: {},
      })
      getDb().prepare('UPDATE desk_segments SET attribution_state = ? WHERE id = ?').run(state, s.id)
    }
    expect(stats().unresolvedSegments).toBe(3)
  })

  it('counts the catalogue regardless of window', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    createThread({ name: 'Archived', source: 'user', status: 'archived' })
    createBlock({ threadId: t.id })
    confirmMatcher({ field: 'resource', operator: 'exact', pattern: 'a', threadId: t.id })
    writeInferredMatcher({ field: 'resource', operator: 'exact', pattern: 'b', threadId: t.id, confidence: 0.5, example: {} })

    const result = stats()
    expect(result.blocks).toBe(1)
    expect(result.threads).toBe(1) // archived excluded
    expect(result.matchers).toBe(2)
    expect(result.confirmedMatchers).toBe(1)
  })
})
