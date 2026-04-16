import { randomUUID } from 'node:crypto'
import type { SessionDebrief, SenseFact } from '../shared/sense'
import { getDb } from './db'

// --- Debrief helpers ---

function flattenForFts(arr: string[]): string {
  return arr.join(' ')
}

function rowToDebrief(row: Record<string, unknown>): SessionDebrief {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    sessionTitle: row.session_title as string,
    projectId: (row.project_id as string) || null,
    summary: row.summary as string,
    topics: parseJsonArray(row.topics),
    decisions: parseJsonArray(row.decisions),
    openThreads: parseJsonArray(row.open_threads),
    keyFacts: parseJsonArray(row.key_facts),
    messageCount: row.message_count as number,
    durationSeconds: row.duration_seconds as number,
    createdAt: row.created_at as string,
  }
}

function parseJsonArray(val: unknown): string[] {
  if (typeof val !== 'string') return []
  try {
    const parsed = JSON.parse(val)
    return Array.isArray(parsed) ? parsed.filter(i => typeof i === 'string') : []
  } catch {
    return []
  }
}

function rowToFact(row: Record<string, unknown>): SenseFact {
  return {
    id: row.id as string,
    fact: row.fact as string,
    source: row.source as 'user' | 'debrief',
    sourceDebriefId: (row.source_debrief_id as string) || null,
    projectId: (row.project_id as string) || null,
    active: row.active === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

// --- Debrief CRUD ---

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
  try {
    const rows = db.prepare(`
      SELECT d.* FROM sense_debriefs_fts f
      JOIN sense_debriefs d ON d.rowid = f.rowid
      WHERE sense_debriefs_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Record<string, unknown>[]
    return rows.map(rowToDebrief)
  } catch {
    // FTS query syntax error — fall back to LIKE
    const like = `%${query}%`
    const rows = db.prepare(`
      SELECT * FROM sense_debriefs
      WHERE summary LIKE ? OR topics_text LIKE ? OR decisions_text LIKE ?
        OR open_threads_text LIKE ? OR key_facts_text LIKE ? OR session_title LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(like, like, like, like, like, like, limit) as Record<string, unknown>[]
    return rows.map(rowToDebrief)
  }
}

/**
 * Get deduplicated open threads from recent debriefs.
 * Threads older than 5 days are excluded from auto-injection (but remain searchable).
 */
export function getRecentOpenThreads(options?: {
  limit?: number
  projectId?: string
  excludeResolved?: boolean
}): string[] {
  const db = getDb()
  const limit = options?.limit ?? 10
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()

  let sql = 'SELECT open_threads, decisions FROM sense_debriefs WHERE created_at >= ?'
  const params: (string | number)[] = [fiveDaysAgo]

  if (options?.projectId) {
    sql += ' AND project_id = ?'
    params.push(options.projectId)
  }

  sql += ' ORDER BY created_at DESC LIMIT 20'

  const rows = db.prepare(sql).all(...params) as { open_threads: string; decisions: string }[]

  // Collect all threads and all decisions
  const allThreads: string[] = []
  const allDecisions: string[] = []

  for (const row of rows) {
    allThreads.push(...parseJsonArray(row.open_threads))
    allDecisions.push(...parseJsonArray(row.decisions))
  }

  // Deduplicate threads by normalized form
  const seen = new Set<string>()
  const unique: string[] = []

  for (const thread of allThreads) {
    const normalized = thread.toLowerCase().trim()
    if (seen.has(normalized)) continue
    seen.add(normalized)

    // Resolution heuristic: if a thread's key phrase appears in a decision, skip it
    if (options?.excludeResolved) {
      const resolved = allDecisions.some(d =>
        d.toLowerCase().includes(normalized.slice(0, 40))
      )
      if (resolved) continue
    }

    unique.push(thread)
    if (unique.length >= limit) break
  }

  return unique
}

/**
 * Get recent decisions with session context.
 */
export function getRecentDecisions(options?: {
  limit?: number
  projectId?: string
}): { decision: string; debriefId: string; sessionTitle: string; createdAt: string }[] {
  const db = getDb()
  const limit = options?.limit ?? 10

  let sql = 'SELECT id, decisions, session_title, created_at FROM sense_debriefs WHERE 1=1'
  const params: (string | number)[] = []

  if (options?.projectId) {
    sql += ' AND project_id = ?'
    params.push(options.projectId)
  }

  sql += ' ORDER BY created_at DESC LIMIT 10'

  const rows = db.prepare(sql).all(...params) as { id: string; decisions: string; session_title: string; created_at: string }[]

  const results: { decision: string; debriefId: string; sessionTitle: string; createdAt: string }[] = []

  for (const row of rows) {
    const decisions = parseJsonArray(row.decisions)
    for (const d of decisions) {
      results.push({
        decision: d,
        debriefId: row.id,
        sessionTitle: row.session_title,
        createdAt: row.created_at,
      })
      if (results.length >= limit) return results
    }
  }

  return results
}

// --- Facts CRUD ---

export function createFact(fact: string, options?: { projectId?: string; source?: 'user' | 'debrief'; sourceDebriefId?: string }): SenseFact {
  const db = getDb()
  const now = new Date().toISOString()
  const id = randomUUID()

  db.prepare(`
    INSERT INTO sense_facts (id, fact, source, source_debrief_id, project_id, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id, fact,
    options?.source ?? 'user',
    options?.sourceDebriefId ?? null,
    options?.projectId ?? null,
    now, now
  )

  return {
    id,
    fact,
    source: options?.source ?? 'user',
    sourceDebriefId: options?.sourceDebriefId ?? null,
    projectId: options?.projectId ?? null,
    active: true,
    createdAt: now,
    updatedAt: now,
  }
}

export function getActiveFacts(options?: { projectId?: string; limit?: number }): SenseFact[] {
  const db = getDb()
  let sql = 'SELECT * FROM sense_facts WHERE active = 1'
  const params: (string | number)[] = []

  if (options?.projectId) {
    sql += ' AND (project_id = ? OR project_id IS NULL)'
    params.push(options.projectId)
  }

  sql += ' ORDER BY created_at DESC'

  if (options?.limit) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(rowToFact)
}

export function listFacts(options?: { active?: boolean; projectId?: string }): SenseFact[] {
  const db = getDb()
  let sql = 'SELECT * FROM sense_facts WHERE 1=1'
  const params: (string | number)[] = []

  if (options?.active !== undefined) {
    sql += ' AND active = ?'
    params.push(options.active ? 1 : 0)
  }
  if (options?.projectId) {
    sql += ' AND project_id = ?'
    params.push(options.projectId)
  }

  sql += ' ORDER BY created_at DESC'

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(rowToFact)
}

export function deactivateFact(id: string): boolean {
  const db = getDb()
  const now = new Date().toISOString()
  const result = db.prepare('UPDATE sense_facts SET active = 0, updated_at = ? WHERE id = ?').run(now, id)
  return result.changes > 0
}

export function updateFact(id: string, fact: string): SenseFact | null {
  const db = getDb()
  const now = new Date().toISOString()
  const result = db.prepare('UPDATE sense_facts SET fact = ?, updated_at = ? WHERE id = ?').run(fact, now, id)
  if (result.changes === 0) return null
  const row = db.prepare('SELECT * FROM sense_facts WHERE id = ?').get(id)
  return row ? rowToFact(row as Record<string, unknown>) : null
}

/**
 * Remove a thread from a debrief's open_threads array by matching text.
 */
export function removeDebriefThread(debriefId: string, thread: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT open_threads, open_threads_text FROM sense_debriefs WHERE id = ?').get(debriefId) as { open_threads: string; open_threads_text: string } | undefined
  if (!row) return false

  const threads = parseJsonArray(row.open_threads)
  const filtered = threads.filter(t => t !== thread)
  if (filtered.length === threads.length) return false

  db.prepare('UPDATE sense_debriefs SET open_threads = ?, open_threads_text = ? WHERE id = ?')
    .run(JSON.stringify(filtered), filtered.join(' '), debriefId)
  return true
}

/**
 * Remove a decision from a debrief's decisions array by matching text.
 */
export function removeDebriefDecision(debriefId: string, decision: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT decisions, decisions_text FROM sense_debriefs WHERE id = ?').get(debriefId) as { decisions: string; decisions_text: string } | undefined
  if (!row) return false

  const decisions = parseJsonArray(row.decisions)
  const filtered = decisions.filter(d => d !== decision)
  if (filtered.length === decisions.length) return false

  db.prepare('UPDATE sense_debriefs SET decisions = ?, decisions_text = ? WHERE id = ?')
    .run(JSON.stringify(filtered), filtered.join(' '), debriefId)
  return true
}

/**
 * Get deduplicated open threads with session context for the UI.
 * Same logic as getRecentOpenThreads but returns enriched objects.
 */
export function getRecentOpenThreadsEnriched(options?: {
  limit?: number
  projectId?: string
  excludeResolved?: boolean
}): { thread: string; debriefId: string; sessionId: string; sessionTitle: string; createdAt: string }[] {
  const db = getDb()
  const limit = options?.limit ?? 10
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()

  let sql = 'SELECT id, open_threads, decisions, session_id, session_title, created_at FROM sense_debriefs WHERE created_at >= ?'
  const params: (string | number)[] = [fiveDaysAgo]

  if (options?.projectId) {
    sql += ' AND project_id = ?'
    params.push(options.projectId)
  }

  sql += ' ORDER BY created_at DESC LIMIT 20'

  const rows = db.prepare(sql).all(...params) as {
    id: string; open_threads: string; decisions: string
    session_id: string; session_title: string; created_at: string
  }[]

  const allDecisions: string[] = []
  const allThreadEntries: { thread: string; debriefId: string; sessionId: string; sessionTitle: string; createdAt: string }[] = []

  for (const row of rows) {
    allDecisions.push(...parseJsonArray(row.decisions))
    for (const thread of parseJsonArray(row.open_threads)) {
      allThreadEntries.push({
        thread,
        debriefId: row.id,
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        createdAt: row.created_at,
      })
    }
  }

  const seen = new Set<string>()
  const unique: typeof allThreadEntries = []

  for (const entry of allThreadEntries) {
    const normalized = entry.thread.toLowerCase().trim()
    if (seen.has(normalized)) continue
    seen.add(normalized)

    if (options?.excludeResolved) {
      const resolved = allDecisions.some(d =>
        d.toLowerCase().includes(normalized.slice(0, 40))
      )
      if (resolved) continue
    }

    unique.push(entry)
    if (unique.length >= limit) break
  }

  return unique
}

export function searchFacts(query: string): SenseFact[] {
  const db = getDb()
  const rows = db.prepare(
    "SELECT * FROM sense_facts WHERE active = 1 AND fact LIKE '%' || ? || '%' ORDER BY created_at DESC"
  ).all(query) as Record<string, unknown>[]
  return rows.map(rowToFact)
}
