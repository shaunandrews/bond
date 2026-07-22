import type Database from 'better-sqlite3'
import { getDb } from './db'
import { buildMatchQuery, countMatchTerms, type MatchMode } from './fts'
import type { CompleteTurnInput, InsertTurnStartInput, TranscriptMessage, TranscriptPage, TranscriptRole, TurnStatus } from '../shared/transcript'

const TOOL_OUTPUT_INDEX_LIMIT = 4_000
const DEFAULT_PAGE_LIMIT = 100
const MAX_PAGE_LIMIT = 500
const MAX_SEARCH_TERMS = 8
const MAX_SEARCH_LIMIT = 100

type MessageRow = {
  id: string
  epoch_id: string | null
  turn_id: string | null
  thread_id: string | null
  seq: number | null
  role: TranscriptRole
  kind: string | null
  text: string | null
  data: string | null
  images?: string | null
  image_ids?: string | null
  created_at: string | null
  updated_at: string | null
}

/**
 * Canonical DDL for the `messages` table — the SINGLE owner of its shape.
 * db.ts createSchema uses it for fresh installs and ensureMessagesTableShape
 * uses it for the legacy-upgrade shadow copy, so the two can never drift.
 */
export function messagesTableDdl(tableName: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      position INTEGER,
      role TEXT NOT NULL CHECK(role IN ('user','bond','meta')),
      text TEXT,
      streaming INTEGER,
      kind TEXT,
      name TEXT,
      summary TEXT,
      status TEXT,
      images TEXT,
      data TEXT,
      epoch_id TEXT REFERENCES epochs(id),
      turn_id TEXT REFERENCES turns(id),
      thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
      seq INTEGER UNIQUE,
      image_ids TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT
    );
  `
}

/**
 * threads' own indexes are safe to create inline — unlike epochs/turns below,
 * nothing here depends on a column a migration adds later.
 */
const THREADS_DDL = `
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    anchor_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    context_snapshot TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft', 'open', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
`

/**
 * Bare CREATE TABLE only — no indexes. On an existing (pre-threads) database
 * these tables already exist without a thread_id column, so any index built
 * on that column has to wait until the ALTER-column migration in
 * ensureTranscriptSchema has actually run; bundling them into this DDL (which
 * db.ts also execs directly for fresh installs, before that migration step)
 * would fail with "no such column: thread_id" on every upgrade.
 */
const EPOCHS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS epochs (
    id TEXT PRIMARY KEY,
    pi_session_id TEXT NOT NULL UNIQUE,
    pi_session_file TEXT,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('active','closed')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT,
    context_tokens INTEGER NOT NULL DEFAULT 0,
    context_window INTEGER NOT NULL DEFAULT 0,
    observed_through_seq INTEGER NOT NULL DEFAULT 0,
    reflected_through_seq INTEGER NOT NULL DEFAULT 0
  );
`

const TURNS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    epoch_id TEXT REFERENCES epochs(id),
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    user_message_id TEXT NOT NULL,
    assistant_message_id TEXT NOT NULL,
    activity_message_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
    model TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    context_tokens INTEGER,
    context_window INTEGER
  );
