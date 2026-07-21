/**
 * The instrumentation the Phase 2 go/no-go reads.
 *
 * The ship criteria demand model-call count, tokens, immediate-vs-swept ratio,
 * cache hit rate, and unknown-resource latency. Without somewhere for those to
 * live the dogfood produces an impression instead of a decision.
 *
 * Prompt *characters* stand in for tokens — Desk never sees a provider's token
 * count, and ~4 chars/token is close enough to compare against the $1.30/mo
 * batched-summary estimate.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import type { DeskStats } from '../../shared/desk'

export function computeStats(
  opts: { windowHours?: number; now?: Date; db?: Database.Database } = {}
): DeskStats {
  const db = opts.db ?? getDb()
  const now = opts.now ?? new Date()
  const windowHours = opts.windowHours ?? 24
  const since = new Date(now.getTime() - windowHours * 3_600_000).toISOString()

  const metrics = db.prepare(`
    SELECT kind, COUNT(*) AS calls, SUM(segments) AS segments, SUM(prompt_chars) AS prompt_chars,
           SUM(latency_ms) AS latency_ms, SUM(ok) AS ok_calls
    FROM desk_metrics WHERE recorded_at >= ?
    GROUP BY kind
  `).all(since) as {
    kind: string; calls: number; segments: number; prompt_chars: number; latency_ms: number; ok_calls: number
  }[]

  const immediate = metrics.find(m => m.kind === 'immediate')
  const sweep = metrics.find(m => m.kind === 'sweep')
  const modelCalls = metrics.reduce((n, m) => n + m.calls, 0)
  const okCalls = metrics.reduce((n, m) => n + Number(m.ok_calls ?? 0), 0)
  const totalLatency = metrics.reduce((n, m) => n + Number(m.latency_ms ?? 0), 0)

  // A matcher hit is a resolution that cost nothing; a model hit is one that did.
  const byMatcher = (db.prepare(`
    SELECT COUNT(*) AS n FROM desk_segments
    WHERE attribution_state = 'resolved' AND matcher_id IS NOT NULL AND started_at >= ?
  `).get(since) as { n: number }).n
  const byModel = (db.prepare(`
    SELECT COUNT(*) AS n FROM desk_segments
    WHERE attribution_state = 'resolved' AND matcher_id IS NULL AND started_at >= ?
  `).get(since) as { n: number }).n
  const unresolved = (db.prepare(`
    SELECT COUNT(*) AS n FROM desk_segments
    WHERE attribution_state IN ('unresolved', 'queued', 'failed') AND started_at >= ?
  `).get(since) as { n: number }).n

  // How long an unknown resource waited between being seen and being labelled.
  const latencies = (db.prepare(`
    SELECT (julianday(attributed_at) - julianday(started_at)) * 86400.0 AS seconds
    FROM desk_segments
    WHERE attributed_at IS NOT NULL AND matcher_id IS NULL AND started_at >= ?
    ORDER BY seconds
  `).all(since) as { seconds: number }[]).map(r => Number(r.seconds)).filter(Number.isFinite)

  const median = latencies.length
    ? Math.round(latencies[Math.floor(latencies.length / 2)])
    : null

  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n

  const resolvedTotal = byMatcher + byModel
  return {
    windowHours,
    modelCalls,
    failedCalls: modelCalls - okCalls,
    immediateCalls: immediate?.calls ?? 0,
    sweptCalls: sweep?.calls ?? 0,
    segmentsInferred: metrics.reduce((n, m) => n + Number(m.segments ?? 0), 0),
    promptChars: metrics.reduce((n, m) => n + Number(m.prompt_chars ?? 0), 0),
    avgLatencyMs: modelCalls > 0 ? Math.round(totalLatency / modelCalls) : 0,
    cacheHitRate: resolvedTotal > 0 ? byMatcher / resolvedTotal : 0,
    segmentsResolvedByMatcher: byMatcher,
    segmentsResolvedByModel: byModel,
    unresolvedSegments: unresolved,
    medianUnknownLatencySeconds: median,
    blocks: count('SELECT COUNT(*) AS n FROM desk_blocks'),
    threads: count("SELECT COUNT(*) AS n FROM desk_threads WHERE status != 'archived'"),
    matchers: count('SELECT COUNT(*) AS n FROM desk_matchers'),
    confirmedMatchers: count('SELECT COUNT(*) AS n FROM desk_matchers WHERE confirmed = 1'),
  }
}
