import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import {
  commitSwitch,
  creditPresence,
  evaluateSwitch,
  ingestCaptures,
  openSegment,
  rollingWindow,
  selectEligibleCaptures,
  type SegmenterContext,
} from './segmenter'
import {
  attributeSegment,
  createBlock,
  createSegment,
  createThread,
  getBlockDetail,
  getRuntime,
  getSegment,
  setRuntime,
} from './store'
import { confirmMatcher, recordRejection, writeInferredMatcher } from './matchers'
import { resourceSignature } from './signature'

let testDir: string
const SESSION = 'session-1'

/** A fixed clock so every dwell assertion is exact. */
const T0 = Date.parse('2026-07-20T09:00:00.000Z')
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString()

function ctx(nowOffsetSeconds: number, over: Partial<SegmenterContext> = {}): SegmenterContext {
  return {
    now: () => new Date(T0 + nowOffsetSeconds * 1000),
    captureIntervalSeconds: 15,
    idleThresholdSeconds: 60,
    ...over,
  }
}

interface SeedOpts {
  id?: string
  offset: number
  app?: string
  bundle?: string
  title?: string
  imagePath?: string | null
  imagePurgedAt?: string | null
  text?: string | null
  textSource?: string
}

function seed(opts: SeedOpts): string {
  const db = getDb()
  const id = opts.id ?? randomUUID()
  const capturedAt = at(opts.offset)
  db.prepare(`
    INSERT INTO sense_captures (
      id, session_id, captured_at, app_name, app_bundle_id, window_title, text_content,
      text_status, text_source, image_path, image_purged_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?)
  `).run(
    id, SESSION, capturedAt,
    opts.app ?? 'Studio', opts.bundle ?? 'com.automattic.studio', opts.title ?? 'Studio — Sync Dialog',
    opts.text ?? null, opts.textSource ?? 'ocr',
    opts.imagePath === undefined ? '/tmp/shot.jpg' : opts.imagePath,
    opts.imagePurgedAt ?? null,
    capturedAt
  )
  return id
}

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-seg-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  const db = getDb()
  db.prepare('INSERT INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, 0, ?)')
    .run(SESSION, at(0), at(0))
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

