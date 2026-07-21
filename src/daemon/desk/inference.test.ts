import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import {
  buildBriefs,
  buildPrompt,
  immediateBudgetRemaining,
  parseResponse,
  recordMetrics,
  runInferenceBatch,
  type InferenceResult,
} from './inference'
import { attributeSegment, createSegment, createThread, getSegment, listThreads } from './store'
import { confirmMatcher, findMatcher, listMatchers, recordRejection } from './matchers'
import type { DeskEvidence } from '../../shared/desk'

let testDir: string
const NOW = new Date('2026-07-20T12:00:00.000Z')

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-inf-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function segment(evidence: DeskEvidence, signature: string = randomUUID(), presence = 300) {
  const s = createSegment({
    blockId: null, startedAt: '2026-07-20T11:00:00.000Z', resourceSignature: signature, evidence,
  })
  getDb().prepare('UPDATE desk_segments SET presence_seconds = ? WHERE id = ?').run(presence, s.id)
  return getSegment(s.id)!
}

function seedCaptureText(segmentId: string, text: string) {
  const db = getDb()
  const sessionId = randomUUID()
  const captureId = randomUUID()
  const ts = '2026-07-20T11:30:00.000Z'
  db.prepare('INSERT INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, 0, ?)')
    .run(sessionId, ts, ts)
  db.prepare(`
    INSERT INTO sense_captures (id, session_id, captured_at, text_content, text_status, created_at)
    VALUES (?, ?, ?, ?, 'done', ?)
  `).run(captureId, sessionId, ts, text, ts)
  db.prepare('INSERT INTO desk_capture_links (segment_id, capture_id) VALUES (?, ?)').run(segmentId, captureId)
}

const run = (prompt: (p: string) => Promise<string>, over: Partial<Parameters<typeof runInferenceBatch>[0]> = {}) =>
  runInferenceBatch({ prompt: async p => prompt(p), now: () => NOW, ...over })

describe('buildPrompt', () => {
  it('sends metadata and text excerpts — never a screenshot or image path', () => {
    const s = segment({ appName: 'Studio', titles: ['Sync Dialog'], paths: ['~/dev/bond/src/sync.ts'] })
    seedCaptureText(s.id, 'conflict state copy is unwritten')
    const prompt = buildPrompt(buildBriefs([getSegment(s.id)!], getDb()), listThreads())

    expect(prompt).toContain('Sync Dialog')
    expect(prompt).toContain('conflict state copy')
    expect(prompt).not.toMatch(/\.jpg|\.png|image_path|base64/i)
  })

  it('redacts titles again at assembly, because existing Sense rows are raw', () => {
    const s = segment({ appName: 'Terminal', titles: ['export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'] })
    const prompt = buildPrompt(buildBriefs([getSegment(s.id)!], getDb()), [])
    expect(prompt).not.toContain('ghp_abcdefghijklmnop')
    expect(prompt).toContain('[REDACTED')
  })

  it('redacts the text excerpt again before transmission', () => {
    const s = segment({ appName: 'Terminal' })
    seedCaptureText(s.id, 'run with Bearer abc123def456ghi789jkl')
    const prompt = buildPrompt(buildBriefs([getSegment(s.id)!], getDb()), [])
    expect(prompt).not.toContain('abc123def456ghi789jkl')
  })

  it('classifies on metadata alone when a capture has no text', () => {
    const s = segment({ appName: 'Studio', titles: ['Sync Dialog'] })
    const briefs = buildBriefs([getSegment(s.id)!], getDb())
    expect(briefs[0].excerpt).toBeNull()
    expect(buildPrompt(briefs, [])).toContain('Sync Dialog')
  })

  it('offers existing threads as short refs, not uuids', () => {
    const t = createThread({ name: 'Studio sync dialog', source: 'user' })
    const s = segment({ appName: 'Studio' })
    const prompt = buildPrompt(buildBriefs([getSegment(s.id)!], getDb()), listThreads())

    expect(prompt).toContain('T1: Studio sync dialog')
    // a uuid is 36 chars of pure cost per label, and the easiest thing to hallucinate
    expect(prompt).not.toContain(t.id)
  })

  it('stays inside the prompt budget for a realistic full batch', () => {
    // A live back-fill sweep produced an 11,851-char prompt before the excerpt
    // and batch caps were tuned. This is the regression guard for that.
    const segments = Array.from({ length: 14 }, (_, i) => {
      const s = segment({
        appName: 'Studio',
        titles: [`Studio — Some Fairly Long Window Title ${i}`, `Alt title ${i}`],
        paths: [`~/Developer/Projects/bond/src/daemon/desk/file-${i}.ts`],
      }, `sig-${i}`)
      seedCaptureText(s.id, 'x'.repeat(2000))
      return getSegment(s.id)!
    })
    const threads = Array.from({ length: 24 }, (_, i) =>
      createThread({ name: `Thread number ${i}`, source: 'user' }))

    const prompt = buildPrompt(buildBriefs(segments, getDb()), threads)
    // ~1.5k tokens at the absolute ceiling: a full 14-segment batch, 24 thread
    // labels, two long titles and a path each, all with oversized text.
    expect(prompt.length).toBeLessThan(6800)
  })

  it('a typical batch is far smaller than the ceiling', () => {
    const segments = Array.from({ length: 6 }, (_, i) => {
      const s = segment({ appName: 'Studio', titles: [`Studio — Window ${i}`] }, `sig-${i}`)
      seedCaptureText(s.id, 'working on the sync dialog conflict state')
      return getSegment(s.id)!
    })
    const prompt = buildPrompt(buildBriefs(segments, getDb()), listThreads())
    expect(prompt.length).toBeLessThan(2500) // ~625 tokens
  })

  it('clips a long excerpt rather than paying for the whole capture', () => {
    const s = segment({ appName: 'Studio' })
    seedCaptureText(s.id, 'y'.repeat(5000))
    const brief = buildBriefs([getSegment(s.id)!], getDb())[0]
    expect(brief.excerpt!.length).toBeLessThanOrEqual(160)
  })
})

