import type { SessionDebrief } from '../shared/sense'
import { getDb } from './db'

function parseJsonArray(val: unknown): string[] {
  if (typeof val !== 'string') return []
  try {
    const parsed = JSON.parse(val)
    return Array.isArray(parsed) ? parsed.filter(i => typeof i === 'string') : []
  } catch {
    return []
  }
}

function rowToDebrief(row: Record<string, unknown>): SessionDebrief {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    sessionTitle: row.session_title as string,
    projectId: (row.project_id as string) || null,
    summary: row.summary as string,
    topics: parseJsonArray(row.topics),
    // Legacy columns are preserved in SQLite and compatibility types, but no active
    // UI/API/prompt path uses these concepts anymore.
    decisions: parseJsonArray(row.decisions),
    openThreads: parseJsonArray(row.open_threads),
    keyFacts: parseJsonArray(row.key_facts),
    messageCount: row.message_count as number,
    durationSeconds: row.duration_seconds as number,
    createdAt: row.created_at as string,
  }
}

export function getDebrief(id: string): SessionDebrief | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM sense_debriefs WHERE id = ?').get(id)
  return row ? rowToDebrief(row as Record<string, unknown>) : null
}

export function getDebriefBySession(sessionId: string): SessionDebrief | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM sense_debriefs WHERE session_id = ?').get(sessionId)
  return row ? rowToDebrief(row as Record<string, unknown>) : null
}

export function deleteDebrief(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM sense_debriefs WHERE id = ?').run(id)
  return result.changes > 0
}

export function listDebriefs(options?: {
  projectId?: string
  limit?: number
  since?: string
}): SessionDebrief[] {
  const db = getDb()
  let sql = 'SELECT * FROM sense_debriefs WHERE 1=1'
  const params: (string | number)[] = []

  if (options?.projectId) {
    sql += ' AND project_id = ?'
    params.push(options.projectId)
  }
  if (options?.since) {
    sql += ' AND created_at >= ?'
    params.push(options.since)
  }

  sql += ' ORDER BY created_at DESC'

  if (options?.limit) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(rowToDebrief)
}

export function searchDebriefs(query: string, limit = 20): SessionDebrief[] {
  const db = getDb()
  const like = `%${query}%`
  const rows = db.prepare(`
    SELECT * FROM sense_debriefs
    WHERE summary LIKE ? OR topics_text LIKE ? OR session_title LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(like, like, like, limit) as Record<string, unknown>[]
  return rows.map(rowToDebrief)
}