describe('eligibility gate', () => {
  it('takes a capture that still has its image', () => {
    seed({ offset: 0 })
    expect(selectEligibleCaptures(getRuntime(), resolved(ctx(120)), 10)).toHaveLength(1)
  })

  it('takes a capture whose image was purged by AGE — text survives', () => {
    seed({ offset: 0, imagePath: null, imagePurgedAt: at(60) })
    expect(selectEligibleCaptures(getRuntime(), resolved(ctx(120)), 10)).toHaveLength(1)
  })

  it('takes a capture whose image was purged by the STORAGE CAP minutes after capture', () => {
    // enforceStorageCap purges oldest-first with no age filter at all.
    seed({ offset: 0, imagePath: null, imagePurgedAt: at(90) })
    expect(selectEligibleCaptures(getRuntime(), resolved(ctx(300)), 10)).toHaveLength(1)
  })

  it('skips a capture still awaiting its post-capture blacklist recheck', () => {
    // Inserted at trigger time, no image yet — controller may still DELETE it.
    seed({ offset: 0, imagePath: null, imagePurgedAt: null })
    expect(selectEligibleCaptures(getRuntime(), resolved(ctx(300)), 10)).toHaveLength(0)
  })

  it('holds a capture back until it clears the 10-second age floor', () => {
    seed({ offset: 0 })
    expect(selectEligibleCaptures(getRuntime(), resolved(ctx(5)), 10)).toHaveLength(0)
    expect(selectEligibleCaptures(getRuntime(), resolved(ctx(20)), 10)).toHaveLength(1)
  })

  it('never leapfrogs a capture that completed out of order', () => {
    // N+1 finishes first and is ingested; N lands afterwards with an EARLIER
    // captured_at. The age floor means N is still ahead of the checkpoint.
    const later = seed({ offset: 20, title: 'Later' })
    ingestCaptures(ctx(40))
    expect(getRuntime().processedCaptureId).toBe(later)

    const earlier = seed({ offset: 10, title: 'Earlier' })
    // Checkpoint is at offset 20, so the earlier row is behind it — the age
    // floor is what buys the time for it to arrive first.
    expect(selectEligibleCaptures(getRuntime(), resolved(ctx(60)), 10).map(r => r.id)).not.toContain(earlier)

    // The real protection: a capture is not read until it has aged out, by
    // which point an out-of-order sibling has landed too.
    setRuntime({ processedCaptureAt: null, processedCaptureId: null })
    const ids = selectEligibleCaptures(getRuntime(), resolved(ctx(60)), 10).map(r => r.id)
    expect(ids).toEqual([earlier, later])
  })

  it('a first run reaches back only as far as the horizon', () => {
    const recent = seed({ offset: -3600 })            // an hour ago
    seed({ offset: -30 * 3600 })                      // 30 hours ago — past the horizon
    seed({ offset: -7 * 24 * 3600 })                  // a week ago

    const ids = selectEligibleCaptures(getRuntime(), resolved(ctx(0)), 10).map(r => r.id)
    expect(ids).toEqual([recent])
  })

  it('once checkpointed, the horizon no longer applies', () => {
    // Otherwise a daemon that was down for two days would skip the gap forever.
    const old = seed({ offset: -30 * 3600 })
    setRuntime({ processedCaptureAt: at(-40 * 3600), processedCaptureId: 'x' })
    expect(selectEligibleCaptures(getRuntime(), resolved(ctx(0)), 10).map(r => r.id)).toContain(old)
  })

  it('breaks a captured_at tie by id so neither row is skipped', () => {
    const a = seed({ id: 'aaa', offset: 0 })
    const b = seed({ id: 'bbb', offset: 0 })
    const ids = selectEligibleCaptures(getRuntime(), resolved(ctx(60)), 10).map(r => r.id)
    expect(ids).toEqual([a, b])

    setRuntime({ processedCaptureAt: at(0), processedCaptureId: 'aaa' })
    expect(selectEligibleCaptures(getRuntime(), resolved(ctx(60)), 10).map(r => r.id)).toEqual(['bbb'])
  })
})

/** selectEligibleCaptures takes the resolved internal ctx; rebuild it here. */
function resolved(context: SegmenterContext) {
  const now = context.now!()
  return {
    db: getDb(),
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
    captureIntervalSeconds: context.captureIntervalSeconds ?? 15,
    idleThresholdSeconds: context.idleThresholdSeconds ?? 60,
  }
}

describe('creditPresence', () => {
  const opts = { captureIntervalSeconds: 15, idleThresholdSeconds: 60 }

  it('credits nothing for the first capture in a segment', () => {
    expect(creditPresence(null, opts)).toBe(0)
  })

  it('credits the actual gap when captures arrive on cadence', () => {
    expect(creditPresence(15, opts)).toBe(15)
  })

  it('caps a burst so six captures in ten seconds are not six intervals', () => {
    // clipboardCapture / app-switch bursts
    expect(creditPresence(1, opts)).toBe(1)
    expect(creditPresence(2, opts)).toBe(2)
  })

  it('caps a short stall at twice the capture interval', () => {
    expect(creditPresence(50, opts)).toBe(30)
  })

  it('credits nothing across the idle threshold', () => {
    expect(creditPresence(61, opts)).toBe(0)
    expect(creditPresence(3600, opts)).toBe(0)
  })

  it('scales with a user-configured capture interval rather than a hardcoded 15', () => {
    expect(creditPresence(50, { captureIntervalSeconds: 30, idleThresholdSeconds: 120 })).toBe(50)
    expect(creditPresence(90, { captureIntervalSeconds: 30, idleThresholdSeconds: 120 })).toBe(60)
  })
})

