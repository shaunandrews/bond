/**
 * Pure logic for `bond desk`, split out so tests don't trigger the CLI's
 * main() on import (same split as ask-helpers.ts and library-helpers.ts).
 */
import { formatApproxDuration } from '../shared/desk'
import type { DeskBlockDetail, DeskMatcher, DeskStats, DeskStatus, DeskThread } from '../shared/desk'

export type DeskCommand =
  | { kind: 'status' }
  | { kind: 'blocks'; day?: string; limit: number }
  | { kind: 'threads'; includeArchived: boolean }
  | { kind: 'matchers'; confirmedOnly: boolean }
  | { kind: 'answer'; questionId: string | null; verdict: 'accept' | 'reject' | null }
  | { kind: 'stats'; windowHours: number }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'help' }
  | { kind: 'unknown'; command: string }

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

export function parseDeskArgs(args: string[]): DeskCommand {
  const command = args[0] ?? 'status'

  switch (command) {
    case '':
    case 'status':
      return { kind: 'status' }
    case 'on':
      return { kind: 'on' }
    case 'off':
      return { kind: 'off' }
    case 'blocks': {
      const day = flagValue(args, '--day')
      const limit = Number(flagValue(args, '--limit') ?? 50)
      return { kind: 'blocks', day, limit: Number.isFinite(limit) && limit > 0 ? limit : 50 }
    }
    case 'threads':
      return { kind: 'threads', includeArchived: args.includes('--all') }
    case 'matchers':
      return { kind: 'matchers', confirmedOnly: !args.includes('--all') }
    case 'answer': {
      // `bond desk answer <id> yes|no`, or `bond desk answer yes|no` for the
      // pending one — the common case, since only one can be pending at a time.
      const rest = args.slice(1).filter(a => !a.startsWith('--'))
      const verdictArg = rest.find(a => ['yes', 'no', 'y', 'n'].includes(a.toLowerCase()))
      const questionId = rest.find(a => a !== verdictArg) ?? null
      // A MISSING verdict is a usage error, never a silent rejection — a reject
      // becomes a durable negative rule, and a typo must not mint one.
      const verdict = verdictArg
        ? (verdictArg.toLowerCase().startsWith('y') ? 'accept' : 'reject')
        : null
      return { kind: 'answer', questionId, verdict }
    }
    case 'stats': {
      const hours = Number(flagValue(args, '--hours') ?? 24)
      return { kind: 'stats', windowHours: Number.isFinite(hours) && hours > 0 ? hours : 24 }
    }
    case 'help':
    case '-h':
    case '--help':
      return { kind: 'help' }
    default:
      return { kind: 'unknown', command }
  }
}

