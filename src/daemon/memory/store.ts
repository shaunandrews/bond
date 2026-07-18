import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import { MEMORY_CAPS, type MemoryItem, type MemoryItemInput, type RetrievedMemory } from './types'
import { validateMemoryItem, validateMemoryItemInput } from './parser'

interface MemoryItemRow {
  id: string
  kind: string
  text: string
  source: string
  project_id: string | null
  tags: string
  confidence: number
  active: number
  created_at: string
  updated_at: string
}

interface SearchRow extends MemoryItemRow {
  score: number
}

const COLS = 'id, kind, text, source, project_id, tags, confidence, active, created_at, updated_at'

export function ensureMemorySchema(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      project_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_items_active ON memory_items(active, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_project ON memory_items(project_id, active, updated_at DESC);
  `)

  const hasFts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items_fts'").get()
  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE memory_items_fts USING fts5(
        text,
        tags_text,
        content=memory_items,
        content_rowid=rowid
      );

      CREATE TRIGGER memory_items_fts_insert AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_items_fts(rowid, text, tags_text)
        VALUES (NEW.rowid, NEW.text, NEW.tags);
      END;

      CREATE TRIGGER memory_items_fts_delete AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, text, tags_text)
        VALUES ('delete', OLD.rowid, OLD.text, OLD.tags);
      END;

      CREATE TRIGGER memory_items_fts_update AFTER UPDATE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, text, tags_text)
        VALUES ('delete', OLD.rowid, OLD.text, OLD.tags);
        INSERT INTO memory_items_fts(rowid, text, tags_text)
        VALUES (NEW.rowid, NEW.text, NEW.tags);
      END;
    `)
  }
}

function rowToItem(row: MemoryItemRow): MemoryItem {
  const parsed = validateMemoryItem({
    id: row.id,
    kind: row.kind,
    text: row.text,
    source: row.source,
    projectId: row.project_id,
    tags: parseTags(row.tags),
    confidence: row.confidence,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
  if (!parsed.ok) throw new Error(`Invalid memory row ${row.id}: ${parsed.errors.join('; ')}`)
  return parsed.value
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function buildFtsQuery(input: string, maxTerms = MEMORY_CAPS.queryTerms): string | null {
  const terms = input
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.map(term => term.replace(/^-+|-+$/g, '').slice(0, 64))
    .filter(Boolean) ?? []

  const unique: string[] = []
  const seen = new Set<string>()
  for (const term of terms) {
    if (seen.has(term)) continue
    seen.add(term)
    unique.push(term)
    if (unique.length >= maxTerms) break
  }

  if (unique.length === 0) return null
  return unique.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

export function upsertMemoryItem(input: MemoryItemInput, db: Database.Database = getDb()): MemoryItem {
  ensureMemorySchema(db)
  const parsed = validateMemoryItemInput(input)
  if (!parsed.ok) throw new Error(`Invalid memory item: ${parsed.errors.join('; ')}`)

  const now = new Date().toISOString()
  const item: MemoryItem = {
    id: parsed.value.id ?? randomUUID(),
    kind: parsed.value.kind ?? 'fact',
    text: parsed.value.text,
    source: parsed.value.source ?? 'assistant',
    projectId: parsed.value.projectId ?? null,
    tags: parsed.value.tags ?? [],
    confidence: parsed.value.confidence ?? 1,
    active: parsed.value.active ?? true,
    createdAt: parsed.value.createdAt ?? now,
    updatedAt: parsed.value.updatedAt ?? now,
  }

  db.prepare(`
    INSERT INTO memory_items (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      text = excluded.text,
      source = excluded.source,
      project_id = excluded.project_id,
      tags = excluded.tags,
      confidence = excluded.confidence,
      active = excluded.active,
      updated_at = excluded.updated_at
  `).run(
    item.id,
    item.kind,
    item.text,
    item.source,
    item.projectId,
    JSON.stringify(item.tags),
    item.confidence,
    item.active ? 1 : 0,
    item.createdAt,
    item.updatedAt,
  )

  return item
}

export function getMemoryItem(id: string, db: Database.Database = getDb()): MemoryItem | null {
  ensureMemorySchema(db)
  const row = db.prepare(`SELECT ${COLS} FROM memory_items WHERE id = ?`).get(id) as MemoryItemRow | undefined
  return row ? rowToItem(row) : null
}

export function searchMemory(query: string, options: { projectId?: string | null; limit?: number } = {}, db: Database.Database = getDb()): RetrievedMemory[] {
  ensureMemorySchema(db)
  const limit = Math.max(1, Math.min(MEMORY_CAPS.searchLimit, Math.floor(options.limit ?? 8)))
  const match = buildFtsQuery(query)
  if (!match) return listRecentMemory({ projectId: options.projectId, limit }, db).map(item => ({ item, score: 0 }))

  const projectFilter = options.projectId === undefined ? '' : 'AND m.project_id IS ?'
  const params: unknown[] = [match]
  if (options.projectId !== undefined) params.push(options.projectId)
  params.push(limit)

  const rows = db.prepare(`
    SELECT m.${COLS.replaceAll(', ', ', m.')}, bm25(memory_items_fts) AS score
    FROM memory_items_fts f
    JOIN memory_items m ON m.rowid = f.rowid
    WHERE memory_items_fts MATCH ?
      AND m.active = 1
      ${projectFilter}
    ORDER BY score ASC, m.updated_at DESC
    LIMIT ?
  `).all(...params) as SearchRow[]

  return rows.map(row => ({ item: rowToItem(row), score: row.score }))
}

export function listRecentMemory(options: { projectId?: string | null; limit?: number } = {}, db: Database.Database = getDb()): MemoryItem[] {
  ensureMemorySchema(db)
  const limit = Math.max(1, Math.min(MEMORY_CAPS.searchLimit, Math.floor(options.limit ?? 8)))
  const projectFilter = options.projectId === undefined ? '' : 'AND project_id IS ?'
  const params: unknown[] = []
  if (options.projectId !== undefined) params.push(options.projectId)
  params.push(limit)

  const rows = db.prepare(`
    SELECT ${COLS} FROM memory_items
    WHERE active = 1
      ${projectFilter}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params) as MemoryItemRow[]
  return rows.map(rowToItem)
}