`

/**
 * threads + bare epochs/turns tables, exported so db.ts createSchema can
 * create them BEFORE the canonical messages table: messages carries
 * REFERENCES epochs(id) / turns(id) / threads(id), and with
 * PRAGMA foreign_keys = ON, SQLite refuses ANY insert into a table whose FK
 * parent is missing — even for NULL FK values. threads.anchor_message_id in
 * turn carries REFERENCES messages(id); that circularity is fine because
 * CREATE TABLE never validates FK targets, only DML does, and by the time
 * anything is inserted every table in this chain already exists.
 */
export function transcriptPrereqDdl(): string {
  return THREADS_DDL + EPOCHS_TABLE_DDL + TURNS_TABLE_DDL
}

/**
 * The transcript DDL is pure CREATE IF NOT EXISTS + pragma probes, but it used
 * to run on EVERY transcript operation — hot-path overhead on every send. Each
 * Database handle only needs it once; closeDb() and the sandbox swap both
 * construct a brand-new Database instance, so a WeakSet keyed on the handle
 * needs no reset plumbing. Added only AFTER the DDL succeeds, so a throw never
 * poisons the handle.
 */
const ensured = new WeakSet<Database.Database>()

export function ensureTranscriptSchema(db = getDb()): void {
  if (ensured.has(db)) return

  db.exec(THREADS_DDL)

  // thread_id must land on epochs/turns BEFORE any index referencing it is
  // created below — an existing (pre-threads) database has the tables
  // without the column until this ALTER runs.
  addColumnIfTableExists(db, 'epochs', 'thread_id', 'thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE')
  addColumnIfTableExists(db, 'turns', 'thread_id', 'thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE')

  db.exec(EPOCHS_TABLE_DDL)
  // Superseded by the two per-scope indexes below — concurrent main+thread
  // epochs are exactly what this single global uniqueness constraint forbade.
  db.exec('DROP INDEX IF EXISTS one_active_epoch')
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_main_epoch ON epochs(status) WHERE status = 'active' AND thread_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_epoch_per_thread ON epochs(thread_id) WHERE status = 'active' AND thread_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_epochs_thread_status ON epochs(thread_id, status);
  `)
  dropRetiredEpochColumns(db)

  db.exec(TURNS_TABLE_DDL)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turns_epoch ON turns(epoch_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_turns_thread_started ON turns(thread_id, started_at);
  `)

  ensureMessagesTableShape(db)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_cursor ON messages(seq DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_epoch ON messages(epoch_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_thread_cursor ON messages(thread_id, seq DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      message_id UNINDEXED,
      text,
      kind UNINDEXED,
      tokenize='unicode61 remove_diacritics 2'
    );
  `)

  ensured.add(db)
}