/** Local start/end of a `YYYY-MM-DD` day, as ISO instants for `desk.blocks`. */
export function dayRange(day: string): { from: string; to: string } {
  const [year, month, date] = day.split('-').map(Number)
  const from = new Date(year, (month ?? 1) - 1, date ?? 1, 0, 0, 0, 0)
  const to = new Date(year, (month ?? 1) - 1, date ?? 1, 23, 59, 59, 999)
  return { from: from.toISOString(), to: to.toISOString() }
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

export function formatStatus(status: DeskStatus): string {
  const lines: string[] = []
  lines.push(`Desk        ${status.running ? 'running' : 'off'}`)
  // `senseState` is already 'disabled' when Sense is off — appending "(disabled)"
  // to it read as a stutter in the first real run.
  const senseOff = !status.senseEnabled && status.senseState !== 'disabled'
  lines.push(`Sense       ${status.senseState}${senseOff ? ' (turned off)' : ''}`)

  if (status.currentBlock) {
    const name = status.currentBlock.thread?.name ?? 'unknown'
    lines.push(`Now         ${name} · ${formatApproxDuration(status.presenceSeconds)}`)
    if (status.currentBlock.reentryNote) lines.push(`            ${status.currentBlock.reentryNote}`)
  } else {
    lines.push('Now         —')
  }

  if (status.pendingQuestion) {
    const q = status.pendingQuestion
    const subject = q.proposedThreadName ?? q.itemTitle ?? q.kind
    lines.push(`Asking      ${subject}?  (bond desk answer yes|no)`)
  }
  // Only meaningful while Desk is actually observing — a stopped Desk is behind
  // by definition, and saying "catching up" there implies work that isn't happening.
  if (status.backfilling && status.running) lines.push('Back-fill   catching up on existing captures')
  if (status.unresolvedSegments > 0) lines.push(`Unresolved  ${status.unresolvedSegments} segment(s)`)
  return lines.join('\n')
}

export function formatBlocks(blocks: DeskBlockDetail[]): string {
  if (blocks.length === 0) return 'No blocks.'
  return blocks
    .map(block => {
      const name = block.thread?.name ?? '(unknown)'
      const span = `${time(block.startedAt)}${block.endedAt ? `–${time(block.endedAt)}` : '–now'}`
      const head = `${span}  ${formatApproxDuration(block.presenceSeconds).padStart(8)}  ${name}`
      // Time is secondary decoration; the re-entry note is the point.
      return block.reentryNote ? `${head}\n${' '.repeat(12)}${block.reentryNote}` : head
    })
    .join('\n')
}

export function formatThreads(threads: DeskThread[]): string {
  if (threads.length === 0) return 'No threads yet.'
  return threads
    .map(t => {
      const marks = [t.status, t.source].join('/')
      const seen = t.lastSeenAt ? new Date(t.lastSeenAt).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : '—'
      const note = t.userNote ? `\n            ${t.userNote}` : ''
      return `${t.name.padEnd(34)} ${marks.padEnd(22)} ${seen}${note}`
    })
    .join('\n')
}

export function formatMatchers(matchers: DeskMatcher[]): string {
  if (matchers.length === 0) return 'No matchers.'
  return matchers
    .map(m => {
      const state = m.enabled ? (m.confirmed ? 'confirmed' : 'inferred') : 'disabled'
      const example = m.example.titles?.[0] ? `  e.g. ${m.example.titles[0]}` : ''
      return `${state.padEnd(10)} ${m.field}:${m.operator} "${m.pattern}"  → ${m.threadId}  (${m.hits} hits)${example}`
    })
    .join('\n')
}

/**
 * The go/no-go numbers. Steady state should trend toward the batched-summary
 * estimate (~32 calls/day, ~$1.30/mo) without breaking the three-minute
 * interaction contract.
 */
export function formatStats(stats: DeskStats): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const approxTokens = Math.round(stats.promptChars / 4)
  const perDay = stats.windowHours > 0 ? (stats.modelCalls / stats.windowHours) * 24 : 0

  return [
    `Window            last ${stats.windowHours}h`,
    '',
    `Model calls       ${stats.modelCalls}  (${stats.immediateCalls} immediate, ${stats.sweptCalls} swept)`,
    `Projected         ~${perDay.toFixed(1)} calls/day`,
    `Failed calls      ${stats.failedCalls}`,
    `Prompt tokens     ~${approxTokens} (${stats.promptChars} chars)`,
    `Avg latency       ${stats.avgLatencyMs}ms`,
    '',
    `Cache hit rate    ${pct(stats.cacheHitRate)}  (${stats.segmentsResolvedByMatcher} by matcher, ${stats.segmentsResolvedByModel} by model)`,
    `Unknown latency   ${stats.medianUnknownLatencySeconds === null ? '—' : `${stats.medianUnknownLatencySeconds}s median`}`,
    `Unresolved        ${stats.unresolvedSegments}`,
    '',
    `Blocks            ${stats.blocks}`,
    `Threads           ${stats.threads}`,
    `Matchers          ${stats.matchers} (${stats.confirmedMatchers} confirmed)`,
  ].join('\n')
}

export const DESK_HELP = `bond desk — what's on your desk

  bond desk                      Status: running state, current thread, pending Ask
  bond desk on | off             Start/stop observing (independent of Sense)
  bond desk blocks [--day D]     Blocks for a day (YYYY-MM-DD, default today)
  bond desk threads [--all]      Thread catalogue
  bond desk matchers [--all]     Confirmed rules (--all includes inferred)
  bond desk answer [id] yes|no   Answer the pending Ask
  bond desk stats [--hours N]    Inference instrumentation for the go/no-go`
