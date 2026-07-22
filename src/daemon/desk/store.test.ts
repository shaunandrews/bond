import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import {
  addBlockPresence,
  addSegmentPresence,
  archiveThread,
  attributeSegment,
  clearCandidate,
  clearSegmentAttribution,
  closeSegment,
  countUnresolvedSegments,
  createBlock,
  createSegment,
  createThread,
  currentOpenBlockId,
  failBlockNote,
  findThreadByName,
  getBlock,
  getBlockDetail,
  getRuntime,
  getSegment,
  linkCapture,
  listBlocks,
  listBlocksAwaitingNote,
  listInFlight,
  listThreads,
  listUnresolvedSegments,
  markSegmentFailed,
  markSegmentsQueued,
  requeueStaleSegments,
  maybeEstablishThread,
  recentBlockText,
  renameThread,
  setRuntime,
  touchThread,
  updateBlock,
  updateSegmentEvidence,
} from './store'
import { migrateRepairDeskIntegrity, migrateResetDeskOnSignatureChange } from '../db'
import { confirmMatcher, listMatchers, writeInferredMatcher } from './matchers'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-store-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function seedCapture(opts: { id?: string; capturedAt?: string; text?: string } = {}): string {
  const db = getDb()
  const sessionId = randomUUID()
  const id = opts.id ?? randomUUID()
  const at = opts.capturedAt ?? new Date().toISOString()
  db.prepare('INSERT OR IGNORE INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, 0, ?)')
    .run(sessionId, at, at)
  db.prepare(`
    INSERT INTO sense_captures (id, session_id, captured_at, app_name, text_content, text_status, created_at)
    VALUES (?, ?, ?, 'Studio', ?, 'done', ?)
  `).run(id, sessionId, at, opts.text ?? 'some text', at)
  return id
}

describe('threads', () => {
  it('creates an inferred thread as provisional and a user thread as established', () => {
    expect(createThread({ name: 'Studio sync', source: 'inferred' }).status).toBe('provisional')
    expect(createThread({ name: 'ISP problem', source: 'user' }).status).toBe('established')
  })

  it('finds a thread by normalized name regardless of casing and spacing', () => {
    createThread({ name: 'Bond mobile composer', source: 'user' })
    expect(findThreadByName('  BOND   MOBILE composer ')?.name).toBe('Bond mobile composer')
  })

  it('renaming makes a provisional thread user-authored and established', () => {
    const t = createThread({ name: 'unknown work', source: 'inferred' })
    const renamed = renameThread(t.id, 'Studio sync dialog')!
    expect(renamed.name).toBe('Studio sync dialog')
    expect(renamed.source).toBe('user')
    expect(renamed.status).toBe('established')
  })

  it('ignores an empty rename', () => {
    const t = createThread({ name: 'Keep me', source: 'user' })
    expect(renameThread(t.id, '   ')?.name).toBe('Keep me')
  })

  it('archives and unarchives, and archived threads are hidden by default', () => {
    const t = createThread({ name: 'Old work', source: 'user' })
    archiveThread(t.id, true)
    expect(listThreads().map(x => x.id)).not.toContain(t.id)
    expect(listThreads({ includeArchived: true }).map(x => x.id)).toContain(t.id)
    expect(archiveThread(t.id, false)?.status).toBe('established')
  })

  it('establishes a provisional thread only after two high-confidence blocks', () => {
    const t = createThread({ name: 'Maybe', source: 'inferred' })
    createBlock({ threadId: t.id, confidence: 0.9 })
    maybeEstablishThread(t.id)
    expect(listThreads()[0].status).toBe('provisional')

    createBlock({ threadId: t.id, confidence: 0.9 })
    maybeEstablishThread(t.id)
    expect(listThreads().find(x => x.id === t.id)!.status).toBe('established')
  })

  it('does not establish on two low-confidence blocks', () => {
    const t = createThread({ name: 'Weak', source: 'inferred' })
    createBlock({ threadId: t.id, confidence: 0.2 })
    createBlock({ threadId: t.id, confidence: 0.3 })
    maybeEstablishThread(t.id)
    expect(listThreads().find(x => x.id === t.id)!.status).toBe('provisional')
  })

  it('touch updates last_seen_at', () => {
    const t = createThread({ name: 'Live', source: 'user' })
    touchThread(t.id, '2026-07-20T12:00:00.000Z')
    expect(listThreads().find(x => x.id === t.id)!.lastSeenAt).toBe('2026-07-20T12:00:00.000Z')
  })
})

