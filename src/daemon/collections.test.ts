import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import type { FieldDef } from '../shared/session'
import {
  listCollections, getCollection, getCollectionByName, createCollection,
  updateCollection, deleteCollection,
  listItems, getItem, addItem, updateItem, deleteItem, reorderItems,
  renameField, countItems,
  addItemComment, deleteItemComment, listItemComments,
  searchItems, listItemsByProject,
} from './collections'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-collections-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

const testSchema: FieldDef[] = [
  { name: 'title', type: 'text', primary: true },
  { name: 'rating', type: 'rating', max: 5 },
]

describe('collections module', () => {
  describe('collection CRUD', () => {
    it('starts with Journal collection from migration', () => {
      const collections = listCollections()
      // The journal-to-collection migration creates a "Journal" collection
      const journal = collections.find(c => c.name === 'Journal')
      expect(journal).toBeTruthy()
    })

    it('creates a collection', () => {
      const c = createCollection('Movies', testSchema, '🎬', ['comments'])
      expect(c.id).toBeTruthy()
      expect(c.name).toBe('Movies')
      expect(c.icon).toBe('🎬')
      expect(c.schema).toEqual(testSchema)
      expect(c.features).toEqual(['comments'])
      expect(c.archived).toBe(false)
    })

    it('gets by id', () => {
      const c = createCollection('Movies', testSchema)
      const fetched = getCollection(c.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.name).toBe('Movies')
    })

    it('gets by name', () => {
      createCollection('Movies', testSchema)
      const fetched = getCollectionByName('Movies')
      expect(fetched).not.toBeNull()
      expect(fetched!.name).toBe('Movies')
    })

    it('returns null for nonexistent', () => {
      expect(getCollection('fake')).toBeNull()
      expect(getCollectionByName('Nope')).toBeNull()
    })

    it('updates collection', () => {
      const c = createCollection('Old', testSchema)
      const updated = updateCollection(c.id, { name: 'New', icon: '📝' })
      expect(updated?.name).toBe('New')
      expect(updated?.icon).toBe('📝')
    })

    it('archives collection', () => {
      const c = createCollection('Movies', testSchema)
      const updated = updateCollection(c.id, { archived: true })
      expect(updated?.archived).toBe(true)
    })

    it('updates schema', () => {
      const c = createCollection('Movies', testSchema)
      const newSchema: FieldDef[] = [{ name: 'name', type: 'text', primary: true }]
      const updated = updateCollection(c.id, { schema: newSchema })
      expect(updated?.schema).toEqual(newSchema)
    })

    it('returns collection unchanged for empty updates', () => {
      const c = createCollection('Movies', testSchema)
      const result = updateCollection(c.id, {})
      expect(result?.name).toBe('Movies')
    })

    it('deletes collection', () => {
      const c = createCollection('Movies', testSchema)
      expect(deleteCollection(c.id)).toBe(true)
      expect(getCollection(c.id)).toBeNull()
    })

    it('returns false deleting nonexistent', () => {
      expect(deleteCollection('fake')).toBe(false)
    })
  })

  describe('item CRUD', () => {
    it('lists empty initially', () => {
      const c = createCollection('Movies', testSchema)
      expect(listItems(c.id)).toEqual([])
    })

    it('adds item', () => {
      const c = createCollection('Movies', testSchema)
      const item = addItem(c.id, { title: 'Inception', rating: 5 })
      expect(item.id).toBeTruthy()
      expect(item.collectionId).toBe(c.id)
      expect(item.data).toEqual({ title: 'Inception', rating: 5 })
    })

    it('adds item with projectId', () => {
      const c = createCollection('Movies', testSchema)
      // Create project first
      const db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO projects (id, name, goal, type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('p1', 'P', '', 'generic', now, now)

      const item = addItem(c.id, { title: 'Test' }, 'p1')
      expect(item.projectId).toBe('p1')
    })

    it('assigns sequential sort order', () => {
      const c = createCollection('Movies', testSchema)
      const i1 = addItem(c.id, { title: 'First' })
      const i2 = addItem(c.id, { title: 'Second' })
      expect(i2.sortOrder).toBeGreaterThan(i1.sortOrder)
    })

    it('gets item by id with comments', () => {
      const c = createCollection('Movies', testSchema)
      const item = addItem(c.id, { title: 'Test' })
      const fetched = getItem(item.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.data.title).toBe('Test')
      expect(fetched!.comments).toEqual([])
    })

    it('updates item data (merges)', () => {
      const c = createCollection('Movies', testSchema)
      const item = addItem(c.id, { title: 'Old', rating: 3 })
      const updated = updateItem(item.id, { title: 'New' })
      expect(updated?.data.title).toBe('New')
      expect(updated?.data.rating).toBe(3) // preserved
    })

    it('updates item projectId', () => {
      const c = createCollection('Movies', testSchema)
      const db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO projects (id, name, goal, type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('p1', 'P', '', 'generic', now, now)

      const item = addItem(c.id, { title: 'Test' })
      const updated = updateItem(item.id, {}, 'p1')
      expect(updated?.projectId).toBe('p1')
    })

    it('clears item projectId', () => {
      const c = createCollection('Movies', testSchema)
      const db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO projects (id, name, goal, type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('p1', 'P', '', 'generic', now, now)

      const item = addItem(c.id, { title: 'Test' }, 'p1')
      const updated = updateItem(item.id, {}, null)
      expect(updated?.projectId).toBeUndefined()
    })

    it('returns null updating nonexistent', () => {
      expect(updateItem('fake', { title: 'x' })).toBeNull()
    })

    it('deletes item', () => {
      const c = createCollection('Movies', testSchema)
      const item = addItem(c.id, { title: 'Test' })
      expect(deleteItem(item.id)).toBe(true)
      expect(getItem(item.id)).toBeNull()
    })

    it('returns false deleting nonexistent', () => {
      expect(deleteItem('fake')).toBe(false)
    })

    it('cascades on collection delete', () => {
      const c = createCollection('Movies', testSchema)
      addItem(c.id, { title: 'Test' })
      deleteCollection(c.id)
      expect(listItems(c.id)).toEqual([])
    })
  })

  describe('reorderItems', () => {
    it('reorders items', () => {
      const c = createCollection('Movies', testSchema)
      const i1 = addItem(c.id, { title: 'A' })
      const i2 = addItem(c.id, { title: 'B' })
      const i3 = addItem(c.id, { title: 'C' })

      reorderItems([i3.id, i1.id, i2.id])

      const items = listItems(c.id)
      expect(items[0].data.title).toBe('C')
      expect(items[1].data.title).toBe('A')
      expect(items[2].data.title).toBe('B')
    })
  })

  describe('renameField', () => {
    it('renames field in schema and items', () => {
      const c = createCollection('Movies', testSchema)
      addItem(c.id, { title: 'Inception', rating: 5 })

      expect(renameField(c.id, 'title', 'name')).toBe(true)

      const updated = getCollection(c.id)
      expect(updated!.schema[0].name).toBe('name')

      const items = listItems(c.id)
      expect(items[0].data.name).toBe('Inception')
      expect(items[0].data.title).toBeUndefined()
    })

    it('returns false for nonexistent collection', () => {
      expect(renameField('fake', 'a', 'b')).toBe(false)
    })

    it('returns false for nonexistent field', () => {
      const c = createCollection('Movies', testSchema)
      expect(renameField(c.id, 'nonexistent', 'b')).toBe(false)
    })
  })

  describe('countItems', () => {
    it('returns 0 for empty collection', () => {
      const c = createCollection('Movies', testSchema)
      expect(countItems(c.id)).toBe(0)
    })

    it('counts items', () => {
      const c = createCollection('Movies', testSchema)
      addItem(c.id, { title: 'A' })
      addItem(c.id, { title: 'B' })
      expect(countItems(c.id)).toBe(2)
    })
  })

  describe('item comments', () => {
    it('adds and lists comments', () => {
      const c = createCollection('Movies', testSchema)
      const item = addItem(c.id, { title: 'Test' })

      const comment = addItemComment(item.id, 'user', 'Great movie!')
      expect(comment.id).toBeTruthy()
      expect(comment.author).toBe('user')
      expect(comment.body).toBe('Great movie!')

      const comments = listItemComments(item.id)
      expect(comments).toHaveLength(1)
      expect(comments[0].body).toBe('Great movie!')
    })

    it('comments appear on getItem', () => {
      const c = createCollection('Movies', testSchema)
      const item = addItem(c.id, { title: 'Test' })
      addItemComment(item.id, 'bond', 'Nice choice')

      const fetched = getItem(item.id)
      expect(fetched!.comments).toHaveLength(1)
      expect(fetched!.comments![0].author).toBe('bond')
    })

    it('deletes comment', () => {
      const c = createCollection('Movies', testSchema)
      const item = addItem(c.id, { title: 'Test' })
      const comment = addItemComment(item.id, 'user', 'Delete me')
      expect(deleteItemComment(comment.id)).toBe(true)
      expect(listItemComments(item.id)).toHaveLength(0)
    })

    it('returns false deleting nonexistent comment', () => {
      expect(deleteItemComment('fake')).toBe(false)
    })
  })

  describe('searchItems', () => {
    it('finds items matching query', () => {
      const c = createCollection('Movies', testSchema)
      addItem(c.id, { title: 'Inception' })
      addItem(c.id, { title: 'Interstellar' })
      addItem(c.id, { title: 'The Matrix' })

      const results = searchItems(c.id, 'Inter')
      expect(results).toHaveLength(1)
      expect(results[0].data.title).toBe('Interstellar')
    })

    it('returns empty for no matches', () => {
      const c = createCollection('Movies', testSchema)
      addItem(c.id, { title: 'Inception' })
      expect(searchItems(c.id, 'zzzzz')).toEqual([])
    })
  })

  describe('listItemsByProject', () => {
    it('filters by project', () => {
      const c = createCollection('Movies', testSchema)
      const db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO projects (id, name, goal, type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('p1', 'P1', '', 'generic', now, now)
      db.prepare('INSERT INTO projects (id, name, goal, type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('p2', 'P2', '', 'generic', now, now)

      addItem(c.id, { title: 'A' }, 'p1')
      addItem(c.id, { title: 'B' }, 'p2')
      addItem(c.id, { title: 'C' }, 'p1')

      const items = listItemsByProject(c.id, 'p1')
      expect(items).toHaveLength(2)
      expect(items.map(i => i.data.title)).toEqual(['A', 'C'])
    })
  })
})
