import { randomUUID } from 'node:crypto'
import type { JournalEntry, JournalComment } from '../shared/session'
import { getDb } from './db'

interface JournalEntryRow {
  id: string
  author: string
  title: string
  body: string
  tags: string
  project_id: string | null
  session_id: string | null
  pinned: number
  created_at: string
  updated_at: string
}

function rowToEntry(r: JournalEntryRow, comments: JournalComment[] = []): JournalEntry {
  let tags: string[] = []
  try { tags = JSON.parse(r.tags) } catch { /* default empty */ }
  return {
    id: r.id,
    author: r.author as 'user' | 'bond',
    title: r.title,
    body: r.body,
    tags,
    projectId: r.project_id || undefined,
    sessionId: r.session_id || undefined,
    pinned: r.pinned === 1,
    comments,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

interface JournalCommentRow {
  id: string
  entry_id: string
  author: string
  body: string
  created_at: string
}

function rowToComment(r: JournalCommentRow): JournalComment {
  return {
    id: r.id,
    entryId: r.entry_id,
    author: r.author as 'user' | 'bond',
    body: r.body,
    createdAt: r.created_at
  }
}

function getCommentsForEntry(db: ReturnType<typeof getDb>, entryId: string): JournalComment[] {
  const rows = db.prepare(
    'SELECT id, entry_id, author, body, created_at FROM journal_comments WHERE entry_id = ? ORDER BY created_at ASC'
  ).all(entryId) as JournalCommentRow[]
  return rows.map(rowToComment)
}

const ENTRY_COLS = 'id, author, title, body, tags, project_id, session_id, pinned, created_at, updated_at'

export function listEntries(opts?: {
  author?: string
  projectId?: string
  tag?: string
  limit?: number
  offset?: number
}): JournalEntry[] {
  const db = getDb()
  const where: string[] = []
  const values: unknown[] = []

  if (opts?.author) { where.push('author = ?'); values.push(opts.author) }
  if (opts?.projectId) { where.push('project_id = ?'); values.push(opts.projectId) }
  if (opts?.tag) { where.push("json_each.value = ?"); }

  let sql: string
  if (opts?.tag) {
    sql = `SELECT ${ENTRY_COLS} FROM journal_entries, json_each(journal_entries.tags)`
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`
    values.push(opts.tag)
    // Deduplicate in case an entry has multiple matching tags
    sql = `SELECT DISTINCT ${ENTRY_COLS} FROM (${sql}) ORDER BY pinned DESC, created_at DESC`
  } else {
    sql = `SELECT ${ENTRY_COLS} FROM journal_entries`
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY pinned DESC, created_at DESC'
  }

  if (opts?.limit) { sql += ' LIMIT ?'; values.push(opts.limit) }
  if (opts?.offset) { sql += ' OFFSET ?'; values.push(opts.offset) }

  const rows = db.prepare(sql).all(...values) as JournalEntryRow[]
  return rows.map(rowToEntry)
}

export function getEntry(id: string): JournalEntry | null {
  const db = getDb()
  const row = db.prepare(`SELECT ${ENTRY_COLS} FROM journal_entries WHERE id = ?`).get(id) as JournalEntryRow | undefined
  if (!row) return null
  const comments = getCommentsForEntry(db, id)
  return rowToEntry(row, comments)
}

export function createEntry(params: {
  author: 'user' | 'bond'
  title: string
  body: string
  tags?: string[]
  projectId?: string
  sessionId?: string
}): JournalEntry {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const tags = JSON.stringify(params.tags ?? [])

  db.prepare(
    'INSERT INTO journal_entries (id, author, title, body, tags, project_id, session_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
  ).run(id, params.author, params.title, params.body, tags, params.projectId ?? null, params.sessionId ?? null, now, now)

  return {
    id,
    author: params.author,
    title: params.title,
    body: params.body,
    tags: params.tags ?? [],
    projectId: params.projectId || undefined,
    sessionId: params.sessionId || undefined,
    pinned: false,
    createdAt: now,
    updatedAt: now
  }
}

export function updateEntry(
  id: string,
  updates: Partial<Pick<JournalEntry, 'title' | 'body' | 'tags' | 'pinned' | 'projectId'>>
): JournalEntry | null {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title) }
  if (updates.body !== undefined) { sets.push('body = ?'); values.push(updates.body) }
  if (updates.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(updates.tags)) }
  if (updates.pinned !== undefined) { sets.push('pinned = ?'); values.push(updates.pinned ? 1 : 0) }
  if (updates.projectId !== undefined) { sets.push('project_id = ?'); values.push(updates.projectId || null) }
  if (sets.length === 0) return null

  const now = new Date().toISOString()
  sets.push('updated_at = ?')
  values.push(now)
  values.push(id)

  db.prepare(`UPDATE journal_entries SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  const row = db.prepare(`SELECT ${ENTRY_COLS} FROM journal_entries WHERE id = ?`).get(id) as JournalEntryRow | undefined
  return row ? rowToEntry(row) : null
}

export function deleteEntry(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM journal_entries WHERE id = ?').run(id)
  return result.changes > 0
}

export function searchEntries(query: string): JournalEntry[] {
  const db = getDb()
  const pattern = `%${query}%`
  const rows = db.prepare(
    `SELECT ${ENTRY_COLS} FROM journal_entries WHERE title LIKE ? OR body LIKE ? ORDER BY pinned DESC, created_at DESC`
  ).all(pattern, pattern) as JournalEntryRow[]
  return rows.map(r => rowToEntry(r))
}

// --- Comments ---

export function addComment(entryId: string, author: 'user' | 'bond', body: string): JournalComment {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO journal_comments (id, entry_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, entryId, author, body, now)
  // Touch the parent entry's updated_at
  db.prepare('UPDATE journal_entries SET updated_at = ? WHERE id = ?').run(now, entryId)
  return { id, entryId, author, body, createdAt: now }
}

export function deleteComment(commentId: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM journal_comments WHERE id = ?').run(commentId)
  return result.changes > 0
}