describe('parseResponse', () => {
  const refs = new Set(['S1', 'S2'])

  it('parses a well-formed batch', () => {
    const { lines, problems } = parseResponse(
      'S1|thread-a|0.9|title|Studio — Sync\nS2|NEW: ISP problem|0.6|none|-',
      refs
    )
    expect(problems).toEqual([])
    expect(lines[0]).toMatchObject({ ref: 'S1', threadId: 'thread-a', confidence: 0.9, matcherField: 'title' })
    expect(lines[1]).toMatchObject({ ref: 'S2', newThreadName: 'ISP problem', matcherField: null })
  })

  it('tolerates list markers and stray prose', () => {
    const { lines } = parseResponse(
      'Here you go:\n- S1|thread-a|0.9|none|-\n\n2. S2|thread-b|0.5|none|-',
      refs
    )
    expect(lines.map(l => l.ref)).toEqual(['S1', 'S2'])
  })

  it('drops a bad line with a reason instead of losing the batch', () => {
    const { lines, problems } = parseResponse(
      'S1|thread-a|0.9|none|-\nS2|thread-b|not-a-number|none|-\nS9|thread-c|0.5|none|-\nS1|thread-d|0.4|none|-',
      refs
    )
    expect(lines.map(l => l.ref)).toEqual(['S1'])
    expect(problems).toHaveLength(3)
    expect(problems.join(' ')).toMatch(/bad confidence/)
    expect(problems.join(' ')).toMatch(/unknown ref/)
    expect(problems.join(' ')).toMatch(/duplicate ref/)
  })

  it('rejects out-of-range confidence', () => {
    expect(parseResponse('S1|thread-a|1.4|none|-', refs).lines).toHaveLength(0)
    expect(parseResponse('S1|thread-a|-0.2|none|-', refs).lines).toHaveLength(0)
  })

  it('ignores an unknown matcher field rather than trusting it', () => {
    const { lines } = parseResponse('S1|thread-a|0.9|regex|.*|', refs)
    expect(lines[0].matcherField).toBeNull()
    expect(lines[0].matcherPattern).toBeNull()
  })

  it('rejects an empty new-thread name', () => {
    expect(parseResponse('S1|NEW:|0.9|none|-', refs).problems.join(' ')).toMatch(/empty new thread/)
  })

  it('returns nothing for empty or prose-only output', () => {
    expect(parseResponse('', refs).lines).toEqual([])
    expect(parseResponse('I could not determine the threads.', refs).lines).toEqual([])
  })
})