describe('blocks', () => {
  it('sums presence rather than wall-clock span', () => {
    const b = createBlock({ startedAt: '2026-07-20T09:00:00.000Z' })
    addBlockPresence(b.id, 300)
    addBlockPresence(b.id, 200)
    addBlockPresence(b.id, -50) // ignored
    expect(getBlockDetail(b.id)!.presenceSeconds).toBe(500)
  })

  it('updates only the fields it is given', () => {
    const t = createThread({ name: 'X', source: 'user' })
    const b = createBlock({})
    updateBlock(b.id, { threadId: t.id, state: 'committed' })
    const after = getBlockDetail(b.id)!
    expect(after.threadId).toBe(t.id)
    expect(after.state).toBe('committed')
    expect(after.summary).toBeNull()
    expect(after.thread!.name).toBe('X')
  })

  it('lists blocks inside a date range, newest first', () => {
    createBlock({ startedAt: '2026-07-18T09:00:00.000Z' })
    createBlock({ startedAt: '2026-07-20T09:00:00.000Z' })
    createBlock({ startedAt: '2026-07-20T14:00:00.000Z' })
    const blocks = listBlocks({ from: '2026-07-20T00:00:00.000Z', to: '2026-07-20T23:59:59.999Z' })
    expect(blocks).toHaveLength(2)
    expect(blocks[0].startedAt).toBe('2026-07-20T14:00:00.000Z')
  })

  it('never surfaces a block below the noise floor in In flight', () => {
    const t = createThread({ name: 'Quick lookup', source: 'user' })
    const b = createBlock({ threadId: t.id })
    addBlockPresence(b.id, 60) // under 3 minutes
    expect(listInFlight()).toHaveLength(0)

    addBlockPresence(b.id, 200)
    expect(listInFlight()).toHaveLength(1)
  })

  it('shows one row per thread — the newest qualifying block', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const older = createBlock({ threadId: t.id, startedAt: '2026-07-20T09:00:00.000Z' })
    const newer = createBlock({ threadId: t.id, startedAt: '2026-07-20T15:00:00.000Z' })
    addBlockPresence(older.id, 600)
    addBlockPresence(newer.id, 600)
    const rows = listInFlight()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(newer.id)
  })

  it('excludes dismissed blocks from In flight', () => {
    const t = createThread({ name: 'Dismissed', source: 'user' })
    const b = createBlock({ threadId: t.id })
    addBlockPresence(b.id, 600)
    updateBlock(b.id, { state: 'dismissed' })
    expect(listInFlight()).toHaveLength(0)
  })
})

