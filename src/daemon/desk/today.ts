/**
 * Today — todos *you* said you'd get to.
 *
 * Still a collection, not a bespoke task table. Desk creates one idempotent
 * collection, stores its id in the setting `desk.today_collection_id`, and
 * `desk_todo_links` provides the only structural connection to inferred work.
 * The two lists never merge: one is inferred and one is intentional, and
 * blurring that makes the inferred half feel like an accusation.
 *
 * **`issue_prefix` has no uniqueness constraint** (`collections.issue_prefix`
 * is a plain `TEXT NOT NULL DEFAULT ''`), so nothing at the database level
 * stops a second collection claiming `TODAY` — and `listReferences()` would
 * then serve two different items for the same `TODAY-n` key, breaking composer
 * autocomplete and message chips. `ensureToday` therefore RECONCILES rather
 * than assumes: look up by the stored setting id first, fall back to a prefix
 * scan, and if more than one `TODAY` collection exists adopt the one the
 * setting names (or the oldest) and clear the prefix on the others rather than
 * minting a third.
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import { getSetting, setSetting } from '../settings'
import { addItem, getCollection, listItems, updateItem } from '../collections'
import { normalizeSchema } from '../../shared/fields'
import { DESK_TODAY_COLLECTION_SETTING, DESK_TODAY_PREFIX, localDay } from '../../shared/desk'
import type { Collection, CollectionItem, FieldDefInput } from '../../shared/session'

export const TODAY_COLLECTION_NAME = 'Today'

export const TODAY_SCHEMA: FieldDefInput[] = [
  { name: 'title', type: 'text', primary: true },
  {
    name: 'status',
    type: 'status',
    options: [
      { value: 'todo', color: 'gray' },
      { value: 'in_progress', color: 'blue' },
      { value: 'done', color: 'green' },
      { value: 'cancelled', color: 'red' },
    ],
    default: 'todo',
  },
  {
    name: 'priority',
    type: 'priority',
    options: [
      { value: 'low', color: 'gray' },
      { value: 'medium', color: 'yellow' },
      { value: 'high', color: 'red' },
    ],
  },
  { name: 'day', type: 'text' },
]

export { localDay }

interface PrefixRow { id: string; created_at: string }

/**
 * Idempotent create + repair. Safe to call on every `desk.status`, on every
 * app launch, and twice in a row.
 */