describe('runInferenceBatch', () => {
  it('never spends a model call on activity older than the horizon', async () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    const fresh = segment({ appName: 'Studio' }, 'sig-fresh')
    const stale = segment({ appName: 'Studio' }, 'sig-stale')
    getDb().prepare('UPDATE desk_segments SET started_at = ? WHERE id = ?')
      .run('2026-07-14T11:00:00.000Z', stale.id) // six days before NOW

    const result = await run(async () => `S1|${t.id}|0.9|none|-`)

    expect(result.segments).toBe(1)
    expect(getSegment(fresh.id)!.attributedThreadId).toBe(t.id)
    expect(getSegment(stale.id)!.attributionState).toBe('unresolved')
  })

  it('labels the newest work first when there is a queue', async () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    const older = segment({ appName: 'Older' }, 'sig-older')
    getDb().prepare('UPDATE desk_segments SET started_at = ? WHERE id = ?')
      .run('2026-07-20T06:00:00.000Z', older.id)
    const newer = segment({ appName: 'Newer' }, 'sig-newer')
    getDb().prepare('UPDATE desk_segments SET started_at = ? WHERE id = ?')
      .run('2026-07-20T11:50:00.000Z', newer.id)

    let seen = ''
    await run(async p => { seen = p; return `S1|${t.id}|0.9|none|-` }, { limit: 1 })
    expect(seen).toContain('Newer')
    expect(seen).not.toContain('Older')
  })

  it('does nothing when there is nothing unresolved', async () => {
    const prompt = vi.fn()
    const result = await run(async () => { prompt(); return '' })
    expect(result.segments).toBe(0)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('collapses every pending unknown into ONE request', async () => {
    segment({ appName: 'Studio', titles: ['Sync'] }, 'sig-1')
    segment({ appName: 'Chrome', titles: ['Docs'] }, 'sig-2')
    segment({ appName: 'Slack', titles: ['#design'] }, 'sig-3')

    const calls: string[] = []
    const t = createThread({ name: 'Studio sync', source: 'user' })
    const result = await run(async p => {
      calls.push(p)
      return `S1|${t.id}|0.9|none|-\nS2|${t.id}|0.7|none|-\nS3|${t.id}|0.6|none|-`
    })

    expect(calls).toHaveLength(1)
    expect(result.segments).toBe(3)
    expect(result.resolved).toBe(3)
  })

  it('writes an unconfirmed exact-resource matcher, never an automatic rule', async () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    segment({ appName: 'Studio' }, 'sig-1')
    await run(async () => `S1|${t.id}|1.0|none|-`)

    const matcher = findMatcher({ field: 'resource', operator: 'exact', pattern: 'sig-1' })!
    expect(matcher.confirmed).toBe(false)
    expect(matcher.source).toBe('inferred')
    expect(matcher.threadId).toBe(t.id)
  })

  it('a model-resolved segment records no matcher — it was not a cache hit', () => {
    // matcher_id is what PRODUCED the attribution. Attaching the matcher this
    // call wrote for future segments would make cacheHitRate read 100%.
    const t = createThread({ name: 'Studio sync', source: 'user' })
    const s = segment({ appName: 'Studio' }, 'sig-1')
    return run(async () => `S1|${t.id}|0.9|none|-`).then(() => {
      const after = getSegment(s.id)!
      expect(after.attributedThreadId).toBe(t.id)
      expect(after.matcherId).toBeNull()
    })
  })

  it('writes a title matcher as CONTAINS, so a project token mid-title matches', async () => {
    // A thread spans apps and the token lives inside the title:
    // "~/Developer/Projects/studio — nvim". Prefix could never find it.
    const t = createThread({ name: 'Studio', source: 'user' })
    segment({ appName: 'Ghostty' }, 'sig-1')
    await run(async () => `S1|${t.id}|0.9|title|studio`)

    const narrow = findMatcher({ field: 'title', operator: 'contains', pattern: 'studio' })!
    expect(narrow.threadId).toBe(t.id)
    expect(narrow.confirmed).toBe(false)
  })

  it('that matcher then resolves the same token across different apps', async () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    segment({ appName: 'Ghostty' }, 'sig-1')
    await run(async () => `S1|${t.id}|0.9|title|studio`)

    const { resolveMatcher } = await import('./matchers')
    // A terminal, a Figma file, and a GitHub page all carry the token.
    for (const title of ['~/Developer/Projects/studio — nvim', 'studio-figma-todo.md', 'automattic/studio · GitHub']) {
      expect(resolveMatcher({ signature: 'other', bundleId: null, titles: [title], paths: [] })?.threadId)
        .toBe(t.id)
    }
  })

  it('cannot mutate or demote a confirmed matcher', async () => {
    const mine = createThread({ name: 'Mine', source: 'user' })
    const other = createThread({ name: 'Other', source: 'user' })
    confirmMatcher({ field: 'resource', operator: 'exact', pattern: 'sig-1', threadId: mine.id })
    segment({ appName: 'Studio' }, 'sig-1')

    await run(async () => `S1|${other.id}|1.0|none|-`)

    const matcher = findMatcher({ field: 'resource', operator: 'exact', pattern: 'sig-1' })!
    expect(matcher.confirmed).toBe(true)
    expect(matcher.threadId).toBe(mine.id)
  })

  it('proposes at most one new thread across a whole batch', async () => {
    segment({ appName: 'A' }, 'sig-1')
    segment({ appName: 'B' }, 'sig-2')
    segment({ appName: 'C' }, 'sig-3')

    const result = await run(async () =>
      'S1|NEW: ISP problem|0.8|none|-\nS2|NEW: Something else|0.8|none|-\nS3|NEW: ISP problem|0.7|none|-')

    expect(result.threadsProposed).toBe(1)
    expect(listThreads()).toHaveLength(1)
    // The second, differently-named proposal is dropped; the third reuses the first
    expect(result.problems.join(' ')).toMatch(/extra new-thread proposal/)
    expect(result.resolved).toBe(2)
  })

  it('a proposed thread is provisional, never established', async () => {
    segment({ appName: 'A' }, 'sig-1')
    await run(async () => 'S1|NEW: ISP problem|0.95|none|-')
    expect(listThreads()[0].status).toBe('provisional')
    expect(listThreads()[0].source).toBe('inferred')
  })

  it('refuses to walk back a rejected pairing', async () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    recordRejection('sig-1', t.id, { at: NOW.toISOString(), dayEnd: '2026-07-20T23:59:59.999Z' })
    const s = segment({ appName: 'Studio' }, 'sig-1')

    const result = await run(async () => `S1|${t.id}|0.99|none|-`)

    expect(result.resolved).toBe(0)
    expect(result.problems.join(' ')).toMatch(/suppressed pairing/)
    expect(getSegment(s.id)!.attributedThreadId).toBeNull()
    expect(listMatchers()).toHaveLength(0)
  })

  it('rejects a hallucinated thread id', async () => {
    const s = segment({ appName: 'Studio' }, 'sig-1')
    const result = await run(async () => 'S1|thread-that-does-not-exist|0.9|none|-')
    expect(result.resolved).toBe(0)
    expect(result.failed).toBe(1)
    expect(getSegment(s.id)!.attributionState).toBe('failed')
  })

  it('a failed model call leaves every segment retryable without rewinding segmentation', async () => {
    const s = segment({ appName: 'Studio' }, 'sig-1')
    const result = await run(async () => { throw new Error('provider exploded') })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('provider exploded')
    const after = getSegment(s.id)!
    expect(after.attributionState).toBe('failed')
    expect(after.inferenceAttempts).toBe(1)
    expect(after.retryAt).not.toBeNull()
    expect(after.resourceSignature).toBe('sig-1') // segmentation untouched
  })

  it('a hung provider call fails the batch instead of stranding it on queued', async () => {
    const s = segment({ appName: 'Studio' }, 'sig-1')
    const result = await run(
      () => new Promise<string>(() => { /* never resolves */ }),
      { timeoutMs: 20 }
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('timed out')
    // failed, not queued — the sweep can see it again
    expect(getSegment(s.id)!.attributionState).toBe('failed')
    expect(getSegment(s.id)!.retryAt).not.toBeNull()
  })

  it('stops retrying after four attempts', async () => {
    const s = segment({ appName: 'Studio' }, 'sig-1')
    getDb().prepare('UPDATE desk_segments SET inference_attempts = 4 WHERE id = ?').run(s.id)
    await run(async () => { throw new Error('down') })
    expect(getSegment(s.id)!.retryAt).toBeNull()
  })

  it('marks a segment the model simply skipped as retryable', async () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    // Distinct timestamps so batch order is deterministic (newest first).
    const newer = segment({ appName: 'A' }, 'sig-1')
    getDb().prepare('UPDATE desk_segments SET started_at = ? WHERE id = ?')
      .run('2026-07-20T11:50:00.000Z', newer.id)
    const older = segment({ appName: 'B' }, 'sig-2')
    getDb().prepare('UPDATE desk_segments SET started_at = ? WHERE id = ?')
      .run('2026-07-20T11:10:00.000Z', older.id)

    // Only S1 (the newer one) is answered; the other must stay retryable.
    const result = await run(async () => `S1|${t.id}|0.9|none|-`)
    expect(result.resolved).toBe(1)
    expect(result.failed).toBe(1)
    expect(getSegment(newer.id)!.attributedThreadId).toBe(t.id)
    expect(getSegment(older.id)!.retryAt).not.toBeNull()
  })

  it('establishes a proposed thread after two high-confidence blocks', async () => {
    const t = createThread({ name: 'Studio sync', source: 'inferred' })
    getDb().prepare('INSERT INTO desk_blocks (id, thread_id, started_at, confidence, created_at, updated_at) VALUES (?, ?, ?, 0.9, ?, ?)')
      .run('b1', t.id, 'x', 'x', 'x')
    getDb().prepare('INSERT INTO desk_blocks (id, thread_id, started_at, confidence, created_at, updated_at) VALUES (?, ?, ?, 0.9, ?, ?)')
      .run('b2', t.id, 'x', 'x', 'x')
    segment({ appName: 'Studio' }, 'sig-1')

    await run(async () => `S1|${t.id}|0.9|none|-`)
    expect(listThreads()[0].status).toBe('established')
  })
})

describe('immediate-inference ceiling', () => {
  const failed: InferenceResult = {
    segments: 1, resolved: 0, failed: 1, threadsProposed: 0,
    promptChars: 100, latencyMs: 5, ok: false, problems: [],
  }

  it('starts at six calls per hour', () => {
    expect(immediateBudgetRemaining(NOW.toISOString())).toBe(6)
  })

  it('counts down and bottoms out at zero', () => {
    for (let i = 0; i < 8; i++) recordMetrics('immediate', failed, NOW.toISOString())
    expect(immediateBudgetRemaining(NOW.toISOString())).toBe(0)
  })

  it('sweeps do not consume the immediate budget', () => {
    for (let i = 0; i < 8; i++) recordMetrics('sweep', failed, NOW.toISOString())
    expect(immediateBudgetRemaining(NOW.toISOString())).toBe(6)
  })

  it('rolls forward as calls age past an hour', () => {
    recordMetrics('immediate', failed, '2026-07-20T10:00:00.000Z')
    recordMetrics('immediate', failed, '2026-07-20T11:59:00.000Z')
    expect(immediateBudgetRemaining(NOW.toISOString())).toBe(5)
  })
})