describe('segments', () => {
  it('round-trips evidence and tolerates garbage json', () => {
    const s = createSegment({
      blockId: null, startedAt: '2026-07-20T09:00:00.000Z',
      resourceSignature: 'sig', evidence: { appName: 'Studio', titles: ['Sync'] },
    })
    expect(getSegment(s.id)!.evidence.titles).toEqual(['Sync'])

    getDb().prepare('UPDATE desk_segments SET evidence_json = ? WHERE id = ?').run('{not json', s.id)
    expect(getSegment(s.id)!.evidence).toEqual({})
  })

  it('snapshots an attribution rather than joining to the matcher', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    const s = createSegment({ blockId: null, startedAt: '2026-07-20T09:00:00.000Z', resourceSignature: 'sig', evidence: {} })
    attributeSegment(s.id, { threadId: t.id, matcherId: null, confidence: 0.8 })
    const after = getSegment(s.id)!
    expect(after.attributedThreadId).toBe(t.id)
    expect(after.attributionState).toBe('resolved')
    expect(after.attributedAt).not.toBeNull()
  })

  it('clears attribution for exactly one resource/thread pairing', () => {
    const a = createThread({ name: 'A', source: 'user' })
    const b = createThread({ name: 'B', source: 'user' })
    const s1 = createSegment({ blockId: null, startedAt: 'x', resourceSignature: 'sig', evidence: {} })
    const s2 = createSegment({ blockId: null, startedAt: 'x', resourceSignature: 'sig', evidence: {} })
    const s3 = createSegment({ blockId: null, startedAt: 'x', resourceSignature: 'other', evidence: {} })
    attributeSegment(s1.id, { threadId: a.id })
    attributeSegment(s2.id, { threadId: b.id })
    attributeSegment(s3.id, { threadId: a.id })

    expect(clearSegmentAttribution({ signature: 'sig', threadId: a.id })).toBe(1)
    expect(getSegment(s1.id)!.attributedThreadId).toBeNull()
    expect(getSegment(s1.id)!.attributionState).toBe('unresolved')
    expect(getSegment(s2.id)!.attributedThreadId).toBe(b.id)
    expect(getSegment(s3.id)!.attributedThreadId).toBe(a.id)
  })

  it('lists unresolved and failed segments, respecting retry_at', () => {
    const soon = createSegment({ blockId: null, startedAt: 'a', resourceSignature: 's1', evidence: {} })
    const later = createSegment({ blockId: null, startedAt: 'b', resourceSignature: 's2', evidence: {} })
    markSegmentFailed(later.id, '2099-01-01T00:00:00.000Z')

    const ready = listUnresolvedSegments({ nowIso: '2026-07-20T10:00:00.000Z' })
    expect(ready.map(s => s.id)).toEqual([soon.id])
  })

  it('a queued segment is not re-selected', () => {
    const s = createSegment({ blockId: null, startedAt: 'a', resourceSignature: 's1', evidence: {} })
    markSegmentsQueued([s.id])
    expect(listUnresolvedSegments()).toHaveLength(0)
    expect(countUnresolvedSegments()).toBe(1)
  })

  it('requeues segments stranded on queued by a batch that never returned', () => {
    const stranded = createSegment({ blockId: null, startedAt: 'a', resourceSignature: 's1', evidence: {} })
    const resolved = createSegment({ blockId: null, startedAt: 'b', resourceSignature: 's2', evidence: {} })
    markSegmentsQueued([stranded.id])
    attributeSegment(resolved.id, { threadId: null, state: 'resolved' })

    expect(requeueStaleSegments()).toBe(1)
    expect(listUnresolvedSegments().map(s => s.id)).toEqual([stranded.id])
    // a resolved segment is never dragged back
    expect(getSegment(resolved.id)!.attributionState).toBe('resolved')
  })

  it('requeueing is a no-op when nothing is stranded', () => {
    expect(requeueStaleSegments()).toBe(0)
  })

  it('counts a failed inference attempt so backoff can bound it', () => {
    const s = createSegment({ blockId: null, startedAt: 'a', resourceSignature: 's1', evidence: {} })
    markSegmentFailed(s.id, null)
    markSegmentFailed(s.id, null)
    expect(getSegment(s.id)!.inferenceAttempts).toBe(2)
  })

  it('accumulates presence, closes once, and updates evidence', () => {
    const s = createSegment({ blockId: null, startedAt: 'a', resourceSignature: 's1', evidence: {} })
    addSegmentPresence(s.id, 15)
    addSegmentPresence(s.id, 15)
    updateSegmentEvidence(s.id, { titles: ['Sync Dialog'] })
    closeSegment(s.id, '2026-07-20T10:00:00.000Z')
    closeSegment(s.id, '2026-07-20T11:00:00.000Z') // no-op, already closed
    const after = getSegment(s.id)!
    expect(after.presenceSeconds).toBe(30)
    expect(after.endedAt).toBe('2026-07-20T10:00:00.000Z')
    expect(after.evidence.titles).toEqual(['Sync Dialog'])
  })
})

describe('capture links and recent text', () => {
  it('reads only the last 30 minutes of linked, redacted capture text', () => {
    const block = createBlock({})
    const seg = createSegment({ blockId: block.id, startedAt: 'a', resourceSignature: 's', evidence: {} })

    const fresh = seedCapture({ capturedAt: new Date(Date.now() - 5 * 60_000).toISOString(), text: 'fresh work' })
    const stale = seedCapture({ capturedAt: new Date(Date.now() - 90 * 60_000).toISOString(), text: 'ancient work' })
    linkCapture(seg.id, fresh)
    linkCapture(seg.id, stale)
    linkCapture(seg.id, fresh) // idempotent

    const texts = recentBlockText(block.id)
    expect(texts.map(t => t.text)).toEqual(['fresh work'])
  })

  it('cascades links away when the capture is deleted', () => {
    const seg = createSegment({ blockId: null, startedAt: 'a', resourceSignature: 's', evidence: {} })
    const captureId = seedCapture()
    linkCapture(seg.id, captureId)
    getDb().prepare('DELETE FROM sense_captures WHERE id = ?').run(captureId)
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM desk_capture_links').get() as { n: number }
    expect(n.n).toBe(0)
    // the segment itself survives — Desk's sweep uses Desk timestamps, not links
    expect(getSegment(seg.id)).not.toBeNull()
  })
})

