import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import {
  completeTurn,
  ensureTranscriptSchema,
  getMessagesForRange,
  getSourceMessages,
  insertTurnStart,
  listMessages,
  reconcileInterruptedTurns,
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
  it('transactionally inserts a turn, user message, activity message, and stable assistant placeholder', () => {
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
      ['bond-1', 3, 'bond', null],
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

describe('turn reconciliation', () => {
  function seedRunningTurn(turnId: string, activityData: Record<string, unknown>) {
    insertTurnStart({
      epochId: 'epoch-1',
      turnId,
      userMessageId: `user-${turnId}`,
      assistantMessageId: `bond-${turnId}`,
      activityMessageId: `activity-${turnId}`,
      text: 'hello',
      activityData: activityData as never,
    })
  }

  function activityData(turnId: string): Record<string, unknown> {
    const raw = getDb().prepare('SELECT data FROM messages WHERE id = ?').get(`activity-${turnId}`) as { data: string }
    return JSON.parse(raw.data)
  }

  it('completeTurn finalizes a live activity row and cancels its pending approvals', () => {
    seedRunningTurn('turn-f1', {
      turnId: 'turn-f1',
      status: 'awaiting_approval',
      startedAt: 1000,
      events: [
        { id: 'e1', type: 'thinking', label: 'Thinking', ts: 1000, text: 'hmm' },
        { id: 'e2', type: 'approval', label: 'Approval requested: bash', ts: 1500, requestId: 'req-1', toolName: 'bash', input: {}, status: 'pending' },
      ],
    })

    completeTurn({ turnId: 'turn-f1', status: 'cancelled' })

    const data = activityData('turn-f1')
    expect(data.status).toBe('cancelled')
    expect(typeof data.endedAt).toBe('number')
    const events = data.events as Array<Record<string, unknown>>
    expect(events[0].endTs).toBeDefined()
    expect(events[1].status).toBe('cancelled')
  })

  it('completeTurn leaves a renderer-finalized activity row untouched', () => {
    seedRunningTurn('turn-f2', {
      turnId: 'turn-f2',
      status: 'done',
      startedAt: 1000,
      endedAt: 2000,
      events: [{ id: 'e1', type: 'thinking', label: 'Thinking', ts: 1000, endTs: 1900, text: 'rich detail' }],
    })

    completeTurn({ turnId: 'turn-f2', status: 'failed' })

    // The renderer already wrote its richer final state — daemon must not clobber.
    const data = activityData('turn-f2')
    expect(data.status).toBe('done')
    expect(data.endedAt).toBe(2000)
  })

  it('reconcileInterruptedTurns cancels turns stranded by a crash and finalizes their activity rows', () => {
    seedRunningTurn('turn-r1', { turnId: 'turn-r1', status: 'working', startedAt: 1000, events: [] })
    seedRunningTurn('turn-r2', { turnId: 'turn-r2', status: 'working', startedAt: 2000, events: [] })
    completeTurn({ turnId: 'turn-r2', status: 'done' })

    const reconciled = reconcileInterruptedTurns()

    expect(reconciled).toBe(1)
    const statuses = getDb().prepare('SELECT id, status FROM turns ORDER BY started_at').all() as Array<{ id: string; status: string }>
    expect(statuses).toEqual([
      { id: 'turn-r1', status: 'cancelled' },
      { id: 'turn-r2', status: 'done' },
    ])
    expect(activityData('turn-r1').status).toBe('cancelled')
  })
})

describe('messages table ownership', () => {
  // These tests need to control the database from before its first open, so
  // they swap in their own data dir and restore the suite's one afterwards.
  let ownDir: string | null = null

  function freshDataDir(): string {
    closeDb()
    ownDir = join(tmpdir(), `bond-test-transcript-own-${randomUUID()}`)
    mkdirSync(ownDir, { recursive: true })
    setDataDir(ownDir)
    return ownDir
  }

  afterEach(() => {
    if (ownDir) {
      closeDb()
      rmSync(ownDir, { recursive: true, force: true })
      ownDir = null
      setDataDir(testDir)
    }
  })

  const LEGACY_MESSAGES_PREAMBLE = `
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_meta VALUES ('schema_version', '2');
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      summary TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO sessions VALUES ('s1', 'Chat', '', 0, '2026-01-01', '2026-01-01');
  `

  it('gives a fresh install the canonical shape with NO rebuild', () => {
    const dir = freshDataDir()
    const execSpy = vi.spyOn(Database.prototype, 'exec')
    try {
      const db = getDb()
      // The rebuild path is the only code that touches the shadow table name.
      const executed = execSpy.mock.calls.map(c => String(c[0]))
      expect(executed.some(sql => sql.includes('messages_transcript_new'))).toBe(false)

      const byName = new Map((db.pragma('table_info(messages)') as Array<{ name: string; notnull: number }>).map(c => [c.name, c]))
      expect(byName.get('session_id')?.notnull).toBe(0)
      expect(byName.has('seq')).toBe(true)
      expect(byName.has('position')).toBe(true)
      expect(byName.get('position')?.notnull).toBe(0)
      expect(dir).toBe(ownDir)
    } finally {
      execSpy.mockRestore()
    }
  })

  it('rebuilds the legacy NOT NULL shape without losing a single column value', () => {
    const dir = freshDataDir()
    const legacy = new Database(join(dir, 'bond.db'))
    legacy.exec(`
      ${LEGACY_MESSAGES_PREAMBLE}
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT,
        streaming INTEGER,
        kind TEXT,
        name TEXT,
        summary TEXT,
        status TEXT,
        data TEXT,
        images TEXT,
        updated_at TEXT
      );
      INSERT INTO messages VALUES ('m1', 's1', 0, 'user', 'hello', 1, 'kind-x', 'name-x', 'sum-x', 'ok', '{"a":1}', '["img-1"]', '2026-01-02');
    `)
    legacy.close()

    const db = getDb()
    const row = db.prepare("SELECT * FROM messages WHERE id = 'm1'").get() as Record<string, unknown>
    expect(row).toMatchObject({
      session_id: 's1',
      position: 0,
      role: 'user',
      text: 'hello',
      streaming: 1,
      kind: 'kind-x',
      name: 'name-x',
      summary: 'sum-x',
      status: 'ok',
      data: '{"a":1}',
      images: '["img-1"]',
      updated_at: '2026-01-02',
    })
    const byName = new Map((db.pragma('table_info(messages)') as Array<{ name: string; notnull: number }>).map(c => [c.name, c]))
    expect(byName.get('session_id')?.notnull).toBe(0)
    expect(byName.has('seq')).toBe(true)
  })

  it('keeps data in canonical columns the old hardcoded copy list silently dropped', () => {
    const dir = freshDataDir()
    const legacy = new Database(join(dir, 'bond.db'))
    legacy.exec(`
      ${LEGACY_MESSAGES_PREAMBLE}
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT,
        seq INTEGER,
        image_ids TEXT,
        created_at TEXT
      );
      INSERT INTO messages VALUES ('m1', 's1', 0, 'user', 'hello', 7, '["img-9"]', '2026-01-03');
    `)
    legacy.close()

    const row = getDb().prepare("SELECT * FROM messages WHERE id = 'm1'").get() as Record<string, unknown>
    expect(row).toMatchObject({ seq: 7, image_ids: '["img-9"]', created_at: '2026-01-03' })
  })

  it('drops the retired epochs.observed_at_context_tokens column, keeping row data', () => {
    const dir = freshDataDir()
    const legacy = new Database(join(dir, 'bond.db'))
    legacy.exec(`
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO app_meta VALUES ('schema_version', '2');
      CREATE TABLE epochs (
        id TEXT PRIMARY KEY,
        pi_session_id TEXT NOT NULL UNIQUE,
        pi_session_file TEXT,
        status TEXT NOT NULL CHECK(status IN ('active','closed')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        context_window INTEGER NOT NULL DEFAULT 0,
        observed_through_seq INTEGER NOT NULL DEFAULT 0,
        observed_at_context_tokens INTEGER NOT NULL DEFAULT 0,
        reflected_through_seq INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO epochs (id, pi_session_id, status, started_at, observed_through_seq)
      VALUES ('e1', 'pi-e1', 'closed', '2026-01-01', 42);
    `)
    legacy.close()

    const db = getDb()
    const cols = (db.pragma('table_info(epochs)') as Array<{ name: string }>).map(c => c.name)
    expect(cols).not.toContain('observed_at_context_tokens')
    const row = db.prepare("SELECT observed_through_seq FROM epochs WHERE id = 'e1'").get() as { observed_through_seq: number }
    expect(row.observed_through_seq).toBe(42)
  })
})

describe('ensureTranscriptSchema runs once per db handle', () => {
  it('performs zero execs on an already-ensured handle', () => {
    const db = getDb() // ensured inside getDb()
    const execSpy = vi.spyOn(db, 'exec')
    try {
      ensureTranscriptSchema(db)
      ensureTranscriptSchema(db)
      expect(execSpy).not.toHaveBeenCalled()
    } finally {
      execSpy.mockRestore()
    }
  })

  it('re-runs the DDL for the fresh handle after closeDb()', () => {
    closeDb()
    const execSpy = vi.spyOn(Database.prototype, 'exec')
    try {
      getDb()
      const executed = execSpy.mock.calls.map(c => String(c[0]))
      expect(executed.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS epochs'))).toBe(true)
      expect(executed.some(sql => sql.includes('message_fts'))).toBe(true)
    } finally {
      execSpy.mockRestore()
    }
  })
})
