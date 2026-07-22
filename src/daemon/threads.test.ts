import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { closeDb, getDb } from './db'
import { ensureTranscriptSchema, insertTurnStart, upsertMessages } from './transcript'
import {
  buildThreadContextEnvelope,
  buildThreadContextSnapshot,
  closeThread,
  createThread,
  deleteDraftThread,
  getThread,
  getThreadForAnchor,
  listRecentThreads,
  markThreadRead,
  threadHasPriorTurns,
  touchThread,
} from './threads'

let testDir: string

/** One turn: a user message and its final Bond reply, both real transcript rows. */
function makeTurn(n: number, userText: string, bondText: string) {
  const turnId = `turn-${n}`
  const userMessageId = `u${n}`
  const assistantMessageId = `b${n}`
  const activityMessageId = `a${n}`
  insertTurnStart({
    turnId,
    userMessageId,
    assistantMessageId,
    activityMessageId,
    text: userText,
    now: new Date(2026, 0, 1, 0, n).toISOString(),
  })
  upsertMessages([{ id: assistantMessageId, role: 'bond', turnId, text: bondText }])
  return { turnId, userMessageId, assistantMessageId, activityMessageId }
}

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-threads-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  ensureTranscriptSchema()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('buildThreadContextSnapshot', () => {
  it('includes the anchor and its directly-prompting user message', () => {
    const { assistantMessageId } = makeTurn(1, 'what is bond?', 'bond is a chat app')
    const snapshot = buildThreadContextSnapshot(assistantMessageId)

    expect(snapshot.anchorMessageId).toBe(assistantMessageId)
    expect(snapshot.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'what is bond?' }),
      expect.objectContaining({ role: 'bond', text: 'bond is a chat app' }),
    ])
  })

  it('walks backward through up to two preceding exchanges, oldest first', () => {
    makeTurn(1, 'first question', 'first answer')
    makeTurn(2, 'second question', 'second answer')
    const { assistantMessageId } = makeTurn(3, 'third question', 'third answer')

    const snapshot = buildThreadContextSnapshot(assistantMessageId)
    expect(snapshot.messages.map(m => m.text)).toEqual([
      'first question', 'first answer',
      'second question', 'second answer',
      'third question', 'third answer',
    ])
  })

  it('never includes a fourth preceding exchange', () => {
    makeTurn(1, 'q1', 'a1')
    makeTurn(2, 'q2', 'a2')
    makeTurn(3, 'q3', 'a3')
    const { assistantMessageId } = makeTurn(4, 'q4', 'a4')

    const snapshot = buildThreadContextSnapshot(assistantMessageId)
    expect(snapshot.messages.map(m => m.text)).toEqual(['q2', 'a2', 'q3', 'a3', 'q4', 'a4'])
  })

  it('excludes messages after the anchor', () => {
    const { assistantMessageId } = makeTurn(1, 'first question', 'first answer')
    makeTurn(2, 'second question', 'second answer')

    const snapshot = buildThreadContextSnapshot(assistantMessageId)
    expect(snapshot.messages.map(m => m.text)).toEqual(['first question', 'first answer'])
  })

  it('trims the OLDEST exchange first when the token budget is exceeded, never the anchor', () => {
    const huge = 'x'.repeat(32_000) // ~8000 estimated tokens — consumes the whole budget by itself
    makeTurn(1, 'small old question', 'small old answer')
    const { assistantMessageId } = makeTurn(2, 'the real question', huge)

    const snapshot = buildThreadContextSnapshot(assistantMessageId)
    // The anchor (huge) and its prompting message always survive; the older,
    // smaller exchange is the one trimmed for budget even though it's tiny —
    // "trim oldest first" is not "trim whichever is bigger".
    expect(snapshot.messages.map(m => m.text)).toEqual(['the real question', huge])
  })

  it('rejects an anchor that is not a Bond message', () => {
    const { userMessageId } = makeTurn(1, 'hello', 'hi')
    expect(() => buildThreadContextSnapshot(userMessageId)).toThrow(/not a Bond response/)
  })

  it('rejects a nonexistent anchor', () => {
    expect(() => buildThreadContextSnapshot('does-not-exist')).toThrow(/does not exist/)
  })
})