describe('runtime singleton', () => {
  it('materializes defaults on first read', () => {
    const rt = getRuntime()
    expect(rt.running).toBe(false)
    expect(rt.candidatePresenceSeconds).toBe(0)
    expect(rt.processedCaptureId).toBeNull()
  })

  it('persists the candidate so a restart does not reset it', () => {
    const t = createThread({ name: 'Studio', source: 'user' })
    setRuntime({
      candidateThreadId: t.id,
      candidateResourceSignature: 'sig',
      candidateSince: '2026-07-20T10:00:00.000Z',
      candidatePresenceSeconds: 95,
      running: true,
    })
    closeDb()
    const rt = getRuntime()
    expect(rt.candidateThreadId).toBe(t.id)
    expect(rt.candidatePresenceSeconds).toBe(95)
    expect(rt.running).toBe(true)
  })

  it('persists the annoyance budget across a restart', () => {
    setRuntime({ lastAssertionAt: '2026-07-20T10:00:00.000Z' })
    closeDb()
    expect(getRuntime().lastAssertionAt).toBe('2026-07-20T10:00:00.000Z')
  })

  it('clearCandidate leaves the committed block and checkpoint alone', () => {
    const b = createBlock({})
    setRuntime({
      currentBlockId: b.id,
      processedCaptureId: 'c9',
      candidateThreadId: null,
      candidateResourceSignature: 'sig',
      candidatePresenceSeconds: 40,
    })
    clearCandidate()
    const rt = getRuntime()
    expect(rt.currentBlockId).toBe(b.id)
    expect(rt.processedCaptureId).toBe('c9')
    expect(rt.candidateResourceSignature).toBeNull()
    expect(rt.candidatePresenceSeconds).toBe(0)
  })

  it('an empty patch is a no-op', () => {
    setRuntime({ candidatePresenceSeconds: 7 })
    setRuntime({})
    expect(getRuntime().candidatePresenceSeconds).toBe(7)
  })
})

describe('Phase 0 integrity guards', () => {
  it('updateBlock clamps ended_at that precedes started_at', () => {
    const t = createThread({ name: 'A', source: 'user' })
    const b = createBlock({ threadId: t.id, startedAt: '2026-07-20T13:23:14.000Z' })
    // The Ask double-commit once dated a block's end 438s before its own start.
    updateBlock(b.id, { endedAt: '2026-07-20T13:15:56.000Z', state: 'committed' })
    const after = getBlock(b.id)!
    expect(Date.parse(after.endedAt!)).toBeGreaterThanOrEqual(Date.parse(after.startedAt))
    expect(after.endedAt).toBe(after.startedAt)
  })

  it('addBlockPresence refuses credit to a closed block', () => {
    const t = createThread({ name: 'A', source: 'user' })
    const b = createBlock({ threadId: t.id, startedAt: '2026-07-20T10:00:00.000Z' })
    addBlockPresence(b.id, 60)
    updateBlock(b.id, { endedAt: '2026-07-20T10:05:00.000Z', state: 'committed' })
    addBlockPresence(b.id, 999) // a late, out-of-order capture
    expect(getBlock(b.id)!.presenceSeconds).toBe(60)
  })

  it('currentOpenBlockId returns an open block and clears a stale pointer', () => {
    const t = createThread({ name: 'A', source: 'user' })
    const b = createBlock({ threadId: t.id, startedAt: '2026-07-20T10:00:00.000Z' })
    setRuntime({ currentBlockId: b.id })
    expect(currentOpenBlockId()).toBe(b.id)
    updateBlock(b.id, { endedAt: '2026-07-20T10:05:00.000Z', state: 'committed' })
    expect(currentOpenBlockId()).toBeNull()
    expect(getRuntime().currentBlockId).toBeNull()
  })
})

describe('re-entry note failure lifecycle', () => {
  function departedBlock(): string {
    const t = createThread({ name: 'A', source: 'user' })
    const b = createBlock({ threadId: t.id, startedAt: '2026-07-20T10:00:00.000Z' })
    updateBlock(b.id, { endedAt: '2026-07-20T10:20:00.000Z', presenceSeconds: 600, state: 'committed' })
    return b.id
  }

  it('a transient note failure stays retryable; a due retry is re-listed', () => {
    const id = departedBlock()
    const now = '2026-07-20T11:00:00.000Z'
    failBlockNote(id, { transient: true, retryMinutes: [10], now })
    expect(getBlock(id)!.noteStatus).toBe('failed')
    // Not yet due — nothing to do.
    expect(listBlocksAwaitingNote({ now: '2026-07-20T11:05:00.000Z' }).some(b => b.id === id)).toBe(false)
    // Past the backoff — a transient failure is re-listed, not lost forever.
    expect(listBlocksAwaitingNote({ now: '2026-07-20T11:20:00.000Z' }).some(b => b.id === id)).toBe(true)
  })

  it('a permanent note failure is terminal', () => {
    const id = departedBlock()
    failBlockNote(id, { transient: false, now: '2026-07-20T11:00:00.000Z' })
    expect(listBlocksAwaitingNote({ now: '2026-07-21T11:00:00.000Z' }).some(b => b.id === id)).toBe(false)
  })

  it('a user edit always wins over a concurrent failure stamp', () => {
    const id = departedBlock()
    updateBlock(id, { reentryNote: 'my own note', noteStatus: 'edited' })
    failBlockNote(id, { transient: true, now: '2026-07-20T11:00:00.000Z' })
    expect(getBlock(id)!.noteStatus).toBe('edited')
    expect(getBlock(id)!.reentryNote).toBe('my own note')
  })

  it('retries stop after the attempt cap', () => {
    const id = departedBlock()
    for (let i = 0; i < 5; i++) failBlockNote(id, { transient: true, maxAttempts: 3, now: '2026-07-20T11:00:00.000Z' })
    // Beyond the cap the retry gate is cleared — no longer re-listed.
    expect(listBlocksAwaitingNote({ now: '2026-07-25T11:00:00.000Z' }).some(b => b.id === id)).toBe(false)
  })
})

