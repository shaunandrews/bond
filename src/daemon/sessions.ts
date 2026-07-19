import type { Session, SessionMessage, EditMode } from '../shared/session'
import { DEFAULT_EDIT_MODE, parseEditMode } from '../shared/session'
import { getDb } from './db'
import { deleteSessionImages } from './images'

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    title: row.title as string,
    summary: row.summary as string,
    archived: row.archived === 1,
    favorited: row.favorited === 1,
    quick: row.quick === 1 ? true : undefined,
    iconSeed: row.icon_seed != null ? (row.icon_seed as number) : undefined,
    editMode: parseEditMode(row.edit_mode),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function rowToMessage(row: Record<string, unknown>): SessionMessage {
  const msg: SessionMessage = {
    id: row.id as string,
    role: row.role as string
  }
  if (row.text != null) msg.text = row.text as string
  if (row.streaming != null) msg.streaming = row.streaming === 1
  if (row.kind != null) msg.kind = row.kind as string
  if (row.name != null) msg.name = row.name as string
  if (row.summary != null) msg.summary = row.summary as string
  if (row.status != null) msg.status = row.status as string
  if (row.images != null) {
    try {
      const parsed = JSON.parse(row.images as string)
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (typeof parsed[0] === 'string') {
          msg.imageIds = parsed
        } else {
          msg.images = parsed
        }
      }
    } catch { /* ignore */ }
  }
  if (row.data != null) {
    try {
      const parsed = JSON.parse(row.data as string)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) msg.data = parsed as Record<string, unknown>
    } catch { /* ignore */ }
  }
  return msg
}

// --- Public API ---

export function listSessions(): Session[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all()
  return rows.map(r => rowToSession(r as Record<string, unknown>))
}

export function createSession(options?: { title?: string }): Session {
  const db = getDb()
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const title = options?.title ?? 'New chat'

  db.prepare(
    'INSERT INTO sessions (id, title, summary, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, title, '', 0, now, now)

  return { id, title, summary: '', archived: false, favorited: false, editMode: DEFAULT_EDIT_MODE, createdAt: now, updatedAt: now }
}

/** Stable owner for images attached to the continuous transcript (which has no per-session id). */
export const GLOBAL_TRANSCRIPT_SESSION_ID = 'global-transcript'

/**
 * The continuous transcript is not a per-session chat, but `images.session_id`
 * is still a NOT NULL foreign key onto `sessions(id)`. Ensure a stable owner row
 * exists so attaching an image to the transcript can't violate that constraint.
 */
export function ensureGlobalTranscriptSession(): void {
  const now = new Date().toISOString()
  getDb().prepare(
    "INSERT OR IGNORE INTO sessions (id, title, summary, archived, created_at, updated_at) VALUES (?, 'Continuous transcript', '', 0, ?, ?)"
  ).run(GLOBAL_TRANSCRIPT_SESSION_ID, now, now)
}

export function getSession(id: string): Session | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
  return row ? rowToSession(row as Record<string, unknown>) : null
}

export function updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived' | 'favorited' | 'quick' | 'iconSeed' | 'editMode'>>): Session | null {
  const db = getDb()
  const now = new Date().toISOString()

  const sets: string[] = ['updated_at = ?']
  const values: unknown[] = [now]

  if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title) }
  if (updates.summary !== undefined) { sets.push('summary = ?'); values.push(updates.summary) }
  if (updates.archived !== undefined) { sets.push('archived = ?'); values.push(updates.archived ? 1 : 0) }
  if (updates.favorited !== undefined) { sets.push('favorited = ?'); values.push(updates.favorited ? 1 : 0) }
  if (updates.quick !== undefined) { sets.push('quick = ?'); values.push(updates.quick ? 1 : 0) }
  if (updates.iconSeed !== undefined) { sets.push('icon_seed = ?'); values.push(updates.iconSeed ?? null) }
  if (updates.editMode !== undefined) { sets.push('edit_mode = ?'); values.push(JSON.stringify(updates.editMode)) }

  values.push(id)
  const result = db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values)

  if (result.changes === 0) return null
  return getSession(id)
}

export function deleteSession(id: string): boolean {
  // Delete image files before removing the session (CASCADE handles DB rows)
  deleteSessionImages(id)
  const db = getDb()
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  return result.changes > 0
}

export function deleteArchivedSessions(): number {
  const db = getDb()
  const archived = db.prepare('SELECT id FROM sessions WHERE archived = 1').all() as { id: string }[]
  for (const row of archived) {
    deleteSessionImages(row.id)
  }
  const result = db.prepare('DELETE FROM sessions WHERE archived = 1').run()
  return result.changes
}

export function getMessages(sessionId: string): SessionMessage[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY position').all(sessionId)
  return rows.map(r => rowToMessage(r as Record<string, unknown>))
}

export function saveMessages(sessionId: string, messages: SessionMessage[]): boolean {
  const db = getDb()

  // Verify session exists
  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)
  if (!session) return false

  // Guard: never overwrite with an empty array.
  // Prevents crash-induced empty renderer state from destroying conversation history.
  // Normal churn (thinking messages created/removed, tools collapsed) is allowed —
  // the real protection against data loss is the always-stash + background-buffer-first
  // persist logic in useChat.ts, not this guard.
  if (messages.length === 0) {
    const existing = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(sessionId) as { count: number }
    if (existing.count > 0) {
      console.warn(`[bond] saveMessages blocked: refusing empty save for session ${sessionId} (${existing.count} existing)`)
      return false
    }
  }

  const now = new Date().toISOString()

  const save = db.transaction(() => {
    // Collect current message IDs so we can remove stale ones
    const incomingIds = new Set(messages.map(m => m.id))

    // Remove messages that are no longer in the array (e.g. filtered empty thinking)
    const existingIds = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(sessionId) as { id: string }[]
    const staleIds = existingIds.filter(r => !incomingIds.has(r.id)).map(r => r.id)
    if (staleIds.length > 0) {
      const placeholders = staleIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...staleIds)
    }

    // Upsert each message — INSERT if new, UPDATE if changed
    const upsert = db.prepare(`
      INSERT INTO messages (id, session_id, position, role, text, streaming, kind, name, summary, status, images, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        position = excluded.position,
        text = excluded.text,
        streaming = excluded.streaming,
        summary = excluded.summary,
        status = excluded.status,
        images = excluded.images,
        data = excluded.data,
        updated_at = excluded.updated_at
    `)

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      upsert.run(
        m.id, sessionId, i, m.role,
        m.text ?? null,
        m.streaming ? 1 : null,
        m.kind ?? null,
        m.name ?? null,
        m.summary ?? null,
        m.status ?? null,
        m.imageIds?.length ? JSON.stringify(m.imageIds) : m.images?.length ? JSON.stringify(m.images) : null,
        m.data ? JSON.stringify(m.data) : null,
        now
      )
    }

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
  })

  save()
  return true
}

