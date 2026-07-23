import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import { createEpoch } from './epochs'
import {
  completeTurn,
  ensureTranscriptSchema,
  getMessagesForRange,
  getSourceMessages,
  insertTurnStart,
  listMessages,
  reconcileInterruptedTurns,
  searchActivitySnippets,
  searchMessages,
  getLastUserMessageText,
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
    // Main scope round-trips as threadId: null, not merely absent.
    expect(page.messages.every(m => m.threadId === null)).toBe(true)
  })

  it('round-trips threadId on read for a thread-scoped message', () => {
    getDb().prepare("INSERT INTO messages (id, role, text) VALUES ('thread-anchor', 'bond', 'anchor')").run()
    getDb().prepare(`
      INSERT INTO threads (id, anchor_message_id, context_snapshot, status, created_at, updated_at)
      VALUES ('thread-1', 'thread-anchor', '{}', 'open', '2026-01-01', '2026-01-01')
    `).run()

    insertTurnStart({
      threadId: 'thread-1', turnId: 'thread-turn-1', userMessageId: 'thread-user-1',
      assistantMessageId: 'thread-bond-1', activityMessageId: 'thread-activity-1', text: 'thread question',
    })

    const page = listMessages({ threadId: 'thread-1' })
    expect(page.messages.every(m => m.threadId === 'thread-1')).toBe(true)
  })

  it('a renderer upsert cannot move an existing message between scopes — thread_id is set once at insert and pinned thereafter', () => {
    getDb().prepare("INSERT INTO messages (id, role, text) VALUES ('thread-anchor-2', 'bond', 'anchor')").run()
    getDb().prepare(`
      INSERT INTO threads (id, anchor_message_id, context_snapshot, status, created_at, updated_at)
      VALUES ('thread-2', 'thread-anchor-2', '{}', 'open', '2026-01-01', '2026-01-01')
    `).run()

    // A plain main-scope message, inserted with no threadId.
    upsertMessages([{ id: 'main-msg-1', epochId: 'epoch-1', role: 'bond', text: 'main scoped' }])
    expect(listMessages().messages.find(m => m.id === 'main-msg-1')?.threadId).toBeNull()

    // A later upsert for the SAME id claims a thread scope — must be ignored.
    upsertMessages([{ id: 'main-msg-1', epochId: 'epoch-1', role: 'bond', text: 'main scoped, edited', threadId: 'thread-2' }])
    const afterAttempt = listMessages().messages.find(m => m.id === 'main-msg-1')
    expect(afterAttempt?.threadId).toBeNull()
    expect(afterAttempt?.text).toBe('main scoped, edited') // the edit itself still applies — only the scope is pinned

    // And the reverse: a thread-scoped message can't be claimed back into main.
    insertTurnStart({
      threadId: 'thread-2', turnId: 'thread-turn-2', userMessageId: 'thread-user-2',
      assistantMessageId: 'thread-bond-2', activityMessageId: 'thread-activity-2', text: 'thread question 2',
    })
    upsertMessages([{ id: 'thread-bond-2', threadId: null, role: 'bond', text: 'reply, attempted scope swap' }])
    const threadMessage = listMessages({ threadId: 'thread-2' }).messages.find(m => m.id === 'thread-bond-2')
    expect(threadMessage?.threadId).toBe('thread-2')
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

  it('refuses to regress a finalized activity row or blank a written reply', () => {
    // Regression: a client that missed a turn's completion (mid-turn reload,
    // dropped chunks, stale bundle) bulk-persisted its old copy, flipping the
    // finished activity back to "working" and wiping the reply text.
    insertTurnStart({
      epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'bond-1', activityMessageId: 'activity-1', text: 'hi',
    })
    upsertMessages([
      { id: 'activity-1', role: 'meta', kind: 'activity', data: { turnId: 'turn-1', status: 'done', startedAt: 1, endedAt: 2, events: [] } },
      { id: 'bond-1', role: 'bond', text: 'the finished reply' },
    ])

    upsertMessages([
      { id: 'activity-1', role: 'meta', kind: 'activity', data: { turnId: 'turn-1', status: 'working', startedAt: 1, events: [] } },
      { id: 'bond-1', role: 'bond', text: '' },
    ])

    const messages = listMessages().messages
    expect((messages.find(m => m.id === 'activity-1')?.data as { status?: string } | undefined)?.status).toBe('done')
    expect(messages.find(m => m.id === 'bond-1')?.text).toBe('the finished reply')
  })

  it('still lets live activity rows update and finished rows refine', () => {
    insertTurnStart({
      epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'bond-1', activityMessageId: 'activity-1', text: 'hi',
    })
    upsertMessages([{ id: 'activity-1', role: 'meta', kind: 'activity', data: { turnId: 'turn-1', status: 'working', startedAt: 1, events: [{ type: 'thinking' }] } }])
    upsertMessages([{ id: 'activity-1', role: 'meta', kind: 'activity', data: { turnId: 'turn-1', status: 'done', startedAt: 1, endedAt: 2, events: [] } }])
    upsertMessages([{ id: 'bond-1', role: 'bond', text: 'longer revised reply' }])

    const messages = listMessages().messages
    expect((messages.find(m => m.id === 'activity-1')?.data as { status?: string } | undefined)?.status).toBe('done')
    expect(messages.find(m => m.id === 'bond-1')?.text).toBe('longer revised reply')
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

describe('transcript search is a recall tool', () => {
  function seedMorningAudit(): void {
    insertTurnStart({
      epochId: 'epoch-1', turnId: 't1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1',
      text: "let's start the studio trunk audit",
    })
    upsertMessages([{ id: 'b1', role: 'bond', epochId: 'epoch-1', turnId: 't1', text: 'Wrote the Studio trunk audit document with 18 findings.' }])
  }

  it('filters roles in SQL so activity rows cannot crowd out the results', () => {
    // Six activity rows all matching "audit" used to consume the LIMIT before
    // the post-filter ran, so the tool returned empty while matches existed.
    seedMorningAudit()
    for (let i = 0; i < 6; i += 1) {
      insertTurnStart({
        epochId: 'epoch-1', turnId: `t-noise-${i}`, userMessageId: `un${i}`, assistantMessageId: `bn${i}`, activityMessageId: `an${i}`,
        text: 'unrelated',
        activityData: {
          turnId: `t-noise-${i}`, status: 'done', startedAt: 1,
          events: [{ id: `e${i}`, type: 'tool', label: 'Read audit document', ts: 1, toolName: 'read', output: 'audit audit audit' }],
        },
      })
    }

    const results = searchMessages('audit', { limit: 4, roles: ['user', 'bond'] })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(m => m.role === 'user' || m.role === 'bond')).toBe(true)
  })

  it('THE INCIDENT: the literal recovered query finds the morning discussion', () => {
    // Recovered from the 17:05Z session JSONL at 18:26:34Z. It returned nothing:
    // AND-of-all-tokens required one message containing on/to/9/studio/audit.
    seedMorningAudit()
    const results = searchMessages('"on to 9" Studio audit', { limit: 8, roles: ['user', 'bond'] })
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.text?.includes('studio trunk audit') || m.text?.includes('Studio trunk audit'))).toBe(true)
  })

  it('prefers the strict AND result when it matches at all', () => {
    seedMorningAudit()
    upsertMessages([{ id: 'x1', role: 'user', epochId: 'epoch-1', turnId: 't1', text: 'studio only' }])
    const results = searchMessages('studio trunk', { roles: ['user', 'bond'] })
    expect(results.map(m => m.id)).not.toContain('x1')
  })

  it('does not run a second pass for a single-term query', () => {
    seedMorningAudit()
    expect(searchMessages('nonexistentterm', { roles: ['user', 'bond'] })).toEqual([])
  })

  it('returns activity snippets from indexed tool output', () => {
    insertTurnStart({
      epochId: 'epoch-1', turnId: 't2', userMessageId: 'u2', assistantMessageId: 'b2', activityMessageId: 'a2',
      text: 'do it',
      activityData: {
        turnId: 't2', status: 'done', startedAt: 1,
        events: [{ id: 'e1', type: 'tool', label: 'Write library document', ts: 1, toolName: 'write', output: 'Studio trunk audit — July 21, 2026' }],
      },
    })

    const snippets = searchActivitySnippets('studio trunk audit', 3)
    expect(snippets.length).toBeGreaterThan(0)
    expect(snippets[0].snippet.toLowerCase()).toContain('audit')
  })

  it('finds the last user message, honoring exclusions', () => {
    seedMorningAudit()
    expect(getLastUserMessageText()).toBe("let's start the studio trunk audit")
    expect(getLastUserMessageText(['u1'])).toBeNull()
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

  it('completeTurn finalizes a live activity row and cancels its pending question', () => {
    seedRunningTurn('turn-q1', {
      turnId: 'turn-q1',
      status: 'awaiting_question',
      startedAt: 1000,
      events: [
        { id: 'e1', type: 'question', label: 'Question asked', ts: 1000, questionId: 'q-1', question: 'Which approach?', options: [], status: 'pending' },
      ],
    })

    completeTurn({ turnId: 'turn-q1', status: 'cancelled' })

    const data = activityData('turn-q1')
    expect(data.status).toBe('cancelled')
    const events = data.events as Array<Record<string, unknown>>
    expect(events[0].status).toBe('cancelled')
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

  it('completeTurn finalizes a client-minted continuation activity row too', () => {
    // Answering an ask_user_question mid-turn closes the daemon's row and the
    // client mints a continuation one (turn_id column unset, turnId in data).
    // A client that dies before query_end would otherwise leave it pulsing.
    seedRunningTurn('turn-c1', { turnId: 'turn-c1', status: 'done', startedAt: 1000, endedAt: 2000, events: [] })
    upsertMessages([{
      id: 'activity-turn-c1-b', role: 'meta', kind: 'activity',
      data: { turnId: 'turn-c1', status: 'working', startedAt: 2100, events: [] },
    }])

    completeTurn({ turnId: 'turn-c1', status: 'cancelled' })

    const row = getDb().prepare('SELECT data FROM messages WHERE id = ?').get('activity-turn-c1-b') as { data: string }
    expect(JSON.parse(row.data).status).toBe('cancelled')
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

  it('reconciles a turn stranded in a THREAD scope too — startup sweeps every scope, not just main', () => {
    getDb().prepare("INSERT INTO messages (id, role, text) VALUES ('thread-anchor', 'bond', 'anchor')").run()
    getDb().prepare(`
      INSERT INTO threads (id, anchor_message_id, context_snapshot, status, created_at, updated_at)
      VALUES ('thread-1', 'thread-anchor', '{}', 'open', '2026-01-01', '2026-01-01')
    `).run()
    const threadEpoch = createEpoch({ id: 'thread-epoch-1', piSessionId: 'pi-thread-1', threadId: 'thread-1' })

    insertTurnStart({
      epochId: threadEpoch.id,
      threadId: 'thread-1',
      turnId: 'thread-turn-r1',
      userMessageId: 'thread-user-r1',
      assistantMessageId: 'thread-bond-r1',
      activityMessageId: 'thread-activity-r1',
      text: 'hello from the thread',
      activityData: { turnId: 'thread-turn-r1', status: 'working', startedAt: 1000, events: [] } as never,
    })

    const reconciled = reconcileInterruptedTurns()

    expect(reconciled).toBe(1)
    const turn = getDb().prepare('SELECT status FROM turns WHERE id = ?').get('thread-turn-r1') as { status: string }
    expect(turn.status).toBe('cancelled')
    const activity = getDb().prepare('SELECT data FROM messages WHERE id = ?').get('thread-activity-r1') as { data: string }
    expect(JSON.parse(activity.data).status).toBe('cancelled')
  })
})

describe('startup sweep', () => {
  it('re-finalizes activity rows regressed after their turn completed', () => {
    insertTurnStart({
      epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'bond-1', activityMessageId: 'activity-1', text: 'hi',
    })
    completeTurn({ turnId: 'turn-1', status: 'done', completedAt: '2026-01-01T00:00:00.000Z' })
    // Simulate pre-guard corruption via direct SQL (upsertMessages now rejects this).
    getDb().prepare('UPDATE messages SET data = ? WHERE id = ?')
      .run(JSON.stringify({ turnId: 'turn-1', status: 'working', startedAt: 1, events: [] }), 'activity-1')

    const reconciled = reconcileInterruptedTurns()

    expect(reconciled).toBe(1)
    const activity = listMessages().messages.find(m => m.id === 'activity-1')
    expect((activity?.data as { status?: string } | undefined)?.status).toBe('done')
  })

  it('reports zero when finished rows are already healthy', () => {
    insertTurnStart({
      epochId: 'epoch-1', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'bond-1', activityMessageId: 'activity-1', text: 'hi',
    })
    upsertMessages([{ id: 'activity-1', role: 'meta', kind: 'activity', data: { turnId: 'turn-1', status: 'done', startedAt: 1, endedAt: 2, events: [] } }])
    completeTurn({ turnId: 'turn-1', status: 'done', completedAt: '2026-01-01T00:00:00.000Z' })

    expect(reconcileInterruptedTurns()).toBe(0)
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

describe('chat-threads scoping migration', () => {
  let ownDir: string | null = null

  function freshDataDir(): string {
    closeDb()
    ownDir = join(tmpdir(), `bond-test-transcript-threads-${randomUUID()}`)
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

  it('gives a fresh database the threads table, thread_id columns, and per-scope indexes', () => {
    freshDataDir()
    const db = getDb()

    const threadsCols = (db.pragma('table_info(threads)') as Array<{ name: string }>).map(c => c.name)
    expect(threadsCols).toEqual(expect.arrayContaining(['id', 'anchor_message_id', 'context_snapshot', 'status', 'created_at', 'updated_at', 'last_read_at']))

    for (const table of ['epochs', 'turns', 'messages']) {
      const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name)
      expect(cols).toContain('thread_id')
    }

    const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(r => r.name)
    expect(indexNames).toContain('one_active_main_epoch')
    expect(indexNames).toContain('one_active_epoch_per_thread')
    expect(indexNames).not.toContain('one_active_epoch')
  })

  it('migrates an existing pre-threads database without losing epoch/turn/message data', () => {
    const dir = freshDataDir()
    const legacy = new Database(join(dir, 'bond.db'))
    legacy.exec(`
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO app_meta VALUES ('schema_version', '2');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat', summary TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
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
        reflected_through_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX one_active_epoch ON epochs(status) WHERE status = 'active';
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        epoch_id TEXT REFERENCES epochs(id),
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        activity_message_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
        model TEXT, started_at TEXT NOT NULL, completed_at TEXT, context_tokens INTEGER, context_window INTEGER
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        position INTEGER, role TEXT NOT NULL, text TEXT, streaming INTEGER, kind TEXT, name TEXT,
        summary TEXT, status TEXT, images TEXT, data TEXT,
        epoch_id TEXT REFERENCES epochs(id), turn_id TEXT REFERENCES turns(id), seq INTEGER UNIQUE,
        image_ids TEXT, created_at TEXT, updated_at TEXT
      );
      INSERT INTO epochs (id, pi_session_id, status, started_at, observed_through_seq, reflected_through_seq)
      VALUES ('e1', 'pi-e1', 'active', '2026-01-01', 5, 5);
      INSERT INTO turns (id, epoch_id, user_message_id, assistant_message_id, activity_message_id, status, started_at)
      VALUES ('t1', 'e1', 'u1', 'b1', 'a1', 'done', '2026-01-01');
      INSERT INTO messages (id, role, text, epoch_id, turn_id, seq) VALUES ('u1', 'user', 'hello', 'e1', 't1', 1);
      INSERT INTO messages (id, role, text, epoch_id, turn_id, seq) VALUES ('b1', 'bond', 'hi there', 'e1', 't1', 2);
    `)
    legacy.close()

    const db = getDb()

    for (const table of ['epochs', 'turns', 'messages']) {
      const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name)
      expect(cols).toContain('thread_id')
    }
    const threadsCols = (db.pragma('table_info(threads)') as Array<{ name: string }>).map(c => c.name)
    expect(threadsCols).toContain('anchor_message_id')

    const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(r => r.name)
    expect(indexNames).not.toContain('one_active_epoch')
    expect(indexNames).toContain('one_active_main_epoch')
    expect(indexNames).toContain('one_active_epoch_per_thread')

    const epoch = db.prepare("SELECT * FROM epochs WHERE id = 'e1'").get() as Record<string, unknown>
    expect(epoch).toMatchObject({ pi_session_id: 'pi-e1', observed_through_seq: 5, thread_id: null })
    const turn = db.prepare("SELECT * FROM turns WHERE id = 't1'").get() as Record<string, unknown>
    expect(turn).toMatchObject({ user_message_id: 'u1', thread_id: null })
    const bondMessage = db.prepare("SELECT * FROM messages WHERE id = 'b1'").get() as Record<string, unknown>
    expect(bondMessage).toMatchObject({ text: 'hi there', thread_id: null })

    // The migrated index still enforces exactly one active main epoch...
    expect(() => createEpoch({ id: 'e2', piSessionId: 'pi-e2' })).toThrow(/UNIQUE constraint/)
    // ...but once e1 closes, a new main epoch is accepted exactly like the
    // old global one_active_epoch index would have allowed.
    db.prepare("UPDATE epochs SET status = 'closed' WHERE id = 'e1'").run()
    expect(() => createEpoch({ id: 'e2', piSessionId: 'pi-e2' })).not.toThrow()
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
