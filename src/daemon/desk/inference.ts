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
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import { isBadThreadName, oneOffReason, redactAll, redactField, tooBroadReason } from './signature'
import { recordLabel } from './labels'
import { getRulesVersion, stampDerivedVersion } from './store'
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
import { getSenseSettings } from '../settings'
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
  urls: string[]
  coTitles: string[]
  minutes: number
}

/**
 * The brief is now built from *structured* evidence only — app, title, path,
 * URL, and the titles of co-visible windows. The whole-screen OCR excerpt was
 * removed deliberately (Phase 1): measured lift analysis found no token above
 * 1.30x over the ambient screen-noise base rate on the signatures covering 40%
 * of the day, so it never carried a classification; and it was where the
 * privacy exposure concentrated — unbounded free screen text with no file
 * extension or syntax for redaction to anchor on. Co-visible titles do not
 * bleed the way whole-screen OCR does: each is bound to a named window.
 */
export function buildBriefs(segments: DeskSegment[], _db?: Database.Database): SegmentBrief[] {
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
      urls: redactAll(evidence.urls ?? []).slice(0, 2),
      coTitles: redactAll(evidence.coTitles ?? []).slice(0, 3),
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
    if (b.urls.length) lines.push(`   urls: ${b.urls.join(' | ')}`)
    if (b.paths.length) lines.push(`   paths: ${b.paths.join(' | ')}`)
    if (b.coTitles.length) lines.push(`   also open: ${b.coTitles.join(' | ')}`)
    return lines.join('\n')
  }).join('\n')

  return `You are labelling observed desktop activity into coherent work threads.

A thread is a coherent piece of work — "Studio", "Bond mobile composer", "ISP problem" — and it SPANS APPS. Studio might be a dev build (reporting as "Electron"), a terminal in the studio folder, a Figma file, a Linear issue: one thread. App names mislead — two dev builds are both "Electron", every terminal tab is the same terminal.

What identifies a thread is the PROJECT TOKEN: a distinctive name like "studio" or "bond" inside a title, path, or URL. Look there first.

Existing threads (reply with the T-ref when the activity belongs to one):
${labels}

Observations:
${observations}

"also open" lists the titles of other windows visible at the same time — strong context for what a container app (a bare "Electron" or "Chrome") was actually being used FOR. Weigh it, but the focused window's own title/url/path is the primary signal.

For each observation, reply with one line:
<ref>|<T-ref, NEW:thread name, or NONE>|<confidence 0-1>|<matcher field: url|title|path|bundle|none>|<matcher pattern or ->

Rules:
- Prefer an existing T-ref. Propose at most ONE new thread across the whole batch, and only if nothing existing fits.
- Use NONE as the thread when the activity is NOT WORK — a video, a music player, a chat, an article, a game. Do not invent a thread to hold leisure. NONE files it under nothing.
- A new thread names a PIECE OF WORK ("ISP problem", "Bond mobile composer"), never a tool ("Chrome", "Electron") and never a junk drawer ("one-off", "misc", "other").
- The matcher is the PROJECT TOKEN, not the whole title. For "~/Developer/Projects/studio — nvim" the matcher is "studio", which also matches the Figma file and the GitHub page. A url matcher like "linear.app/a8c/issue/STU" is even stronger. Matching is substring-based.
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
  /** The model declared this segment "not work" — file it under nothing. */
  none: boolean
  confidence: number
  matcherField: 'url' | 'bundle' | 'title' | 'path' | null
  matcherPattern: string | null
}

const VALID_FIELDS = new Set(['url', 'bundle', 'title', 'path'])

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
    let none = false
    if (/^new\s*:/i.test(thread)) {
      newThreadName = thread.replace(/^new\s*:/i, '').trim().slice(0, 80)
      if (!newThreadName) { problems.push(`empty new thread name for ${ref}`); continue }
    } else if (thread.toUpperCase() === 'NONE') {
      // The "not work" verdict: leisure, a video, a chat. The segment resolves
      // to nothing so it stops re-querying and never mints a leisure thread.
      none = true
    } else if (thread && thread !== '-') {
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
      none,
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

  // Reach back across the whole retention window, not a fixed 24 hours. The
  // old 24h horizon made any segment older than a day invisible to the sweep
  // forever — zero attempts, zero errors — which is how a whole day (2026-07-19)
  // was silently abandoned with unresolved segments its capture data still
  // backed. The per-hour sweep budget, not an age cliff, is what bounds cost.
  const retentionDays = Math.max(1, getSenseSettings().textRetentionDays)
  const since = options.since
    ?? new Date(nowMs - retentionDays * 86_400_000).toISOString()
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

  // One batch id, so a rejection can later find every label this batch wrote.
  const batchId = randomUUID()
  const rulesVersion = getRulesVersion(db)
  const recordModelLabel = (segmentId: string, threadId: string | null, confidence: number) => {
    recordLabel({ segmentId, threadId, source: 'model', provenance: batchId, confidence }, db)
    stampDerivedVersion(segmentId, rulesVersion, db)
  }

  const apply = db.transaction(() => {
    for (const line of lines) {
      const brief = byRef.get(line.ref)!
      const segment = getSegment(brief.segmentId, db)
      if (!segment) continue

      // The user's write always wins. This segment was marked `queued` before
      // the model call; if it is no longer queued, a reassignment (or another
      // resolver) touched it during the up-to-120s await. The model's answer
      // must not silently revert that. The "didn't answer" loop below already
      // guards the same way — the main apply path did not, and that was the
      // hole through which inference reverted a live correction.
      if (segment.attributionState !== 'queued') {
        result.problems.push(`segment ${line.ref} changed under inference; skipped`)
        continue
      }

      // The "not work" verdict: resolve to nothing. It stops re-querying and
      // never mints a leisure thread or surfaces a block. Declining to file
      // leisure AS work is a description, not a grade.
      if (line.none) {
        attributeSegment(segment.id, { threadId: null, matcherId: null, confidence: line.confidence, state: 'resolved' }, db)
        recordModelLabel(segment.id, null, line.confidence)
        result.resolved++
        continue
      }

      // Accept the short ref we offered, or a raw id if the model echoed one.
      let threadId = line.threadId && refs.has(line.threadId)
        ? refs.get(line.threadId)!.id
        : line.threadId
      if (line.newThreadName) {
        // Bar junk-drawer and container names — the guard `tooBroadReason`
        // applies to matcher patterns was never applied to thread names, which
        // is how "one-off" was born. A barred name resolves to nothing rather
        // than minting a dumping ground.
        const bad = isBadThreadName(line.newThreadName)
        if (bad) {
          result.problems.push(`rejected new thread for ${line.ref}: ${bad}`)
          attributeSegment(segment.id, { threadId: null, matcherId: null, confidence: line.confidence, state: 'resolved' }, db)
          recordModelLabel(segment.id, null, line.confidence)
          result.resolved++
          continue
        }
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
              : line.matcherField === 'url' ? 'contains'
              : 'exact',
            pattern: line.matcherPattern,
            threadId,
            confidence: line.confidence,
            example: segment.evidence,
            // Stamp the batch so a later rejection can find and drop this broad
            // matcher — model-resolved segments store matcher_id NULL, so the
            // batch provenance is the only path back to it.
            batchId,
          }, db)
        }
      }

      // `matcher_id` records what PRODUCED this attribution, and here that is
      // the model — not the matcher this call just wrote for *future* segments.
      // Attaching it would make every model-resolved segment look like a cache
      // hit, and `cacheHitRate` is the number the go/no-go turns on.
      void write
      attributeSegment(segment.id, { threadId, matcherId: null, confidence: line.confidence }, db)
      recordModelLabel(segment.id, threadId, line.confidence)
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

/**
 * The sweep's own hourly ceiling — the live path had none. `catchUp` looped up
 * to 200 rounds unbudgeted, which is how one hour of back-fill burned 81 calls.
 * A burst large enough to clear a day's backlog in a few hours, bounded so it
 * cannot run away. (Steady state is ~32 calls/*day*; this is the back-fill cap.)
 */
export const SWEEP_CALLS_PER_HOUR = 30

export function sweepBudgetRemaining(
  nowIso: string = new Date().toISOString(),
  db: Database.Database = getDb()
): number {
  const since = new Date(Date.parse(nowIso) - 3_600_000).toISOString()
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM desk_metrics WHERE kind = 'sweep' AND recorded_at >= ?"
  ).get(since) as { n: number }
  return Math.max(0, SWEEP_CALLS_PER_HOUR - row.n)
}

/** Instrumentation the Phase 2 go/no-go reads. Without it the trial is an impression. */
export function recordMetrics(
  kind: 'immediate' | 'sweep',
  result: InferenceResult,
  nowIso: string = new Date().toISOString(),
  db: Database.Database = getDb()
): void {
  db.prepare(`
    INSERT INTO desk_metrics (recorded_at, kind, calls, segments, resolved, failed, prompt_chars, latency_ms, ok, error)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nowIso, kind, result.segments, result.resolved, result.failed,
    result.promptChars, result.latencyMs, result.ok ? 1 : 0, result.error ?? null
  )
}