describe('thread CRUD', () => {
  it('creates a draft thread with a real snapshot, idempotent by anchor', () => {
    const { assistantMessageId } = makeTurn(1, 'hi', 'hello there')
    const first = createThread(assistantMessageId)
    expect(first.status).toBe('draft')
    expect(first.anchorMessageId).toBe(assistantMessageId)
    expect(first.replyCount).toBe(0)
    expect(first.contextSnapshot.messages.length).toBeGreaterThan(0)

    const second = createThread(assistantMessageId)
    expect(second.id).toBe(first.id)
  })

  it('finds a thread by its anchor', () => {
    const { assistantMessageId } = makeTurn(1, 'hi', 'hello there')
    const created = createThread(assistantMessageId)
    expect(getThreadForAnchor(assistantMessageId)?.id).toBe(created.id)
    expect(getThreadForAnchor('nope')).toBeNull()
  })

  it('touch flips a draft to open and bumps updated_at', () => {
    const { assistantMessageId } = makeTurn(1, 'hi', 'hello there')
    const created = createThread(assistantMessageId)
    expect(created.status).toBe('draft')

    touchThread(created.id, '2026-02-01T00:00:00.000Z')
    const after = getThread(created.id)
    expect(after?.status).toBe('open')
    expect(after?.updatedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('markThreadRead sets lastReadAt without changing status', () => {
    const { assistantMessageId } = makeTurn(1, 'hi', 'hello there')
    const created = createThread(assistantMessageId)
    markThreadRead(created.id, '2026-02-01T00:00:00.000Z')
    const after = getThread(created.id)
    expect(after?.lastReadAt).toBe('2026-02-01T00:00:00.000Z')
    expect(after?.status).toBe('draft')
  })

  it('replyCount counts turns, not raw messages — activity/tool rows never inflate it', () => {
    const { assistantMessageId } = makeTurn(1, 'hi', 'hello there')
    const thread = createThread(assistantMessageId)

    const db = getDb()
    db.prepare('INSERT INTO turns (id, thread_id, user_message_id, assistant_message_id, activity_message_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('thread-turn-1', thread.id, 'tu1', 'tb1', 'ta1', 'done', '2026-01-01T00:01:00.000Z')

    expect(getThread(thread.id)?.replyCount).toBe(1)
  })

  it('deleteDraftThread removes a draft but refuses a non-draft thread', () => {
    const { assistantMessageId } = makeTurn(1, 'hi', 'hello there')
    const thread = createThread(assistantMessageId)
    touchThread(thread.id) // draft -> open

    expect(deleteDraftThread(thread.id)).toBe(false)
    expect(getThread(thread.id)).not.toBeNull()

    closeThread(thread.id)
    expect(getThread(thread.id)?.status).toBe('closed')
  })

  it('deletes a genuine draft (opened and closed without ever sending)', () => {
    const { assistantMessageId } = makeTurn(1, 'hi', 'hello there')
    const thread = createThread(assistantMessageId)
    expect(deleteDraftThread(thread.id)).toBe(true)
    expect(getThread(thread.id)).toBeNull()
  })

  it('listRecentThreads excludes drafts and orders by updated_at desc', () => {
    const t1 = makeTurn(1, 'q1', 'a1')
    const t2 = makeTurn(2, 'q2', 'a2')
    const threadA = createThread(t1.assistantMessageId)
    const threadB = createThread(t2.assistantMessageId)

    touchThread(threadA.id, '2026-01-01T00:00:00.000Z')
    touchThread(threadB.id, '2026-01-02T00:00:00.000Z')

    const recent = listRecentThreads()
    expect(recent.map(t => t.id)).toEqual([threadB.id, threadA.id])
  })

  it('deleting the anchor message cascades to the thread (ON DELETE CASCADE)', () => {
    const { assistantMessageId } = makeTurn(1, 'hi', 'hello there')
    const thread = createThread(assistantMessageId)
    getDb().prepare('DELETE FROM messages WHERE id = ?').run(assistantMessageId)
    expect(getThread(thread.id)).toBeNull()
  })

  it('threadHasPriorTurns is false until a real turn is recorded for that thread', () => {
    const { assistantMessageId } = makeTurn(1, 'hi', 'hello there')
    const thread = createThread(assistantMessageId)
    expect(threadHasPriorTurns(thread.id)).toBe(false)

    getDb().prepare('INSERT INTO turns (id, thread_id, user_message_id, assistant_message_id, activity_message_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('thread-turn-1', thread.id, 'tu1', 'tb1', 'ta1', 'done', '2026-01-01T00:01:00.000Z')
    expect(threadHasPriorTurns(thread.id)).toBe(true)
  })
})

describe('buildThreadContextEnvelope', () => {
  it('wraps the snapshot messages in the documented bond-thread-context template', () => {
    const { assistantMessageId } = makeTurn(1, 'what is bond?', 'bond is a chat app')
    const snapshot = buildThreadContextSnapshot(assistantMessageId)
    const envelope = buildThreadContextEnvelope(snapshot)

    expect(envelope).toContain('<bond-thread-context>')
    expect(envelope).toContain('This is a side conversation anchored to a response in Bond\'s main conversation.')
    expect(envelope).toContain('<message role="user">')
    expect(envelope).toContain('what is bond?')
    expect(envelope).toContain('<message role="bond">')
    expect(envelope).toContain('bond is a chat app')
    expect(envelope.trim().endsWith('</bond-thread-context>')).toBe(true)
  })

  it('escapes historical text so it cannot be mistaken for live markup', () => {
    const { assistantMessageId } = makeTurn(1, '<script>alert(1)</script>', 'safe reply')
    const snapshot = buildThreadContextSnapshot(assistantMessageId)
    const envelope = buildThreadContextEnvelope(snapshot)

    expect(envelope).not.toContain('<script>')
    expect(envelope).toContain('&lt;script&gt;')
  })

  it('tolerates a malformed/empty snapshot rather than throwing', () => {
    expect(() => buildThreadContextEnvelope({ version: 1, createdAt: '', anchorMessageId: '', anchorSeq: 0, messages: undefined as any })).not.toThrow()
  })
})
