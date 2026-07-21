/**
 * The slow path: classify unknown resources in batches.
 *
 * Two entry points into the same batch — an immediate call when a candidate
 * reaches three minutes (so the Ask can still be timely, capped per hour), and
 * a 15-minute sweep that catches shorter segments and performs startup
 * back-fill. Both collapse every pending unknown into ONE 200–500-token
 * request.
 *
 * Three hard rules, all of them ship criteria:
 *  - Never send screenshots or image paths. Metadata and already-redacted text
 *    excerpts only.
 *  - Everything in the prompt passes `redact()` again at assembly time. The
 *    rows Sense already wrote hold raw titles — back-fill reads them, so this
 *    cannot assume the store is clean.
 *  - The model's answer goes through `writeInferredMatcher`, which cannot
 *    mutate a confirmed row and cannot set `confirmed = 1`.
 *
 * Parsing is strict-and-accumulating (the `memory/service.ts` pattern): a bad
 * item is dropped with a reason, never thrown, so one malformed entry cannot
 * lose a whole batch.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import { oneOffReason, redactAll, redactField, tooBroadReason } from './signature'
import {
  attributeSegment,
  createThread,
  findThreadByName,
  getSegment,
  listThreads,
  listUnresolvedSegments,
  markSegmentFailed,
  markSegmentsQueued,
  maybeEstablishThread,
  touchThread,
} from './store'
import { isSuppressed, writeInferredMatcher } from './matchers'
import { BACKFILL_HORIZON_HOURS } from './segmenter'
import type { DeskEvidence, DeskSegment, DeskThread } from '../../shared/desk'

/** How the batch reaches a model. Injected so tests never touch a provider. */
export type TextPrompt = (prompt: string, model: 'fast' | 'balanced' | 'high') => Promise<string>

export interface InferenceOptions {
  db?: Database.Database
  prompt: TextPrompt
  now?: () => Date
  /** 'immediate' is the three-minute path; 'sweep' is the 15-minute one. */
  kind?: 'immediate' | 'sweep'
  limit?: number
  /** Overridable for tests; production uses PROMPT_TIMEOUT_MS. */
  timeoutMs?: number
  /** Oldest segment worth a model call. Defaults to the back-fill horizon. */
  since?: string
}

/** Reject rather than hang — a stranded batch is worse than a failed one. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return work
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`inference timed out after ${ms}ms`)), ms)
    timer.unref?.()
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

/** Attempts before a segment stops being retried at all. */
const MAX_ATTEMPTS = 4
/**
 * The batch must fail loudly rather than sit on `queued` segments the sweep can
 * no longer see — but the ceiling has to clear a cold Pi session, not just the
 * model call. Measured on the first live back-fill sweeps: 47.7s for a cold
 * success, and a 60s ceiling cut off a call that was still working. 120s leaves
 * headroom on that without letting a wedged provider hold a batch all day.
 */
const PROMPT_TIMEOUT_MS = 120_000
/**
 * Prompt budget, tuned against a real back-fill batch rather than guessed: at
 * 400 excerpt chars over 24 segments the first live sweep produced an
 * 11,851-character prompt (~3k tokens) against the plan's 200-500 target.
 */
const EXCERPT_CHARS = 160
const MAX_BATCH_SEGMENTS = 14
/** The closed label set the model picks from. */
const MAX_THREAD_LABELS = 24
/** Exponential-ish backoff between attempts, in minutes. */
const RETRY_MINUTES = [5, 20, 60]

export interface InferenceResult {
  segments: number
  resolved: number
  failed: number
  threadsProposed: number
  promptChars: number
  latencyMs: number
  ok: boolean
  error?: string
  /** Parse problems, accumulated rather than thrown. */
  problems: string[]
}

// --- prompt assembly ---

interface SegmentBrief {
  ref: string
  segmentId: string
  appName: string
  titles: string[]
  paths: string[]
  excerpt: string | null
  minutes: number
}

/**
 * A capture with failed or empty text is still eligible for metadata-only
 * classification — it must not sit unresolved forever waiting for text that is
 * never coming.
 */
function excerptFor(segmentId: string, db: Database.Database): string | null {
  const rows = db.prepare(`
    SELECT c.text_content FROM desk_capture_links l
    JOIN sense_captures c ON c.id = l.capture_id
    WHERE l.segment_id = ? AND c.text_content IS NOT NULL AND c.text_status = 'done'
    ORDER BY c.captured_at DESC LIMIT 2
  `).all(segmentId) as { text_content: string }[]
  if (rows.length === 0) return null
  const joined = rows.map(r => r.text_content).join(' ').replace(/\s+/g, ' ').trim()
  if (!joined) return null
  // 400 chars/segment put a real 24-segment batch at ~3k tokens against a
  // 200-500 target. Classification is a labelling task — the app, the title,
  // and a sentence of context carry it; the rest is paid-for noise.
  const clipped = joined.slice(0, EXCERPT_CHARS)
  // Sense redacted this once on extraction; redact again because Desk transmits it.
  return redactField(clipped)
}