describe('ingestCaptures — segmentation', () => {
  it('opens one segment and folds same-resource captures into it', () => {
    seed({ offset: 0 })
    seed({ offset: 15 })
    seed({ offset: 30 })
    const result = ingestCaptures(ctx(60))

    expect(result.capturesProcessed).toBe(3)
    expect(result.segmentsOpened).toBe(1)
    expect(result.presenceSeconds).toBe(30)
    expect(openSegment(resolved(ctx(60)))!.presenceSeconds).toBe(30)
  })

  it('treats a volatile title change as the same resource', () => {
    seed({ offset: 0, title: 'Inbox (3) — Mail', bundle: 'com.apple.mail' })
    seed({ offset: 15, title: 'Inbox (9) — Mail', bundle: 'com.apple.mail' })
    expect(ingestCaptures(ctx(60)).segmentsOpened).toBe(1)
  })

  it('closes one segment and opens another when the resource changes', () => {
    seed({ offset: 0, title: 'Sync Dialog' })
    seed({ offset: 15, title: 'Settings' })
    const result = ingestCaptures(ctx(60))
    expect(result.segmentsOpened).toBe(2)

    const segments = getDb().prepare('SELECT * FROM desk_segments ORDER BY started_at').all() as { ended_at: string | null }[]
    expect(segments[0].ended_at).toBe(at(15))
    expect(segments[1].ended_at).toBeNull()
  })

  it('links every capture to its segment', () => {
    seed({ offset: 0 })
    seed({ offset: 15 })
    ingestCaptures(ctx(60))
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM desk_capture_links').get() as { n: number }
    expect(n.n).toBe(2)
  })

  it('advances the checkpoint only past captures it actually folded in', () => {
    seed({ id: 'c1', offset: 0 })
    seed({ id: 'c2', offset: 15 })
    ingestCaptures(ctx(60))
    expect(getRuntime().processedCaptureId).toBe('c2')

    // A second pass is a no-op, not a duplicate
    expect(ingestCaptures(ctx(60)).capturesProcessed).toBe(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM desk_segments').get()).toEqual({ n: 1 })
  })

  it('persists only redacted titles in segment evidence', () => {
    seed({ offset: 0, title: 'Terminal — ghp_abcdefghijklmnopqrstuvwxyz0123456789' })
    ingestCaptures(ctx(60))
    const evidence = openSegment(resolved(ctx(60)))!.evidence
    expect(JSON.stringify(evidence)).not.toContain('ghp_abcdefghijklmnop')
    expect(evidence.titles![0]).toContain('[REDACTED')
  })

  it('a 60-minute session gap ends the block; a coffee break does not', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const block = createBlock({ threadId: t.id, startedAt: at(0) })
    setRuntime({ currentBlockId: block.id })

    seed({ offset: 0 })
    seed({ offset: 300 })      // five-minute break — pauses presence only
    ingestCaptures(ctx(400))
    expect(getRuntime().currentBlockId).toBe(block.id)

    seed({ offset: 300 + 3700 }) // past the 60-minute session gap
    ingestCaptures(ctx(300 + 3800))
    expect(getRuntime().currentBlockId).toBeNull()
    expect(getBlockDetail(block.id)!.state).toBe('committed')
  })

  it('a coffee break credits no presence but keeps the segment open', () => {
    seed({ offset: 0 })
    seed({ offset: 300 })
    const result = ingestCaptures(ctx(400))
    expect(result.presenceSeconds).toBe(0)
    expect(result.segmentsOpened).toBe(1)
  })
})