function addColumnIfTableExists(db: Database.Database, table: string, name: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  if (cols.length > 0 && !cols.some(c => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

/** observed_at_context_tokens was written by nothing and read by nothing. */
function dropRetiredEpochColumns(db: Database.Database): void {
  const cols = db.pragma('table_info(epochs)') as Array<{ name: string }>
  if (cols.some(c => c.name === 'observed_at_context_tokens')) {
    db.exec('ALTER TABLE epochs DROP COLUMN observed_at_context_tokens')
  }
}

function ensureMessagesTableShape(db: Database.Database): void {
  const cols = db.pragma('table_info(messages)') as Array<{ name: string; notnull: number }>
  const byName = new Map(cols.map(c => [c.name, c]))
  const needsRebuild = cols.length === 0 || byName.get('session_id')?.notnull === 1 || byName.get('seq')?.notnull === 1

  if (needsRebuild) {
    db.exec(messagesTableDdl('messages_transcript_new'))

    if (cols.length > 0) {
      // Copy the runtime intersection of old and canonical columns — a
      // hardcoded list once silently dropped any column it didn't know about.
      const newCols = new Set((db.pragma('table_info(messages_transcript_new)') as Array<{ name: string }>).map(c => c.name))
      const copyCols = cols.map(c => c.name).filter(name => newCols.has(name))
      db.exec(`INSERT OR IGNORE INTO messages_transcript_new (${copyCols.join(', ')}) SELECT ${copyCols.join(', ')} FROM messages`)
      db.exec('DROP TABLE messages')
    }
    db.exec('ALTER TABLE messages_transcript_new RENAME TO messages')
    return
  }

  const addColumn = (name: string, ddl: string) => {
    if (!byName.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${ddl}`)
  }
  addColumn('epoch_id', 'epoch_id TEXT REFERENCES epochs(id)')
  addColumn('turn_id', 'turn_id TEXT REFERENCES turns(id)')
  addColumn('thread_id', 'thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE')
  addColumn('seq', 'seq INTEGER UNIQUE')
  addColumn('image_ids', 'image_ids TEXT')
  addColumn('created_at', "created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
  addColumn('updated_at', 'updated_at TEXT')
}

function nowIso(): string {
  return new Date().toISOString()
}

function clampLimit(limit: unknown, fallback = DEFAULT_PAGE_LIMIT, max = MAX_PAGE_LIMIT): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback
  return Math.max(1, Math.min(max, Math.floor(limit)))
}

function nextSeq(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages').get() as { seq: number }
  return row.seq
}

function encodeJson(value: unknown): string | null {
  if (value == null) return null
  return JSON.stringify(value)
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function parseStringArray(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every(v => typeof v === 'string') ? parsed : undefined
  } catch {
    return undefined
  }
}

function rowToMessage(row: MessageRow): TranscriptMessage {
  const data = parseJsonObject(row.data)
  const imageIds = parseStringArray(row.image_ids ?? row.images)
  return {
    id: row.id,
    epochId: row.epoch_id,
    turnId: row.turn_id,
    seq: row.seq ?? undefined,
    role: row.role,
    kind: row.kind,
    text: row.text,
    data,
    imageIds,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  }
}

function searchableText(message: Pick<TranscriptMessage, 'role' | 'kind' | 'text' | 'data'>): string {
  if (message.role === 'user' || message.role === 'bond') return message.text ?? ''
  if (message.kind === 'error' || message.kind === 'system') return message.text ?? ''
  if (message.kind !== 'activity' || !message.data) return ''

  const events = Array.isArray(message.data.events) ? message.data.events : []
  const parts: string[] = []
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const evt = raw as Record<string, unknown>
    if (evt.type === 'tool') {
      if (typeof evt.label === 'string') parts.push(evt.label)
      if (typeof evt.toolName === 'string') parts.push(evt.toolName)
      if (typeof evt.output === 'string') parts.push(evt.output.slice(0, TOOL_OUTPUT_INDEX_LIMIT))
    } else if (evt.type === 'error' && typeof evt.text === 'string') {
      parts.push(evt.text)
    } else if (typeof evt.label === 'string' && (evt.type === 'approval' || evt.type === 'thinking')) {
      parts.push(evt.label)
    }
  }
  return parts.join('\n')
}

function updateMessageFts(db: Database.Database, message: Pick<TranscriptMessage, 'id' | 'role' | 'kind' | 'text' | 'data'>): void {
  db.prepare('DELETE FROM message_fts WHERE message_id = ?').run(message.id)
  const text = searchableText(message).trim()
  if (!text) return
  db.prepare('INSERT INTO message_fts (message_id, text, kind) VALUES (?, ?, ?)').run(message.id, text, message.kind ?? null)
}

/**
 * A turn's scope must match its epoch's scope — a thread turn resuming
 * main's epoch (or vice versa) would silently merge two conversations that
 * are supposed to stay isolated. Checked here (not just trusted from the
 * caller) because this is the one place a turn actually gets attached to an
 * epoch. Raw SQL rather than importing epochs.ts, which already imports this
 * module (getMessagesForRange) — avoiding a circular module dependency for a
 * single-column lookup.
 */
function assertEpochScopeMatches(db: Database.Database, epochId: string | null | undefined, threadId: string | null): void {
  if (!epochId) return
  const row = db.prepare('SELECT thread_id FROM epochs WHERE id = ?').get(epochId) as { thread_id: string | null } | undefined
  if (row && row.thread_id !== threadId) {
    throw new Error(`Turn scope (thread_id=${threadId ?? 'main'}) does not match epoch ${epochId}'s scope (thread_id=${row.thread_id ?? 'main'})`)
  }
}

export function insertTurnStart(input: InsertTurnStartInput): void {
  const db = getDb()
  ensureTranscriptSchema(db)
  const now = input.now ?? nowIso()
  const threadId = input.threadId ?? null
  assertEpochScopeMatches(db, input.epochId, threadId)
  const activityData = input.activityData ?? { turnId: input.turnId, userMessageId: input.userMessageId, assistantMessageId: input.assistantMessageId, status: 'working', startedAt: Date.now(), events: [] }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO turns (id, epoch_id, thread_id, user_message_id, assistant_message_id, activity_message_id, status, model, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(input.turnId, input.epochId, threadId, input.userMessageId, input.assistantMessageId, input.activityMessageId, input.model ?? null, now)

    const insert = db.prepare(`
      INSERT INTO messages (id, epoch_id, turn_id, thread_id, seq, role, kind, text, data, image_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const user: TranscriptMessage = {
      id: input.userMessageId,
      epochId: input.epochId,
      turnId: input.turnId,
      threadId,
      seq: nextSeq(db),
      role: 'user',
      text: input.text,
      imageIds: input.imageIds,
      createdAt: now,
      updatedAt: now,
    }
    insert.run(user.id, input.epochId, input.turnId, threadId, user.seq, user.role, null, input.text, null, encodeJson(input.imageIds ?? []), now, now)
    updateMessageFts(db, user)

    const activity: TranscriptMessage = {
      id: input.activityMessageId,
      epochId: input.epochId,
      turnId: input.turnId,
      threadId,
      seq: nextSeq(db),
      role: 'meta',
      kind: 'activity',
      data: activityData,
      createdAt: now,
      updatedAt: now,
    }
    insert.run(activity.id, input.epochId, input.turnId, threadId, activity.seq, activity.role, activity.kind, null, encodeJson(activityData), null, now, now)
    updateMessageFts(db, activity)

    const assistant: TranscriptMessage = {
      id: input.assistantMessageId,
      epochId: input.epochId,
      turnId: input.turnId,
      threadId,
      seq: nextSeq(db),
      role: 'bond',
      text: '',
      createdAt: now,
      updatedAt: now,
    }
    insert.run(assistant.id, input.epochId, input.turnId, threadId, assistant.seq, assistant.role, null, '', null, null, now, now)
    updateMessageFts(db, assistant)
  })()
}

const TERMINAL_ACTIVITY_STATUSES = ['done', 'failed', 'cancelled']

/**
 * A client may describe a turn it is watching; it must never un-finish one.
 * A window that missed a turn's completion (mid-turn reload, dropped chunks,
 * old bundle) holds a stale copy, and its later bulk persist used to regress
 * the finalized activity row to "working" and blank the reply text. The
 * daemon finalizes turns exactly once — refuse any write that would undo it,
 * whichever client sends it.
 */
function rejectStaleWrite(existing: MessageRow, incoming: TranscriptMessage): string | null {
  if (existing.role === 'meta' && (incoming.kind ?? existing.kind) === 'activity') {
    const existingStatus = String(parseJsonObject(existing.data)?.status ?? '')
    const incomingStatus = String((incoming.data as Record<string, unknown> | undefined)?.status ?? '')
    if (TERMINAL_ACTIVITY_STATUSES.includes(existingStatus) && LIVE_ACTIVITY_STATUSES.includes(incomingStatus)) {
      return `activity ${existing.id} is ${existingStatus}; refusing regression to ${incomingStatus}`
    }
  }
  if (existing.role === 'bond' && typeof existing.text === 'string' && existing.text.length > 0 && !(incoming.text ?? '')) {
    return `bond message ${existing.id} has ${existing.text.length} chars; refusing empty overwrite`
  }
  return null
}

export function upsertMessages(messages: TranscriptMessage[]): void {
  if (messages.length === 0) return
  const db = getDb()
  ensureTranscriptSchema(db)
  const now = nowIso()

  db.transaction(() => {
    const existingStmt = db.prepare('SELECT * FROM messages WHERE id = ?')
    const insert = db.prepare(`
      INSERT INTO messages (id, epoch_id, turn_id, thread_id, seq, role, kind, text, data, image_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const update = db.prepare(`
      UPDATE messages SET
        kind = ?, text = ?, data = ?, image_ids = ?, updated_at = ?
      WHERE id = ?
    `)

    for (const m of messages) {
      const existing = existingStmt.get(m.id) as MessageRow | undefined
      if (existing) {
        const rejection = rejectStaleWrite(existing, m)
        if (rejection) {
          console.log(`[bond-daemon] transcript.upsert rejected: ${rejection}`)
          continue
        }
      }
      const seq = existing?.seq ?? m.seq ?? nextSeq(db)
      const createdAt = existing?.created_at ?? m.createdAt ?? now
      const epochId = existing?.epoch_id ?? m.epochId ?? null
      const turnId = existing?.turn_id ?? m.turnId ?? null
      // Immutable, like epoch/turn ownership — a renderer upsert cannot move
      // a message between scopes, it can only set it once at insert time.
      const threadId = existing?.thread_id ?? m.threadId ?? null
      const role = existing?.role ?? m.role
      const kind = m.kind ?? existing?.kind ?? null
      const text = m.text ?? null
      const data = m.data ?? null
      const imageIds = m.imageIds ?? parseStringArray(existing?.image_ids ?? existing?.images)

      if (existing) {
        update.run(kind, text, encodeJson(data), encodeJson(imageIds), now, m.id)
      } else {
        insert.run(m.id, epochId, turnId, threadId, seq, role, kind, text, encodeJson(data), encodeJson(imageIds), createdAt, now)
      }
      updateMessageFts(db, { id: m.id, role, kind, text, data })
    }
  })()
}

export function startTurn(turnId: string, epochId: string): void {
  const db = getDb()
  ensureTranscriptSchema(db)
  const now = nowIso()
  db.transaction(() => {
    db.prepare("UPDATE turns SET epoch_id = ?, status = 'running' WHERE id = ?").run(epochId, turnId)
    db.prepare('UPDATE messages SET epoch_id = ?, updated_at = ? WHERE turn_id = ?').run(epochId, now, turnId)
  })()
}

/** null covers both "main scope" and "unknown turn" — safe for broadcast tagging, where an unknown turn defaults to main. */
export function getTurnThreadId(turnId: string, db: Database.Database = getDb()): string | null {
  ensureTranscriptSchema(db)
  const row = db.prepare('SELECT thread_id FROM turns WHERE id = ?').get(turnId) as { thread_id: string | null } | undefined
  return row?.thread_id ?? null
}

const LIVE_ACTIVITY_STATUSES = ['working', 'responding', 'awaiting_approval', 'awaiting_question']

/**
 * Flip a still-live activity row to its terminal status. The live-status
 * guard means the renderer's richer final persist (full events, timings) is
 * never clobbered — this only finishes rows nobody else did: a crashed
 * client mid-stream, or a daemon death reconciled at startup. Without it a
 * row stuck on 'working' renders as an eternally pulsing "Working…".
 */
function finalizeActivityMessage(db: Database.Database, activityMessageId: string, status: TurnStatus, completedAt: string): void {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(activityMessageId) as MessageRow | undefined
  if (!row) return
  const data = parseJsonObject(row.data)
  if (!data || !LIVE_ACTIVITY_STATUSES.includes(String(data.status))) return

  const endedAt = Date.parse(completedAt) || Date.now()
  data.status = status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'failed'
  if (typeof data.endedAt !== 'number') data.endedAt = endedAt
  const events = Array.isArray(data.events) ? data.events : []
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const evt = raw as Record<string, unknown>
    if (evt.type === 'approval' && evt.status === 'pending') evt.status = 'cancelled'
    if (evt.type === 'question' && evt.status === 'pending') evt.status = 'cancelled'
    if (typeof evt.endTs !== 'number' && (evt.type === 'thinking' || evt.type === 'tool' || evt.type === 'responding')) evt.endTs = endedAt
  }
  db.prepare('UPDATE messages SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), completedAt, row.id)
  updateMessageFts(db, { id: row.id, role: row.role, kind: row.kind, text: row.text, data })
}

export function completeTurn(input: CompleteTurnInput): void {
  const db = getDb()
  ensureTranscriptSchema(db)
  const completedAt = input.completedAt ?? nowIso()
  const status: TurnStatus = input.status

  db.transaction(() => {
    const row = db.prepare('SELECT epoch_id, activity_message_id FROM turns WHERE id = ?').get(input.turnId) as { epoch_id: string; activity_message_id: string } | undefined
    if (!row) return
    db.prepare(`
      UPDATE turns
      SET status = ?, completed_at = ?, context_tokens = ?, context_window = ?
      WHERE id = ?
    `).run(status, completedAt, input.contextTokens ?? null, input.contextWindow ?? null, input.turnId)

    if (input.contextTokens != null || input.contextWindow != null) {
      db.prepare(`
        UPDATE epochs SET
          context_tokens = COALESCE(?, context_tokens),
          context_window = COALESCE(?, context_window)
        WHERE id = ?
      `).run(input.contextTokens ?? null, input.contextWindow ?? null, row.epoch_id)
    }

    for (const id of activityMessageIdsForTurn(db, input.turnId, row.activity_message_id)) {
      finalizeActivityMessage(db, id, status, completedAt)
    }
  })()
}

/**
 * Every activity row belonging to a turn, starting with the one the daemon
 * inserted. A turn can grow extra rows: answering an ask_user_question mid-turn
 * closes the current row and the client mints a continuation one so the live
 * row stays below the answer. Those rows are client-written (turn_id column
 * unset), so match on the turnId carried in the row's own data — otherwise a
 * client that dies before query_end leaves one pulsing "Working…" forever.
 */
function activityMessageIdsForTurn(db: Database.Database, turnId: string, primaryId: string): string[] {
  const rows = db.prepare(
    "SELECT id FROM messages WHERE role = 'meta' AND kind = 'activity' AND json_extract(data, '$.turnId') = ? ORDER BY seq ASC",
  ).all(turnId) as Array<{ id: string }>
  const ids = rows.map(r => r.id)
  return ids.includes(primaryId) ? ids : [primaryId, ...ids]
}

/**
 * Finish turns stranded by a daemon death: anything still 'running' or
 * 'queued' at startup can have no live query behind it. Marked cancelled
 * (not failed) — the daemon died out from under the turn; the turn itself
 * did nothing wrong. Same recovery idea as the Sense capture re-queue.
 */
export function reconcileInterruptedTurns(now = nowIso()): number {
  const db = getDb()
  ensureTranscriptSchema(db)
  const stuck = db.prepare("SELECT id FROM turns WHERE status IN ('queued','running')").all() as Array<{ id: string }>
  for (const turn of stuck) {
    completeTurn({ turnId: turn.id, status: 'cancelled', completedAt: now })
  }

  // The turns table is the authority: a stale client write (pre-dating the
  // upsert guard) could have regressed a finished turn's activity row back to
  // a live status, leaving an eternally pulsing "Working…" row. Re-finalize
  // any live activity row whose turn already ended.
  const finished = db.prepare(`
    SELECT t.status AS turn_status, t.completed_at, t.activity_message_id, m.data AS activity_data
    FROM turns t JOIN messages m ON m.id = t.activity_message_id
    WHERE t.status IN ('done','failed','cancelled')
  `).all() as Array<{ turn_status: TurnStatus; completed_at: string | null; activity_message_id: string; activity_data: string | null }>
  let repaired = 0
  for (const row of finished) {
    const status = String(parseJsonObject(row.activity_data)?.status ?? '')
    if (!LIVE_ACTIVITY_STATUSES.includes(status)) continue
    finalizeActivityMessage(db, row.activity_message_id, row.turn_status, row.completed_at ?? now)
    repaired++
  }
  if (repaired > 0) console.log(`[bond-daemon] startup sweep re-finalized ${repaired} regressed activity row(s)`)
  return stuck.length + repaired
}

/** `threadId` omitted/null means the main conversation — the safe default, since every existing caller wants main-only rows. */
export function listMessages(options: { beforeSeq?: number; limit?: number; threadId?: string | null } = {}): TranscriptPage {
  const db = getDb()
  ensureTranscriptSchema(db)
  const limit = clampLimit(options.limit)
  const threadId = options.threadId ?? null
  const rows = options.beforeSeq != null
    ? db.prepare('SELECT * FROM messages WHERE seq IS NOT NULL AND seq < ? AND thread_id IS ? ORDER BY seq DESC LIMIT ?').all(options.beforeSeq, threadId, limit) as MessageRow[]
    : db.prepare('SELECT * FROM messages WHERE seq IS NOT NULL AND thread_id IS ? ORDER BY seq DESC LIMIT ?').all(threadId, limit) as MessageRow[]
  const ordered = rows.reverse()
  const messages = ordered.map(rowToMessage)
  const nextBeforeSeq = rows.length === limit && ordered[0]?.seq != null ? ordered[0].seq : null
  return { messages, nextBeforeSeq }
}

/** Global by design — messages.seq is one monotonic sequence shared by every scope. */
export function getMaxMessageSeq(db: Database.Database = getDb()): number {
  ensureTranscriptSchema(db)
  return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages').get() as { seq: number }).seq
}

/** `threadId` omitted/null means the main conversation — matches every current caller (epoch rollover hooks are main-only). */
export function getMessagesForRange(fromSeq: number, toSeq: number, threadId: string | null = null): TranscriptMessage[] {
  const db = getDb()
  ensureTranscriptSchema(db)
  const rows = db.prepare('SELECT * FROM messages WHERE seq >= ? AND seq <= ? AND thread_id IS ? ORDER BY seq ASC').all(fromSeq, toSeq, threadId) as MessageRow[]
  return rows.map(rowToMessage)
}

export function getSourceMessages(ids: string[]): TranscriptMessage[] {
  if (ids.length === 0) return []
  const db = getDb()
  ensureTranscriptSchema(db)
  const uniqueIds = [...new Set(ids)]
  const placeholders = uniqueIds.map(() => '?').join(',')
  const rows = db.prepare(`SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY seq ASC`).all(...uniqueIds) as MessageRow[]
  return rows.map(rowToMessage)
}

function buildFtsQuery(query: string, mode: MatchMode = 'and'): string | null {
  return buildMatchQuery(query, { maxTerms: MAX_SEARCH_TERMS, prefix: false, mode })
}

export interface SearchMessagesFilters {
  role?: TranscriptRole
  /** Filtered in SQL, before LIMIT. Post-LIMIT filtering silently discarded up to 6 of 8 result slots. */
  roles?: TranscriptRole[]
  kind?: string
  limit?: number
  /** Omitted/null means the main conversation — main history recall stays main-only so thread tangents can't dominate it. */
  threadId?: string | null
}

/**
 * Searching your own history is a RECALL operation, not a precision one. An
 * empty result teaches Bond the memory does not exist, so the AND pass falls
 * back to OR before giving up — bm25 keeps rows matching more terms on top,
 * and LIMIT bounds the noise.
 */
export function searchMessages(query: string, filters: SearchMessagesFilters = {}): TranscriptMessage[] {
  const db = getDb()
  ensureTranscriptSchema(db)
  const andQuery = buildFtsQuery(query)
  if (!andQuery) return []
  const limit = clampLimit(filters.limit, 20, MAX_SEARCH_LIMIT)
  const threadId = filters.threadId ?? null

  const run = (ftsQuery: string): TranscriptMessage[] => {
    const where: string[] = ['message_fts MATCH ?', 'm.thread_id IS ?']
    const params: unknown[] = [ftsQuery, threadId]
    if (filters.role) { where.push('m.role = ?'); params.push(filters.role) }
    if (filters.roles?.length) {
      where.push(`m.role IN (${filters.roles.map(() => '?').join(',')})`)
      params.push(...filters.roles)
    }
    if (filters.kind) { where.push('m.kind = ?'); params.push(filters.kind) }
    params.push(limit)

    const rows = db.prepare(`
      SELECT m.*
      FROM message_fts f
      JOIN messages m ON m.id = f.message_id
      WHERE ${where.join(' AND ')}
      ORDER BY bm25(message_fts), m.seq DESC
      LIMIT ?
    `).all(...params) as MessageRow[]
    return rows.map(rowToMessage)
  }

  const strict = run(andQuery)
  if (strict.length > 0) return strict
  if (countMatchTerms(query, { maxTerms: MAX_SEARCH_TERMS }) < 2) return strict
  const orQuery = buildFtsQuery(query, 'or')
  return orQuery ? run(orQuery) : strict
}

/**
 * Newest user message with real text, skipping the ones the caller owns. Used
 * to give a deictic message ("next", "on to 9") something to search with.
 * `threadId` omitted/null means the main conversation.
 */
export function getLastUserMessageText(excludeIds: string[] = [], threadId: string | null = null): string | null {
  const db = getDb()
  ensureTranscriptSchema(db)
  const placeholders = excludeIds.length ? ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : ''
  const row = db.prepare(`
    SELECT text FROM messages
    WHERE role = 'user' AND text IS NOT NULL AND trim(text) != '' AND thread_id IS ?${placeholders}
    ORDER BY seq DESC LIMIT 1
  `).get(threadId, ...excludeIds) as { text: string } | undefined
  return row?.text ?? null
}

export interface ActivitySnippet {
  seq: number | null
  snippet: string
  createdAt: string
}

/**
 * The index knows more than the transcript shows: `searchableText` indexes
 * activity events (tool inputs and outputs) up to TOOL_OUTPUT_INDEX_LIMIT.
 * Those rows are useless as conversation but excellent as evidence, so they
 * are returned as snippets rather than dropped.
 */
export function searchActivitySnippets(query: string, limit = 3, threadId: string | null = null): ActivitySnippet[] {
  const db = getDb()
  ensureTranscriptSchema(db)
  const andQuery = buildFtsQuery(query)
  if (!andQuery) return []

  const statement = db.prepare(`
    SELECT m.seq AS seq, m.created_at AS created_at,
           snippet(message_fts, 1, '', '', '…', 12) AS snippet
    FROM message_fts f
    JOIN messages m ON m.id = f.message_id
    WHERE message_fts MATCH ?
      AND m.role = 'meta'
      AND m.thread_id IS ?
    ORDER BY bm25(message_fts), m.seq DESC
    LIMIT ?
  `)
  const run = (ftsQuery: string): ActivitySnippet[] =>
    (statement.all(ftsQuery, threadId, Math.max(1, limit)) as Array<{ seq: number | null; created_at: string; snippet: string }>)
      .map(row => ({ seq: row.seq, snippet: row.snippet, createdAt: row.created_at }))

  const strict = run(andQuery)
  if (strict.length > 0) return strict
  if (countMatchTerms(query, { maxTerms: MAX_SEARCH_TERMS }) < 2) return strict
  const orQuery = buildFtsQuery(query, 'or')
  return orQuery ? run(orQuery) : strict
}