export function buildBriefs(segments: DeskSegment[], db: Database.Database): SegmentBrief[] {
  return segments.map((segment, index) => {
    const evidence: DeskEvidence = segment.evidence ?? {}
    return {
      ref: `S${index + 1}`,
      segmentId: segment.id,
      appName: redactField(evidence.appName ?? evidence.bundleId ?? null) ?? 'Unknown app',
      // Raw rows written by Sense are unredacted; back-fill reads them, so
      // redact at assembly rather than trusting the store.
      titles: redactAll(evidence.titles ?? []).slice(0, 2),
      paths: redactAll(evidence.paths ?? []).slice(0, 2),
      excerpt: excerptFor(segment.id, db),
      minutes: Math.max(1, Math.round(segment.presenceSeconds / 60)),
    }
  })
}

/**
 * Threads are offered as short `T1..Tn` refs rather than raw UUIDs. A uuid is
 * 36 characters of pure cost per label, and asking a model to echo one back
 * exactly is the easiest possible way to get a hallucinated id.
 */
export function threadRefs(threads: DeskThread[]): Map<string, DeskThread> {
  return new Map(threads.map((t, i) => [`T${i + 1}`, t]))
}

export function buildPrompt(briefs: SegmentBrief[], threads: DeskThread[]): string {
  const refs = threadRefs(threads)
  const labels = threads.length
    ? [...refs].map(([ref, t]) => `- ${ref}: ${t.name}`).join('\n')
    : '(none yet)'

  const observations = briefs.map(b => {
    const lines = [`${b.ref}. app: ${b.appName} (~${b.minutes}m)`]
    if (b.titles.length) lines.push(`   titles: ${b.titles.join(' | ')}`)
    if (b.paths.length) lines.push(`   paths: ${b.paths.join(' | ')}`)
    if (b.excerpt) lines.push(`   text: ${b.excerpt}`)
    return lines.join('\n')
  }).join('\n')

  return `You are labelling observed desktop activity into coherent work threads.

A thread is a coherent piece of work — "Studio", "Bond mobile composer", "ISP problem" — and it SPANS APPS. Studio might be a dev build (reporting as "Electron"), a terminal in the studio folder, a Figma file, a Linear issue: one thread. App names mislead — two dev builds are both "Electron", every terminal tab is the same terminal.

What identifies a thread is the PROJECT TOKEN: a distinctive name like "studio" or "bond" inside a title, path, or URL. Look there first.

Existing threads (reply with the T-ref when the activity belongs to one):
${labels}

Observations:
${observations}

For each observation, reply with one line:
<ref>|<T-ref or NEW:thread name>|<confidence 0-1>|<matcher field: title|path|bundle|none>|<matcher pattern or ->

Rules:
- Prefer an existing T-ref. Propose at most ONE new thread across the whole batch, and only if nothing existing fits.
- The matcher is the PROJECT TOKEN, not the whole title. For "~/Developer/Projects/studio — nvim" the matcher is "studio", which also matches the Figma file and the GitHub page. Matching is substring-based.
- Use "none" when nothing generalizes: a one-off article, a product page, a document you will never see again. The resource is cached either way, so "none" costs nothing.
- Never a bare app name (Chrome, Terminal, Slack, Code, Electron), never a filename containing a uuid or hash.
- Confidence below 0.5 means you are guessing; say so honestly.
- Output only the lines. No prose, no headers, no markdown.`
}

// --- parsing ---

export interface ParsedLine {
  ref: string
  threadId: string | null
  newThreadName: string | null
  confidence: number
  matcherField: 'bundle' | 'title' | 'path' | null
  matcherPattern: string | null
}

const VALID_FIELDS = new Set(['bundle', 'title', 'path'])

/**
 * Strict parse that accumulates problems instead of throwing. One malformed
 * line must not lose the rest of a batch.
 */