describe('ingestCaptures — deterministic resolution', () => {
  it('resolves a known resource with no model call and credits the matcher', () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    const sig = resourceSignature({
      bundleId: 'com.automattic.studio', appName: 'Studio', title: 'Studio — Sync Dialog',
    })
    confirmMatcher({ field: 'resource', operator: 'exact', pattern: sig, threadId: t.id })

    seed({ offset: 0 })
    ingestCaptures(ctx(60))

    const seg = openSegment(resolved(ctx(60)))!
    expect(seg.attributedThreadId).toBe(t.id)
    expect(seg.attributionState).toBe('resolved')
    const matcher = getDb().prepare('SELECT hits, last_seen_at FROM desk_matchers').get() as { hits: number; last_seen_at: string }
    expect(matcher.hits).toBe(1)
    expect(matcher.last_seen_at).toBe(at(0))
  })

  it('leaves an unknown resource unresolved for the slow path', () => {
    seed({ offset: 0 })
    ingestCaptures(ctx(60))
    expect(openSegment(resolved(ctx(60)))!.attributionState).toBe('unresolved')
  })

  it('a suppressed pairing behaves as unmatched', () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    const sig = resourceSignature({
      bundleId: 'com.automattic.studio', appName: 'Studio', title: 'Studio — Sync Dialog',
    })
    writeInferredMatcher({ field: 'resource', operator: 'exact', pattern: sig, threadId: t.id, confidence: 0.9, example: {} })
    recordRejection(sig, t.id, { at: at(0), dayEnd: at(86_400) })

    seed({ offset: 0 })
    ingestCaptures(ctx(60))
    expect(openSegment(resolved(ctx(60)))!.attributedThreadId).toBeNull()
  })

  it('touches the thread it resolved to', () => {
    const t = createThread({ name: 'Studio sync', source: 'user' })
    const sig = resourceSignature({
      bundleId: 'com.automattic.studio', appName: 'Studio', title: 'Studio — Sync Dialog',
    })
    confirmMatcher({ field: 'resource', operator: 'exact', pattern: sig, threadId: t.id })
    seed({ offset: 0 })
    ingestCaptures(ctx(60))
    const row = getDb().prepare('SELECT last_seen_at FROM desk_threads WHERE id = ?').get(t.id) as { last_seen_at: string }
    expect(row.last_seen_at).toBe(at(0))
  })
})

describe('rollingWindow', () => {
  function segmentFor(threadId: string, startOffset: number, endOffset: number | null, presence: number) {
    const s = createSegment({ blockId: null, startedAt: at(startOffset), resourceSignature: randomUUID(), evidence: {} })
    attributeSegment(s.id, { threadId, confidence: 0.9 })
    getDb().prepare('UPDATE desk_segments SET presence_seconds = ?, ended_at = ? WHERE id = ?')
      .run(presence, endOffset === null ? null : at(endOffset), s.id)
    return s.id
  }

  it('smooths over time, not a count of observations', () => {
    const a = createThread({ name: 'A', source: 'user' })
    const b = createThread({ name: 'B', source: 'user' })
    // Six rapid B captures worth 6s total must not outweigh 150s of A.
    segmentFor(a.id, 0, null, 150)
    segmentFor(b.id, 10, 16, 6)

    const { leader } = rollingWindow(at(120), ctx(120))
    expect(leader!.threadId).toBe(a.id)
  })

  it('declares no leader when three threads are genuinely neck and neck', () => {
    // Observed live: Studio 27m / Bond 24m / Sense Work 20m. Nobody is leading.
    const a = createThread({ name: 'A', source: 'user' })
    const b = createThread({ name: 'B', source: 'user' })
    const c = createThread({ name: 'C', source: 'user' })
    segmentFor(a.id, 0, null, 1620)
    segmentFor(b.id, 0, null, 1440)
    segmentFor(c.id, 0, null, 1200)

    const result = rollingWindow(at(120), ctx(120))
    expect(result.leader).toBeNull()
    expect(result.shares[0].threadId).toBe(a.id)
  })

  it('declares a leader on a clear margin, without needing an absolute majority', () => {
    // The rule that a strict >50% test could never satisfy with 3 threads live.
    const a = createThread({ name: 'A', source: 'user' })
    const b = createThread({ name: 'B', source: 'user' })
    const c = createThread({ name: 'C', source: 'user' })
    segmentFor(a.id, 0, null, 600)   // 42% — a plurality, not a majority
    segmentFor(b.id, 0, null, 400)
    segmentFor(c.id, 0, null, 420)

    expect(rollingWindow(at(120), ctx(120)).leader?.threadId).toBe(a.id)
  })

  it('ignores a leader with too little absolute presence', () => {
    // A quiet window must not let ten seconds of anything declare a switch.
    const a = createThread({ name: 'A', source: 'user' })
    segmentFor(a.id, 0, null, 20)
    expect(rollingWindow(at(120), ctx(120)).leader).toBeNull()
  })

  it('a single thread with real presence leads outright', () => {
    const a = createThread({ name: 'A', source: 'user' })
    segmentFor(a.id, 0, null, 300)
    expect(rollingWindow(at(120), ctx(120)).leader?.threadId).toBe(a.id)
  })

  it('drops segments that ended before the window opened', () => {
    // The window is the working sphere (~11 min), not the noise floor.
    const a = createThread({ name: 'A', source: 'user' })
    segmentFor(a.id, 0, 30, 300)
    expect(rollingWindow(at(1200), ctx(1200)).total).toBe(0)
    // ...and is still counted while it is inside the window
    expect(rollingWindow(at(400), ctx(400)).total).toBe(300)
  })

  it('ignores unattributed segments entirely', () => {
    createSegment({ blockId: null, startedAt: at(0), resourceSignature: 'sig', evidence: {} })
    expect(rollingWindow(at(60), ctx(60)).total).toBe(0)
  })
})