export function ensureToday(db: Database.Database = getDb()): Collection {
  const settingId = getSetting(DESK_TODAY_COLLECTION_SETTING)

  const claimants = db
    .prepare("SELECT id, created_at FROM collections WHERE issue_prefix = ? ORDER BY created_at ASC")
    .all(DESK_TODAY_PREFIX) as PrefixRow[]

  // Adopt the collection the setting names; otherwise the oldest claimant.
  let adopted = settingId && claimants.some(c => c.id === settingId)
    ? settingId
    : claimants[0]?.id ?? null

  // The setting may name a collection that lost (or never had) the prefix.
  if (!adopted && settingId && getCollection(settingId)) adopted = settingId

  if (adopted) {
    // Exactly one collection may hold TODAY. Strip it from the others rather
    // than minting a third and leaving listReferences ambiguous.
    for (const claimant of claimants) {
      if (claimant.id === adopted) continue
      db.prepare("UPDATE collections SET issue_prefix = '', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), claimant.id)
    }
    repairToday(adopted, db)
    setSetting(DESK_TODAY_COLLECTION_SETTING, adopted)
    return getCollection(adopted)!
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO collections (id, name, icon, schema, features, issue_prefix, archived, created_at, updated_at)
      VALUES (?, ?, '', ?, '[]', ?, 0, ?, ?)
    `).run(id, TODAY_COLLECTION_NAME, JSON.stringify(normalizeSchema(TODAY_SCHEMA)), DESK_TODAY_PREFIX, now, now)
    setSetting(DESK_TODAY_COLLECTION_SETTING, id)
  })
  create()
  return getCollection(id)!
}

/** Re-add any schema field a user edit removed; never touches their additions. */
function repairToday(id: string, db: Database.Database): void {
  const collection = getCollection(id)
  if (!collection) return
  const present = new Set(collection.schema.map(f => f.name))
  const missing = TODAY_SCHEMA.filter(f => !present.has(f.name))
  const needsPrefix = collection.issuePrefix !== DESK_TODAY_PREFIX
  if (missing.length === 0 && !needsPrefix) return

  const repaired = normalizeSchema([...collection.schema, ...missing] as FieldDefInput[])
  db.prepare("UPDATE collections SET schema = ?, issue_prefix = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(repaired), DESK_TODAY_PREFIX, new Date().toISOString(), id)
}

function itemDay(item: CollectionItem): string | null {
  const value = (item.data as Record<string, unknown>).day
  return typeof value === 'string' && value ? value : null
}

function isUnfinished(item: CollectionItem): boolean {
  const status = (item.data as Record<string, unknown>).status
  return status !== 'done' && status !== 'cancelled'
}

/**
 * Today's items: everything whose `day` is the current local day, plus
 * unfinished items explicitly carried forward (which is the same thing —
 * carrying rewrites `day`, so nothing is silently moved).
 */
export function listToday(
  opts: { now?: Date; db?: Database.Database } = {}
): { collection: Collection; items: CollectionItem[]; day: string } {
  const db = opts.db ?? getDb()
  const collection = ensureToday(db)
  const day = localDay(opts.now ?? new Date())
  const items = listItems(collection.id).filter(item => itemDay(item) === day)
  return { collection, items, day }
}

export function addTodayItem(
  data: Record<string, unknown>,
  opts: { now?: Date; db?: Database.Database } = {}
): CollectionItem {
  const collection = ensureToday(opts.db ?? getDb())
  return addItem(collection.id, { day: localDay(opts.now ?? new Date()), ...data })
}

/**
 * Move an unfinished item to the current local day. **Never runs implicitly** —
 * midnight changes the query, not stored dates.
 */
export function carryTodo(
  itemId: string,
  opts: { now?: Date; db?: Database.Database } = {}
): CollectionItem | null {
  const db = opts.db ?? getDb()
  const collection = ensureToday(db)
  const item = listItems(collection.id).find(i => i.id === itemId)
  if (!item || !isUnfinished(item)) return null
  return updateItem(itemId, { day: localDay(opts.now ?? new Date()) })
}

// --- todo ↔ thread links ---

export interface TodoLink {
  itemId: string
  threadId: string | null
  createdAt: string
}

export function linkTodo(itemId: string, threadId: string, db: Database.Database = getDb()): TodoLink {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO desk_todo_links (item_id, thread_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET thread_id = excluded.thread_id
  `).run(itemId, threadId, now)
  return getTodoLink(itemId, db)!
}

export function unlinkTodo(itemId: string, db: Database.Database = getDb()): boolean {
  return db.prepare('DELETE FROM desk_todo_links WHERE item_id = ?').run(itemId).changes > 0
}

export function getTodoLink(itemId: string, db: Database.Database = getDb()): TodoLink | null {
  const row = db.prepare('SELECT * FROM desk_todo_links WHERE item_id = ?').get(itemId) as
    | { item_id: string; thread_id: string | null; created_at: string }
    | undefined
  return row ? { itemId: row.item_id, threadId: row.thread_id, createdAt: row.created_at } : null
}

/** Unfinished todos linked to a thread — the source of a `todo_started` Ask. */
export function unfinishedTodosForThread(
  threadId: string,
  opts: { now?: Date; db?: Database.Database } = {}
): CollectionItem[] {
  const db = opts.db ?? getDb()
  const links = db.prepare('SELECT item_id FROM desk_todo_links WHERE thread_id = ?').all(threadId) as
    { item_id: string }[]
  if (links.length === 0) return []
  const ids = new Set(links.map(l => l.item_id))
  const { items } = listToday(opts)
  return items.filter(item => ids.has(item.id) && isUnfinished(item))
}