export function parseResponse(
  text: string,
  validRefs: Set<string>
): { lines: ParsedLine[]; problems: string[] } {
  const lines: ParsedLine[] = []
  const problems: string[] = []
  const seen = new Set<string>()

  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*\d.)\s]+/, '')
    if (!line || !line.includes('|')) continue
    const parts = line.split('|').map(p => p.trim())
    if (parts.length < 3) { problems.push(`too few fields: ${line.slice(0, 60)}`); continue }

    const [ref, thread, confidenceRaw, fieldRaw, patternRaw] = parts
    if (!validRefs.has(ref)) { problems.push(`unknown ref: ${ref}`); continue }
    if (seen.has(ref)) { problems.push(`duplicate ref: ${ref}`); continue }

    const confidence = Number(confidenceRaw)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      problems.push(`bad confidence for ${ref}: ${confidenceRaw}`)
      continue
    }

    let threadId: string | null = null
    let newThreadName: string | null = null
    if (/^new\s*:/i.test(thread)) {
      newThreadName = thread.replace(/^new\s*:/i, '').trim().slice(0, 80)
      if (!newThreadName) { problems.push(`empty new thread name for ${ref}`); continue }
    } else if (thread && thread !== '-' && thread.toLowerCase() !== 'none') {
      threadId = thread
    } else {
      problems.push(`no thread for ${ref}`)
      continue
    }

    const field = fieldRaw && VALID_FIELDS.has(fieldRaw.toLowerCase()) ? fieldRaw.toLowerCase() : null
    const pattern = patternRaw && patternRaw !== '-' ? patternRaw.slice(0, 200) : null

    seen.add(ref)
    lines.push({
      ref,
      threadId,
      newThreadName,
      confidence,
      matcherField: field as ParsedLine['matcherField'],
      matcherPattern: field && pattern ? pattern : null,
    })
  }

  return { lines, problems }
}

// --- application ---

function retryAtFor(attempts: number, nowMs: number): string | null {
  if (attempts >= MAX_ATTEMPTS) return null
  const minutes = RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length - 1)]
  return new Date(nowMs + minutes * 60_000).toISOString()
}

/**
 * Run one batch. Returns metrics whether or not the model call succeeded —
 * `bond desk stats` reads these, and a failed call is data too.
 */