describe('evaluateSwitch', () => {
  function leaderSegment(threadId: string, startOffset: number, presence: number) {
    const s = createSegment({ blockId: null, startedAt: at(startOffset), resourceSignature: randomUUID(), evidence: {} })
    attributeSegment(s.id, { threadId, confidence: 0.9 })
    getDb().prepare('UPDATE desk_segments SET presence_seconds = ? WHERE id = ?').run(presence, s.id)
    return s.id
  }

  it('says nothing in the first three minutes of a switch', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    leaderSegment(t.id, 0, 120)

    const first = evaluateSwitch(ctx(60))
    expect(first.kind).toBe('candidate')

    // 2m59s in — still not a switch
    expect(evaluateSwitch(ctx(179)).kind).toBe('candidate')
  })

  it('calls the switch once the dwell clears three minutes', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    leaderSegment(t.id, 0, 150)
    // First detection a beat after the segment opens (presence only exists once
    // time has elapsed inside the segment); dwell is measured from there.
    evaluateSwitch(ctx(10))
    const decision = evaluateSwitch(ctx(191))
    expect(decision).toMatchObject({ kind: 'switch', threadId: t.id })
  })

  it('a new leader restarts the dwell clock rather than inheriting it', () => {
    const a = createThread({ name: 'A', source: 'user' })
    const b = createThread({ name: 'B', source: 'user' })
    const segA = leaderSegment(a.id, 0, 200)
    evaluateSwitch(ctx(0))
    expect(evaluateSwitch(ctx(170)).kind).toBe('candidate')

    // A drops out, B takes over at t=170
    getDb().prepare('UPDATE desk_segments SET presence_seconds = 0 WHERE id = ?').run(segA)
    leaderSegment(b.id, 170, 200)
    expect(evaluateSwitch(ctx(175))).toMatchObject({ kind: 'candidate', threadId: b.id })
    expect(evaluateSwitch(ctx(200)).kind).toBe('candidate')  // only 30s in for B
    expect(evaluateSwitch(ctx(360))).toMatchObject({ kind: 'switch', threadId: b.id })
  })

  it('says nothing when the leader is already the current block’s thread', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const block = createBlock({ threadId: t.id, startedAt: at(0) })
    setRuntime({ currentBlockId: block.id })
    leaderSegment(t.id, 0, 300)
    expect(evaluateSwitch(ctx(600)).kind).toBe('none')
  })

  it('clears a stale candidate when the leader disappears', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const seg = leaderSegment(t.id, 0, 200)
    evaluateSwitch(ctx(60))
    expect(getRuntime().candidateThreadId).toBe(t.id)

    getDb().prepare('UPDATE desk_segments SET presence_seconds = 0 WHERE id = ?').run(seg)
    expect(evaluateSwitch(ctx(120)).kind).toBe('none')
    expect(getRuntime().candidateThreadId).toBeNull()
  })

  it('candidate presence survives a restart', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    leaderSegment(t.id, 0, 150)
    evaluateSwitch(ctx(60))

    closeDb()
    const rt = getRuntime()
    expect(rt.candidateThreadId).toBe(t.id)
    expect(rt.candidateSince).toBe(at(60))

    // Reconstructed from segment snapshots, the same decision follows
    expect(evaluateSwitch(ctx(250))).toMatchObject({ kind: 'switch', threadId: t.id })
  })
})