describe('migrateRepairDeskIntegrity', () => {
  it('sweeps orphan capture links and clamps negative-duration blocks', () => {
    const db = getDb()
    const t = createThread({ name: 'A', source: 'user' })
    const seg = createSegment({ blockId: null, startedAt: '2026-07-20T10:00:00.000Z', resourceSignature: 's', evidence: {} })
    const liveCapture = seedCapture()
    linkCapture(seg.id, liveCapture) // a valid link that must survive

    // Simulate the FK-off era: SQLite never retro-validates, so these orphans
    // stood on disk. Insert them with the constraint disabled to reproduce it.
    db.pragma('foreign_keys = OFF')
    db.prepare('INSERT INTO desk_capture_links (segment_id, capture_id) VALUES (?, ?)').run('ghost-seg', liveCapture)
    db.prepare('INSERT INTO desk_capture_links (segment_id, capture_id) VALUES (?, ?)').run(seg.id, 'ghost-capture')
    db.pragma('foreign_keys = ON')

    // A negative-duration block from the double-commit.
    const b = createBlock({ threadId: t.id, startedAt: '2026-07-20T13:23:14.000Z' })
    db.prepare('UPDATE desk_blocks SET ended_at = ? WHERE id = ?').run('2026-07-20T13:15:56.000Z', b.id)

    migrateRepairDeskIntegrity(db)

    // Both orphan classes are gone; the valid link survives.
    expect((db.prepare("SELECT COUNT(*) AS n FROM desk_capture_links WHERE segment_id = 'ghost-seg'").get() as { n: number }).n).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS n FROM desk_capture_links WHERE capture_id = 'ghost-capture'").get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM desk_capture_links WHERE segment_id = ?').get(seg.id) as { n: number }).n).toBe(1)
    // The negative-duration block is clamped.
    const after = getBlock(b.id)!
    expect(Date.parse(after.endedAt!)).toBeGreaterThanOrEqual(Date.parse(after.startedAt))
  })
})

describe('migrateResetDeskOnSignatureChange (the one-time signature break)', () => {
  it('sweeps inferred attribution but preserves the user\'s confirmed rules', () => {
    const db = getDb()
    // The boot flow already stamped signature_version = 2 on this fresh db;
    // wind it back to simulate a database written under the old algorithm.
    db.prepare('UPDATE desk_runtime SET signature_version = 1 WHERE singleton = 1').run()

    const kept = createThread({ name: 'Studio', source: 'user' })
    const junk = createThread({ name: 'one-off', source: 'inferred' })
    confirmMatcher({ field: 'title', operator: 'contains', pattern: 'studio', threadId: kept.id })
    writeInferredMatcher({ field: 'resource', operator: 'exact', pattern: 'oldsig', threadId: junk.id, confidence: 0.6, example: {} })

    migrateResetDeskOnSignatureChange(db)

    const matchers = listMatchers({ confirmedOnly: false })
    // The confirmed rule survives; the inferred one is swept.
    expect(matchers).toHaveLength(1)
    expect(matchers[0].confirmed).toBe(true)
    // The orphan inferred thread with no confirmed matcher is gone; the real one stays.
    const threads = listThreads().map(t => t.id)
    expect(threads).toContain(kept.id)
    expect(threads).not.toContain(junk.id)
    // And the version is stamped so it never runs again.
    const v = db.prepare('SELECT signature_version AS v FROM desk_runtime WHERE singleton = 1').get() as { v: number }
    expect(v.v).toBe(2)
  })
})
