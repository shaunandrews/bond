import type { Session, SessionMessage, EditMode } from '../shared/session'
import { DEFAULT_EDIT_MODE } from '../shared/session'
import { getDb } from './db'
import { deleteSessionImages } from './images'

function parseEditMode(raw: unknown): EditMode {
  if (typeof raw !== 'string') return DEFAULT_EDIT_MODE
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.type === 'readonly') return { type: 'readonly' }
    if (parsed?.type === 'scoped' && Array.isArray(parsed.allowedPaths)) {
      return { type: 'scoped', allowedPaths: parsed.allowedPaths }
    }
    return DEFAULT_EDIT_MODE
  } catch {
    return DEFAULT_EDIT_MODE
  }
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    title: row.title as string,
    summary: row.summary as string,
    archived: row.archived === 1,
    favorited: row.favorited === 1,
    iconSeed: row.icon_seed != null ? (row.icon_seed as number) : undefined,
    editMode: parseEditMode(row.edit_mode),
    projectId: (row.project_id as string) || undefined,
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
  return msg
}

// --- Public API ---

export function listSessions(): Session[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all()
  return rows.map(r => rowToSession(r as Record<string, unknown>))
}

export function createSession(options?: { title?: string; projectId?: string }): Session {
  const db = getDb()
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const title = options?.title ?? 'New chat'
  const projectId = options?.projectId ?? null

  db.prepare(
    'INSERT INTO sessions (id, title, summary, archived, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, title, '', 0, projectId, now, now)

  return { id, title, summary: '', archived: false, favorited: false, editMode: DEFAULT_EDIT_MODE, projectId: projectId || undefined, createdAt: now, updatedAt: now }
}

export function getSession(id: string): Session | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
  return row ? rowToSession(row as Record<string, unknown>) : null
}

export function updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived' | 'favorited' | 'iconSeed' | 'editMode' | 'projectId'>>): Session | null {
  const db = getDb()
  const now = new Date().toISOString()

  const sets: string[] = ['updated_at = ?']
  const values: unknown[] = [now]

  if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title) }
  if (updates.summary !== undefined) { sets.push('summary = ?'); values.push(updates.summary) }
  if (updates.archived !== undefined) { sets.push('archived = ?'); values.push(updates.archived ? 1 : 0) }
  if (updates.favorited !== undefined) { sets.push('favorited = ?'); values.push(updates.favorited ? 1 : 0) }
  if (updates.iconSeed !== undefined) { sets.push('icon_seed = ?'); values.push(updates.iconSeed ?? null) }
  if (updates.editMode !== undefined) { sets.push('edit_mode = ?'); values.push(JSON.stringify(updates.editMode)) }
  if (updates.projectId !== undefined) { sets.push('project_id = ?'); values.push(updates.projectId || null) }

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

  // Guard: never overwrite with significantly fewer messages.
  // Prevents crash-induced partial renderer state from destroying conversation history.
  // Small reductions (filtered empty thinking messages) are OK; catastrophic ones are blocked.
  if (messages.length > 0) {
    const existing = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(sessionId) as { count: number }
    const loss = existing.count - messages.length
    if (loss > 5) {
      console.warn(`[bond] saveMessages blocked: would lose ${loss} messages (${messages.length} < ${existing.count}) for session ${sessionId}`)
      return false
    }
  }

  const save = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)

    const insert = db.prepare(
      'INSERT INTO messages (id, session_id, position, role, text, streaming, kind, name, summary, status, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      insert.run(
        m.id, sessionId, i, m.role,
        m.text ?? null,
        m.streaming ? 1 : null,
        m.kind ?? null,
        m.name ?? null,
        m.summary ?? null,
        m.status ?? null,
        m.imageIds?.length ? JSON.stringify(m.imageIds) : m.images?.length ? JSON.stringify(m.images) : null
      )
    }

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId)
  })

  save()
  return true
}