describe('commitSwitch', () => {
  it('closes the outgoing block and opens one for the new thread', () => {
    const a = createThread({ name: 'A', source: 'user' })
    const b = createThread({ name: 'B', source: 'user' })
    const first = createBlock({ threadId: a.id, startedAt: at(0) })
    setRuntime({ currentBlockId: first.id })

    const blockId = commitSwitch(b.id, { sinceIso: at(300) }, ctx(400))

    expect(getBlockDetail(first.id)!.endedAt).toBe(at(300))
    expect(getBlockDetail(first.id)!.state).toBe('committed')
    expect(getBlockDetail(blockId)!.threadId).toBe(b.id)
    expect(getRuntime().currentBlockId).toBe(blockId)
  })

  it('moves the segments that made the case onto the new block', () => {
    const a = createThread({ name: 'A', source: 'user' })
    const b = createThread({ name: 'B', source: 'user' })
    const first = createBlock({ threadId: a.id, startedAt: at(0) })
    setRuntime({ currentBlockId: first.id })

    const seg = createSegment({ blockId: first.id, startedAt: at(310), resourceSignature: 'sig', evidence: {} })
    attributeSegment(seg.id, { threadId: b.id, confidence: 0.9 })
    getDb().prepare('UPDATE desk_segments SET presence_seconds = 90 WHERE id = ?').run(seg.id)
    getDb().prepare('UPDATE desk_blocks SET presence_seconds = 90 WHERE id = ?').run(first.id)

    const blockId = commitSwitch(b.id, { sinceIso: at(300) }, ctx(420))

    expect(getSegment(seg.id)!.blockId).toBe(blockId)
    expect(getBlockDetail(blockId)!.presenceSeconds).toBe(90)
    expect(getBlockDetail(first.id)!.presenceSeconds).toBe(0)
  })

  it('clears the candidate and touches the thread', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    setRuntime({ candidateThreadId: t.id, candidateSince: at(0), candidatePresenceSeconds: 150 })
    commitSwitch(t.id, { sinceIso: at(200) }, ctx(300))

    const rt = getRuntime()
    expect(rt.candidateThreadId).toBeNull()
    expect(rt.candidatePresenceSeconds).toBe(0)
    const thread = getDb().prepare('SELECT last_seen_at FROM desk_threads WHERE id = ?').get(t.id) as { last_seen_at: string }
    expect(thread.last_seen_at).toBe(at(200))
  })

  it('works with no outgoing block — the first switch of the day', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const blockId = commitSwitch(t.id, { sinceIso: at(0) }, ctx(200))
    expect(getBlockDetail(blockId)!.threadId).toBe(t.id)
  })
})

describe('candidate resource population (Phase 3 — un-deads rejection)', () => {
  it('stamps the driving segment\'s signature and matcher onto the candidate', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const m = writeInferredMatcher({ field: 'resource', operator: 'exact', pattern: 'sig-driving', threadId: t.id, confidence: 0.9, example: {} })
    const s = createSegment({ blockId: null, startedAt: at(0), resourceSignature: 'sig-driving', evidence: {} })
    attributeSegment(s.id, { threadId: t.id, matcherId: m.matcher!.id, confidence: 0.9 })
    getDb().prepare('UPDATE desk_segments SET presence_seconds = ? WHERE id = ?').run(150, s.id)

    evaluateSwitch(ctx(60))
    const rt = getRuntime()
    expect(rt.candidateThreadId).toBe(t.id)
    // These columns existed since the schema was born but nothing ever wrote them.
    expect(rt.candidateResourceSignature).toBe('sig-driving')
    expect(rt.candidateMatcherId).toBe(m.matcher!.id)
  })
})
