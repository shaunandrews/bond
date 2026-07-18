import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import {
  completeTurn,
  ensureTranscriptSchema,
  getMessagesForRange,
  getSourceMessages,
  insertTurnStart,
  listMessages,
  searchMessages,
  upsertMessages,
} from './transcript'

let testDir: string

function seedEpoch(id = 'epoch-1') {
  getDb().prepare(`
    INSERT INTO epochs (id, pi_session_id, status, started_at)
    VALUES (?, ?, 'active', ?)
  `).run(id, `pi-${id}`, new Date().toISOString())
}

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-transcript-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  ensureTranscriptSchema()
  seedEpoch()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('transcript store', () => {
  it('transactionally inserts a turn, user message, and activity message', () => {
    insertTurnStart({
      epochId: 'epoch-1',
      turnId: 'turn-1',
      userMessageId: 'user-1',
      assistantMessageId: 'bond-1',
      activityMessageId: 'activity-1',
      text: 'hello transcript',
      model: 'balanced',
      imageIds: ['img-1'],
      activityData: { turnId: 'turn-1', status: 'working', startedAt: 1, events: [] },
    })

    const turn = getDb().prepare('SELECT * FROM turns WHERE id = ?').get('turn-1') as Record<string, unknown>
    expect(turn.status).toBe('running')
    expect(turn.assistant_message_id).toBe('bond-1')

    const page = listMessages()
    expect(page.messages.map(m => [m.id, m.seq, m.role, m.kind])).toEqual([
      ['user-1', 1, 'user', null],
      ['activity-1', 2, 'meta', 'activity'],
    ])
    expect(page.messages[0].imageIds).toEqual(['img-1'])
  })

  it('upserts supplied messages without deleting absent rows', () => {
    insertTurnStart({
      epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'bond-1', activityMessageId: 'activity-1', text: 'original user',
    })

    upsertMessages([
      { id: 'bond-1', epochId: 'epoch-1', turnId: 'turn-1', role: 'bond', text: 'first answer' },
      { id: 'user-1', epochId: 'epoch-1', turnId: 'turn-1', role: 'user', text: 'edited user' },
    ])

    const messages = listMessages().messages
    expect(messages.map(m => m.id)).toEqual(['user-1', 'activity-1', 'bond-1'])
    expect(messages.find(m => m.id === 'user-1')?.text).toBe('edited user')
    expect(messages.find(m => m.id === 'activity-1')).toBeTruthy()
    expect(messages.find(m => m.id === 'bond-1')?.seq).toBe(3)
  })

  it('completes turns and records context usage on the epoch', () => {
    insertTurnStart({
      epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'bond-1', activityMessageId: 'activity-1', text: 'hi',
    })
    completeTurn({ turnId: 'turn-1', status: 'done', contextTokens: 1234, contextWindow: 200000, completedAt: '2026-01-01T00:00:00.000Z' })

    const turn = getDb().prepare('SELECT status, completed_at, context_tokens, context_window FROM turns WHERE id = ?').get('turn-1') as Record<string, unknown>
    expect(turn).toMatchObject({ status: 'done', completed_at: '2026-01-01T00:00:00.000Z', context_tokens: 1234, context_window: 200000 })
    const epoch = getDb().prepare('SELECT context_tokens, context_window FROM epochs WHERE id = ?').get('epoch-1') as Record<string, unknown>
    expect(epoch).toMatchObject({ context_tokens: 1234, context_window: 200000 })
  })

  it('paginates newest pages but returns each page oldest-to-newest', () => {
    insertTurnStart({ epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'one' })
    upsertMessages([
      { id: 'b1', role: 'bond', epochId: 'epoch-1', turnId: 'turn-1', text: 'two' },
      { id: 'u2', role: 'user', epochId: 'epoch-1', text: 'three' },
      { id: 'b2', role: 'bond', epochId: 'epoch-1', text: 'four' },
    ])

    const first = listMessages({ limit: 2 })
    expect(first.messages.map(m => m.text)).toEqual(['three', 'four'])
    expect(first.nextBeforeSeq).toBe(4)

    const second = listMessages({ beforeSeq: first.nextBeforeSeq!, limit: 2 })
    expect(second.messages.map(m => m.id)).toEqual(['a1', 'b1'])
    expect(second.nextBeforeSeq).toBe(2)
  })

  it('returns observer ranges and exact source messages', () => {
    insertTurnStart({ epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'alpha' })
    upsertMessages([{ id: 'b1', role: 'bond', epochId: 'epoch-1', turnId: 'turn-1', text: 'omega' }])

    expect(getMessagesForRange(2, 3).map(m => m.id)).toEqual(['a1', 'b1'])
    expect(getSourceMessages(['b1', 'u1']).map(m => m.id)).toEqual(['u1', 'b1'])
  })

  it('updates FTS for text and removes stale indexed text on update', () => {
    insertTurnStart({ epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'findable aardvark' })
    expect(searchMessages('aardvark').map(m => m.id)).toEqual(['u1'])

    upsertMessages([{ id: 'u1', role: 'user', epochId: 'epoch-1', turnId: 'turn-1', text: 'plain zebra' }])
    expect(searchMessages('aardvark')).toEqual([])
    expect(searchMessages('zebra').map(m => m.id)).toEqual(['u1'])
  })

  it('indexes compact activity tool labels and capped outputs, not raw payloads', () => {
    const veryLong = `${'x'.repeat(4_000)} secret-after-cap`
    insertTurnStart({
      epochId: 'epoch-1',
      turnId: 'turn-1',
      userMessageId: 'u1',
      assistantMessageId: 'b1',
      activityMessageId: 'a1',
      text: 'run tool',
      activityData: {
        turnId: 'turn-1', status: 'working', startedAt: 1,
        events: [{ id: 'e1', type: 'tool', label: 'Read project file', ts: 1, toolName: 'read', input: { payload: 'do-not-index-me' }, output: veryLong }],
      },
    })

    expect(searchMessages('project file').map(m => m.id)).toEqual(['a1'])
    expect(searchMessages('do-not-index-me')).toEqual([])
    expect(searchMessages('secret-after-cap')).toEqual([])
  })
})