export async function runInferenceBatch(options: InferenceOptions): Promise<InferenceResult> {
  const db = options.db ?? getDb()
  const now = options.now ? options.now() : new Date()
  const nowIso = now.toISOString()
  const nowMs = now.getTime()

  const result: InferenceResult = {
    segments: 0, resolved: 0, failed: 0, threadsProposed: 0,
    promptChars: 0, latencyMs: 0, ok: true, problems: [],
  }

  // Never spend a model call labelling activity older than Desk reaches back.
  const since = options.since
    ?? new Date(nowMs - BACKFILL_HORIZON_HOURS * 3_600_000).toISOString()
  const segments = listUnresolvedSegments(
    { limit: options.limit ?? MAX_BATCH_SEGMENTS, nowIso, since },
    db
  )
  if (segments.length === 0) return result
  result.segments = segments.length

  const briefs = buildBriefs(segments, db)
  // Established threads plus recently provisional ones are the closed label
  // set. Inference may propose one new provisional thread and nothing more.
  const threads = listThreads({}, db).slice(0, MAX_THREAD_LABELS)
  const prompt = buildPrompt(briefs, threads)
  result.promptChars = prompt.length

  markSegmentsQueued(segments.map(s => s.id), db)

  let response: string
  const startedMs = Date.now()
  try {
    response = await withTimeout(options.prompt(prompt, 'fast'), options.timeoutMs ?? PROMPT_TIMEOUT_MS)
  } catch (error) {
    result.latencyMs = Date.now() - startedMs
    result.ok = false
    result.error = error instanceof Error ? error.message : String(error)
    for (const segment of segments) {
      markSegmentFailed(segment.id, retryAtFor(segment.inferenceAttempts + 1, nowMs), db)
      result.failed++
    }
    return result
  }
  result.latencyMs = Date.now() - startedMs

  const byRef = new Map(briefs.map(b => [b.ref, b]))
  const { lines, problems } = parseResponse(response, new Set(byRef.keys()))
  result.problems = problems

  const refs = threadRefs(threads)
  const threadIds = new Set(threads.map(t => t.id))
  let proposedThreadId: string | null = null

  const apply = db.transaction(() => {
    for (const line of lines) {
      const brief = byRef.get(line.ref)!
      const segment = getSegment(brief.segmentId, db)
      if (!segment) continue

      // Accept the short ref we offered, or a raw id if the model echoed one.
      let threadId = line.threadId && refs.has(line.threadId)
        ? refs.get(line.threadId)!.id
        : line.threadId
      if (line.newThreadName) {
        // At most one new thread per batch; later proposals reuse it only if
        // they named the same thing.
        const existingByName = findThreadByName(line.newThreadName, db)
        if (existingByName) {
          threadId = existingByName.id
        } else if (proposedThreadId && !existingByName) {
          result.problems.push(`extra new-thread proposal ignored for ${line.ref}`)
          continue
        } else {
          const created = createThread({ name: line.newThreadName, source: 'inferred' }, db)
          proposedThreadId = created.id
          threadId = created.id
          result.threadsProposed++
        }
      }

      if (!threadId || (!threadIds.has(threadId) && threadId !== proposedThreadId)) {
        result.problems.push(`unknown thread for ${line.ref}: ${line.threadId}`)
        markSegmentFailed(segment.id, retryAtFor(segment.inferenceAttempts + 1, nowMs), db)
        result.failed++
        continue
      }

      // A rejected pairing stays rejected — inference cannot walk it back.
      if (isSuppressed(segment.resourceSignature, threadId, nowIso, db)) {
        result.problems.push(`suppressed pairing for ${line.ref}`)
        markSegmentFailed(segment.id, retryAtFor(MAX_ATTEMPTS, nowMs), db)
        result.failed++
        continue
      }

      // The exact-resource matcher is always written; a narrower concrete
      // pattern is written too when the model named one.
      const write = writeInferredMatcher({
        field: 'resource', operator: 'exact', pattern: segment.resourceSignature,
        threadId, confidence: line.confidence, example: segment.evidence,
      }, db)

      // The prompt asks for a narrow pattern; this is what enforces it. A
      // rejected pattern costs nothing — the exact-resource matcher above
      // already caches this resource, and a too-broad rule mis-attributes
      // everything it touches from then on.
      if (line.matcherField && line.matcherPattern) {
        const reason = tooBroadReason(line.matcherField, line.matcherPattern, {
          appName: segment.evidence.appName,
          bundleId: segment.evidence.bundleId,
        }) ?? oneOffReason(line.matcherPattern)
        if (reason) {
          result.problems.push(`rejected matcher for ${line.ref}: ${reason}`)
        } else {
          writeInferredMatcher({
            field: line.matcherField,
            // A project token lives INSIDE a title ("~/Projects/studio — nvim"),
            // so prefix matching could never find it. Paths and bundle ids are
            // already whole identifiers.
            operator: line.matcherField === 'title' ? 'contains'
              : line.matcherField === 'path' ? 'contains'
              : 'exact',
            pattern: line.matcherPattern,
            threadId,
            confidence: line.confidence,
            example: segment.evidence,
          }, db)
        }
      }

      // `matcher_id` records what PRODUCED this attribution, and here that is
      // the model — not the matcher this call just wrote for *future* segments.
      // Attaching it would make every model-resolved segment look like a cache
      // hit, and `cacheHitRate` is the number the go/no-go turns on.
      void write
      attributeSegment(segment.id, { threadId, matcherId: null, confidence: line.confidence }, db)
      touchThread(threadId, nowIso, db)
      maybeEstablishThread(threadId, db)
      result.resolved++
    }

    // Anything the model simply didn't answer for stays retryable.
    for (const brief of briefs) {
      if (lines.some(l => l.ref === brief.ref)) continue
      const segment = getSegment(brief.segmentId, db)
      if (!segment || segment.attributionState !== 'queued') continue
      markSegmentFailed(segment.id, retryAtFor(segment.inferenceAttempts + 1, nowMs), db)
      result.failed++
    }
  })

  apply()
  return result
}

/**
 * The immediate-inference ceiling. Six calls per hour, after which unknowns
 * fall through to the sweep and the Ask simply arrives late.
 */
export const IMMEDIATE_CALLS_PER_HOUR = 6

export function immediateBudgetRemaining(
  nowIso: string = new Date().toISOString(),
  db: Database.Database = getDb()
): number {
  const since = new Date(Date.parse(nowIso) - 3_600_000).toISOString()
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM desk_metrics WHERE kind = 'immediate' AND recorded_at >= ?"
  ).get(since) as { n: number }
  return Math.max(0, IMMEDIATE_CALLS_PER_HOUR - row.n)
}

/** Instrumentation the Phase 2 go/no-go reads. Without it the trial is an impression. */
export function recordMetrics(
  kind: 'immediate' | 'sweep',
  result: InferenceResult,
  nowIso: string = new Date().toISOString(),
  db: Database.Database = getDb()
): void {
  db.prepare(`
    INSERT INTO desk_metrics (recorded_at, kind, calls, segments, prompt_chars, latency_ms, ok)
    VALUES (?, ?, 1, ?, ?, ?, ?)
  `).run(nowIso, kind, result.segments, result.promptChars, result.latencyMs, result.ok ? 1 : 0)
}
