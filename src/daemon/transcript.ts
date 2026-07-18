import type Database from 'better-sqlite3'
import { getDb } from './db'
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

export function ensureTranscriptSchema(db = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS epochs (
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
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_epoch ON epochs(status) WHERE status = 'active';
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      epoch_id TEXT REFERENCES epochs(id),
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
    CREATE INDEX IF NOT EXISTS idx_turns_epoch ON turns(epoch_id, started_at);
  `)

  ensureMessagesTableShape(db)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_cursor ON messages(seq DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_epoch ON messages(epoch_id, seq);
    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      message_id UNINDEXED,
      text,
      kind UNINDEXED,
      tokenize='unicode61 remove_diacritics 2'
    );
  `)
}

function ensureMessagesTableShape(db: Database.Database): void {
  const cols = db.pragma('table_info(messages)') as Array<{ name: string; notnull: number }>
  const byName = new Map(cols.map(c => [c.name, c]))
  const needsRebuild = cols.length === 0 || byName.get('session_id')?.notnull === 1 || byName.get('seq')?.notnull === 1

  if (needsRebuild) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages_transcript_new (
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
        seq INTEGER UNIQUE,
        image_ids TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT
      );
    `)

    if (cols.length > 0) {
      const names = new Set(cols.map(c => c.name))
      const copyCols = ['id', 'session_id', 'position', 'role', 'text', 'streaming', 'kind', 'name', 'summary', 'status', 'images', 'data', 'updated_at']
        .filter(c => names.has(c))
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

export function insertTurnStart(input: InsertTurnStartInput): void {
  const db = getDb()
  ensureTranscriptSchema(db)
  const now = input.now ?? nowIso()
  const activityData = input.activityData ?? { turnId: input.turnId, userMessageId: input.userMessageId, assistantMessageId: input.assistantMessageId, status: 'working', startedAt: Date.now(), events: [] }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO turns (id, epoch_id, user_message_id, assistant_message_id, activity_message_id, status, model, started_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(input.turnId, input.epochId, input.userMessageId, input.assistantMessageId, input.activityMessageId, input.model ?? null, now)

    const insert = db.prepare(`
      INSERT INTO messages (id, epoch_id, turn_id, seq, role, kind, text, data, image_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const user: TranscriptMessage = {
      id: input.userMessageId,
      epochId: input.epochId,
      turnId: input.turnId,
      seq: nextSeq(db),
      role: 'user',
      text: input.text,
      imageIds: input.imageIds,
      createdAt: now,
      updatedAt: now,
    }
    insert.run(user.id, input.epochId, input.turnId, user.seq, user.role, null, input.text, null, encodeJson(input.imageIds ?? []), now, now)
    updateMessageFts(db, user)

    const activity: TranscriptMessage = {
      id: input.activityMessageId,
      epochId: input.epochId,
      turnId: input.turnId,
      seq: nextSeq(db),
      role: 'meta',
      kind: 'activity',
      data: activityData,
      createdAt: now,
      updatedAt: now,
    }
    insert.run(activity.id, input.epochId, input.turnId, activity.seq, activity.role, activity.kind, null, encodeJson(activityData), null, now, now)
    updateMessageFts(db, activity)

    const assistant: TranscriptMessage = {
      id: input.assistantMessageId,
      epochId: input.epochId,
      turnId: input.turnId,
      seq: nextSeq(db),
      role: 'bond',
      text: '',
      createdAt: now,
      updatedAt: now,
    }
    insert.run(assistant.id, input.epochId, input.turnId, assistant.seq, assistant.role, null, '', null, null, now, now)
    updateMessageFts(db, assistant)
  })()
}

export function upsertMessages(messages: TranscriptMessage[]): void {
  if (messages.length === 0) return
  const db = getDb()
  ensureTranscriptSchema(db)
  const now = nowIso()

  db.transaction(() => {
    const existingStmt = db.prepare('SELECT * FROM messages WHERE id = ?')
    const insert = db.prepare(`
      INSERT INTO messages (id, epoch_id, turn_id, seq, role, kind, text, data, image_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const update = db.prepare(`
      UPDATE messages SET
        kind = ?, text = ?, data = ?, image_ids = ?, updated_at = ?
      WHERE id = ?
    `)

    for (const m of messages) {
      const existing = existingStmt.get(m.id) as MessageRow | undefined
      const seq = existing?.seq ?? m.seq ?? nextSeq(db)
      const createdAt = existing?.created_at ?? m.createdAt ?? now
      const epochId = existing?.epoch_id ?? m.epochId ?? null
      const turnId = existing?.turn_id ?? m.turnId ?? null
      const role = existing?.role ?? m.role
      const kind = m.kind ?? existing?.kind ?? null
      const text = m.text ?? null
      const data = m.data ?? null
      const imageIds = m.imageIds ?? parseStringArray(existing?.image_ids ?? existing?.images)

      if (existing) {
        update.run(kind, text, encodeJson(data), encodeJson(imageIds), now, m.id)
      } else {
        insert.run(m.id, epochId, turnId, seq, role, kind, text, encodeJson(data), encodeJson(imageIds), createdAt, now)
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

export function completeTurn(input: CompleteTurnInput): void {
  const db = getDb()
  ensureTranscriptSchema(db)
  const completedAt = input.completedAt ?? nowIso()
  const status: TurnStatus = input.status

  db.transaction(() => {
    const row = db.prepare('SELECT epoch_id FROM turns WHERE id = ?').get(input.turnId) as { epoch_id: string } | undefined
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
  })()
}

export function listMessages(options: { beforeSeq?: number; limit?: number } = {}): TranscriptPage {
  const db = getDb()
  ensureTranscriptSchema(db)
  const limit = clampLimit(options.limit)
  const rows = options.beforeSeq != null
    ? db.prepare('SELECT * FROM messages WHERE seq IS NOT NULL AND seq < ? ORDER BY seq DESC LIMIT ?').all(options.beforeSeq, limit) as MessageRow[]
    : db.prepare('SELECT * FROM messages WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT ?').all(limit) as MessageRow[]
  const ordered = rows.reverse()
  const messages = ordered.map(rowToMessage)
  const nextBeforeSeq = rows.length === limit && ordered[0]?.seq != null ? ordered[0].seq : null
  return { messages, nextBeforeSeq }
}

export function getMessagesForRange(fromSeq: number, toSeq: number): TranscriptMessage[] {
  const db = getDb()
  ensureTranscriptSchema(db)
  const rows = db.prepare('SELECT * FROM messages WHERE seq >= ? AND seq <= ? ORDER BY seq ASC').all(fromSeq, toSeq) as MessageRow[]
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

function buildFtsQuery(query: string): string | null {
  const terms = query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.slice(0, MAX_SEARCH_TERMS) ?? []
  if (terms.length === 0) return null
  return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' ')
}

export function searchMessages(query: string, filters: { role?: TranscriptRole; kind?: string; limit?: number } = {}): TranscriptMessage[] {
  const db = getDb()
  ensureTranscriptSchema(db)
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery) return []
  const limit = clampLimit(filters.limit, 20, MAX_SEARCH_LIMIT)
  const where: string[] = ['message_fts MATCH ?']
  const params: unknown[] = [ftsQuery]
  if (filters.role) { where.push('m.role = ?'); params.push(filters.role) }
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
