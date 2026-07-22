import type { MemoryHealth, MemoryRunSummary } from '../shared/memory'

/** Pure formatting, split out so tests import it without triggering main(). */

export interface MemoryArgs {
  subcommand: 'status'
  json: boolean
}

export function parseMemoryArgs(argv: string[]): MemoryArgs {
  const json = argv.includes('--json')
  const positional = argv.filter(arg => !arg.startsWith('--'))
  return { subcommand: positional[0] === 'status' || !positional[0] ? 'status' : 'status', json }
}

export function formatAge(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return 'unknown'
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatRun(run: MemoryRunSummary): string {
  const counts = `+${run.persistedCount}${run.skippedCount ? ` −${run.skippedCount}` : ''}`
  const reason = run.reason ? ` — ${run.reason.slice(0, 80)}` : ''
  return `    ${run.kind.padEnd(9)} ${run.outcome.padEnd(16)} ${String(run.rangeFrom).padStart(5)}-${String(run.rangeTo).padEnd(5)} ${counts}${reason}`
}

/**
 * The report the 2026-07-21 incident needed and nobody could get: is memory
 * writing, how far behind is it, and what broke.
 */
export function formatMemoryStatus(health: MemoryHealth, now = Date.now()): string {
  const lines = ['Memory']
  lines.push(`  working   last written ${formatAge(health.workingUpdatedAt, now)}${health.workingUpdatedAt ? ` (${health.workingUpdatedAt})` : ''}`)
  lines.push(`  core      last written ${formatAge(health.coreUpdatedAt, now)} · ${health.coreItems} item${health.coreItems === 1 ? '' : 's'}`)

  const observerState = health.observerLagSeqs === 0
    ? 'up to date'
    : `${health.observerLagSeqs} seq${health.observerLagSeqs === 1 ? '' : 's'} behind (${health.observedThroughSeq} / ${health.maxSeq})`
  const observerFailures = health.consecutiveObserverFailures > 0 ? ` · ${health.consecutiveObserverFailures} consecutive failure${health.consecutiveObserverFailures === 1 ? '' : 's'}` : ''
  lines.push(`  observer  ${observerState}${observerFailures}`)

  const reflectorPending = Math.max(0, health.maxSeq - health.reflectedThroughSeq)
  const reflectorFailures = health.consecutiveReflectorFailures > 0 ? ` · ${health.consecutiveReflectorFailures} consecutive failure${health.consecutiveReflectorFailures === 1 ? '' : 's'}` : ''
  lines.push(`  reflector ${reflectorPending} pending (${health.reflectedThroughSeq} / ${health.maxSeq})${reflectorFailures}`)

  if (health.lastError) lines.push(`  last error: ${health.lastError.slice(0, 160)}`)
  if (isDegraded(health)) lines.push('  DEGRADED — memory writes are failing or stalled')

  if (health.lastRuns.length) {
    lines.push('  recent runs:')
    for (const run of health.lastRuns) lines.push(formatRun(run))
  }
  return lines.join('\n')
}

export function isDegraded(health: MemoryHealth): boolean {
  return health.consecutiveObserverFailures >= 2
    || health.consecutiveReflectorFailures >= 2
    || health.observerLagSeqs > 48
}
