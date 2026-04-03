import { randomUUID } from 'node:crypto'
import type { Collection, CollectionItem, FieldDef } from '../shared/session'
import { getDb } from './db'

// --- Row types ---

interface CollectionRow {
  id: string
  name: string
  icon: string
  schema: string
  archived: number
  created_at: string
  updated_at: string
}

interface ItemRow {
  id: string
  collection_id: string
  data: string
  sort_order: number
  created_at: string
  updated_at: string
}

function rowToCollection(r: CollectionRow): Collection {
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    schema: JSON.parse(r.schema) as FieldDef[],
    archived: r.archived === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToItem(r: ItemRow): CollectionItem {
  return {
    id: r.id,
    collectionId: r.collection_id,
    data: JSON.parse(r.data) as Record<string, unknown>,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// --- Collection CRUD ---

const COLLECTION_COLS = 'id, name, icon, schema, archived, created_at, updated_at'
const ITEM_COLS = 'id, collection_id, data, sort_order, created_at, updated_at'

export function listCollections(): Collection[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT ${COLLECTION_COLS} FROM collections ORDER BY updated_at DESC`)
    .all() as CollectionRow[]
  return rows.map(rowToCollection)
}

export function getCollection(id: string): Collection | null {
  const db = getDb()
  const row = db
    .prepare(`SELECT ${COLLECTION_COLS} FROM collections WHERE id = ?`)
    .get(id) as CollectionRow | undefined
  return row ? rowToCollection(row) : null
}

export function createCollection(name: string, schema: FieldDef[], icon = ''): Collection {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO collections (id, name, icon, schema, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .run(id, name, icon, JSON.stringify(schema), now, now)
  return { id, name, icon, schema, archived: false, createdAt: now, updatedAt: now }
}

export function updateCollection(
  id: string,
  updates: Partial<Pick<Collection, 'name' | 'icon' | 'schema' | 'archived'>>
): Collection | null {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name) }
  if (updates.icon !== undefined) { sets.push('icon = ?'); values.push(updates.icon) }
  if (updates.schema !== undefined) { sets.push('schema = ?'); values.push(JSON.stringify(updates.schema)) }
  if (updates.archived !== undefined) { sets.push('archived = ?'); values.push(updates.archived ? 1 : 0) }
  if (sets.length === 0) return getCollection(id)

  const now = new Date().toISOString()
  sets.push('updated_at = ?')
  values.push(now)
  values.push(id)

  db.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getCollection(id)
}

export function deleteCollection(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM collections WHERE id = ?').run(id)
  return result.changes > 0
}

// --- Item CRUD ---

export function listItems(collectionId: string): CollectionItem[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT ${ITEM_COLS} FROM collection_items WHERE collection_id = ? ORDER BY sort_order ASC, created_at ASC`)
    .all(collectionId) as ItemRow[]
  return rows.map(rowToItem)
}

export function getItem(id: string): CollectionItem | null {
  const db = getDb()
  const row = db
    .prepare(`SELECT ${ITEM_COLS} FROM collection_items WHERE id = ?`)
    .get(id) as ItemRow | undefined
  return row ? rowToItem(row) : null
}

export function addItem(collectionId: string, data: Record<string, unknown>): CollectionItem {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM collection_items WHERE collection_id = ?').get(collectionId) as { m: number }).m
  const sortOrder = maxOrder + 1
  db.prepare('INSERT INTO collection_items (id, collection_id, data, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, collectionId, JSON.stringify(data), sortOrder, now, now)

  // Touch collection updated_at
  db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(now, collectionId)

  return { id, collectionId, data, sortOrder, createdAt: now, updatedAt: now }
}

export function updateItem(id: string, data: Record<string, unknown>): CollectionItem | null {
  const db = getDb()
  const now = new Date().toISOString()

  // Merge with existing data
  const existing = db.prepare(`SELECT ${ITEM_COLS} FROM collection_items WHERE id = ?`).get(id) as ItemRow | undefined
  if (!existing) return null

  const existingData = JSON.parse(existing.data) as Record<string, unknown>
  const merged = { ...existingData, ...data }

  db.prepare('UPDATE collection_items SET data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(merged), now, id)

  // Touch collection updated_at
  db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(now, existing.collection_id)

  const row = db.prepare(`SELECT ${ITEM_COLS} FROM collection_items WHERE id = ?`).get(id) as ItemRow | undefined
  return row ? rowToItem(row) : null
}

export function deleteItem(id: string): boolean {
  const db = getDb()
  // Get collection_id before delete to touch updated_at
  const row = db.prepare('SELECT collection_id FROM collection_items WHERE id = ?').get(id) as { collection_id: string } | undefined
  const result = db.prepare('DELETE FROM collection_items WHERE id = ?').run(id)
  if (result.changes > 0 && row) {
    db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), row.collection_id)
  }
  return result.changes > 0
}

export function reorderItems(orderedIds: string[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE collection_items SET sort_order = ? WHERE id = ?')
  const run = db.transaction(() => {
    orderedIds.forEach((id, i) => stmt.run(i, id))
  })
  run()
}

// --- Schema operations ---

export function renameField(collectionId: string, oldName: string, newName: string): boolean {
  const db = getDb()
  const collection = getCollection(collectionId)
  if (!collection) return false

  const fieldIdx = collection.schema.findIndex(f => f.name === oldName)
  if (fieldIdx === -1) return false

  const run = db.transaction(() => {
    // Update schema
    const newSchema = [...collection.schema]
    newSchema[fieldIdx] = { ...newSchema[fieldIdx], name: newName }
    db.prepare('UPDATE collections SET schema = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(newSchema), new Date().toISOString(), collectionId)

    // Walk items and rename the key
    const items = db.prepare('SELECT id, data FROM collection_items WHERE collection_id = ?')
      .all(collectionId) as { id: string; data: string }[]

    const updateStmt = db.prepare('UPDATE collection_items SET data = ? WHERE id = ?')
    for (const item of items) {
      const data = JSON.parse(item.data) as Record<string, unknown>
      if (oldName in data) {
        data[newName] = data[oldName]
        delete data[oldName]
        updateStmt.run(JSON.stringify(data), item.id)
      }
    }
  })

  run()
  return true
}

/** Count items in a collection */
export function countItems(collectionId: string): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) as n FROM collection_items WHERE collection_id = ?').get(collectionId) as { n: number }
  return row.n
}
