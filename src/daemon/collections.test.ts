import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import type { FieldDef, FieldDefInput } from '../shared/session'
import {
  listCollections, getCollection, getCollectionByName, createCollection,
  updateCollection, deleteCollection,
  listItems, getItem, addItem, updateItem, deleteItem, reorderItems,
  renameField, countItems,
  addItemComment, deleteItemComment, listItemComments,
  searchItems, listReferences,
  CollectionValidationError,
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
    it('starts empty on a fresh database', () => {
      expect(listCollections()).toEqual([])
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

  describe('display numbers and issue keys', () => {
    it('never reuses a display number after deleting the newest item', () => {
      const c = createCollection('Tracker', testSchema, '', [], 'BOND')
      addItem(c.id, { title: 'one' })
      addItem(c.id, { title: 'two' })
      const three = addItem(c.id, { title: 'three' })
      expect(three.displayNumber).toBe(3)

      deleteItem(three.id)
      const four = addItem(c.id, { title: 'four' })
      expect(four.displayNumber).toBe(4) // 3 stays retired forever
    })

    it('validates and uppercases the issue prefix', () => {
      const c = createCollection('Tracker', testSchema, '', [], 'wp')
      expect(c.issuePrefix).toBe('WP')
      expect(() => createCollection('Bad', testSchema, '', [], 'TOOLONGX')).toThrow(/2-6 letters/)
      expect(() => updateCollection(c.id, { issuePrefix: 'B0ND' })).toThrow(/2-6 letters/)
      // Clearing stays allowed
      expect(updateCollection(c.id, { issuePrefix: '' })?.issuePrefix).toBeUndefined()
    })

    describe('listReferences', () => {
      it('returns keys with titles across prefixed collections only', () => {
        const tracker = createCollection('Tracker', [
          { name: 'title', type: 'text', primary: true },
          { name: 'status', type: 'status', options: ['open', { value: 'done', category: 'done' }] },
        ], '', [], 'BOND')
        createCollection('Movies', testSchema) // no prefix — invisible to references
        addItem(tracker.id, { title: 'First issue' })
        addItem(tracker.id, { title: 'Fixed issue', status: 'done' })

        const refs = listReferences()
        expect(refs).toHaveLength(2)
        expect(refs[0]).toMatchObject({ key: 'BOND-1', title: 'First issue', prefix: 'BOND', displayNumber: 1, done: false })
        expect(refs[1]).toMatchObject({ key: 'BOND-2', title: 'Fixed issue', done: true })
        expect(refs[0].collectionId).toBe(tracker.id)
        expect(refs[0].itemId).toBeTruthy()
      })

      it('omits done when the collection has no status field and falls back to Untitled', () => {
        const c = createCollection('Tracker', testSchema, '', [], 'WP')
        const item = addItem(c.id, { title: 'Something' })
        getDb().prepare('UPDATE collection_items SET data = ? WHERE id = ?').run('{}', item.id)

        const [ref] = listReferences()
        expect(ref.title).toBe('Untitled')
        expect('done' in ref).toBe(false)
      })

      it('resolves pre-hardening duplicate display numbers newest-wins', () => {
        const c = createCollection('Tracker', testSchema, '', [], 'BOND')
        const older = addItem(c.id, { title: 'Older' })
        const newer = addItem(c.id, { title: 'Newer' })
        // Simulate a legacy MAX+1 collision
        getDb().prepare('UPDATE collection_items SET display_number = 1, created_at = ? WHERE id = ?')
          .run('2099-01-01T00:00:00.000Z', newer.id)

        const refs = listReferences().filter(r => r.key === 'BOND-1')
        expect(refs).toHaveLength(1)
        expect(refs[0].itemId).toBe(newer.id)
        expect(refs[0].title).toBe('Newer')
        void older
      })
    })
  })

  describe('schema normalization', () => {
    it('normalizes legacy string[] options on create and read', () => {
      const legacy: FieldDefInput[] = [
        { name: 'title', type: 'text', primary: true },
        { name: 'genre', type: 'select', options: ['drama', 'comedy'] },
      ]
      const c = createCollection('Films', legacy)
      expect(c.schema[1].options).toEqual([{ value: 'drama' }, { value: 'comedy' }])
      // Read path returns canonical too
      expect(getCollection(c.id)!.schema[1].options).toEqual([{ value: 'drama' }, { value: 'comedy' }])
    })

    it('normalizes legacy string[] rows already in the database', () => {
      const c = createCollection('Films', [{ name: 'title', type: 'text', primary: true }])
      // Simulate a pre-migration row shape written by an older daemon
      getDb().prepare('UPDATE collections SET schema = ? WHERE id = ?').run(
        JSON.stringify([
          { name: 'title', type: 'text', primary: true },
          { name: 'status', type: 'status', options: ['todo', 'done'] },
        ]),
        c.id
      )
      const schema = getCollection(c.id)!.schema
      expect(schema[1].options![0]).toEqual({ value: 'todo', category: 'open', color: 'gray' })
    })

    it('gives priority fields the default scale', () => {
      const c = createCollection('Tracker', [
        { name: 'title', type: 'text', primary: true },
        { name: 'priority', type: 'priority' },
      ])
      expect(c.schema[1].options!.map(o => o.value)).toEqual(['urgent', 'high', 'medium', 'low', 'none'])
    })
  })

  describe('schema validation', () => {
    it('rejects a schema without a primary text field', () => {
      expect(() => createCollection('Bad', [{ name: 'n', type: 'number' }])).toThrow(CollectionValidationError)
    })

    it('rejects optioned fields without options', () => {
      expect(() => createCollection('Bad', [
        { name: 'title', type: 'text', primary: true },
        { name: 'area', type: 'select' },
      ])).toThrow(/options/)
    })

    it('rejects unknown field types', () => {
      expect(() => createCollection('Bad', [
        { name: 'title', type: 'text', primary: true },
        { name: 'x', type: 'wat' as never },
      ])).toThrow(/unknown type/)
    })

    it('rejects invalid schema updates but allows valid ones', () => {
      const c = createCollection('Movies', testSchema)
      expect(() => updateCollection(c.id, { schema: [{ name: 'x', type: 'number' }] })).toThrow(CollectionValidationError)
      const updated = updateCollection(c.id, { schema: [{ name: 'name', type: 'text', primary: true }] })
      expect(updated?.schema[0].name).toBe('name')
    })
  })

  describe('item validation', () => {
    const trackerSchema: FieldDefInput[] = [
      { name: 'title', type: 'text', primary: true },
      { name: 'status', type: 'status', options: ['open', { value: 'done', category: 'done' }] },
      { name: 'due', type: 'date' },
      { name: 'rating', type: 'rating', max: 5 },
    ]

    it('rejects values outside a status field\'s options, naming the allowed values', () => {
      const c = createCollection('Tracker', trackerSchema)
      try {
        addItem(c.id, { title: 'x', status: 'bogus' })
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(CollectionValidationError)
        const err = e as CollectionValidationError
        expect(err.errors[0].field).toBe('status')
        expect(err.message).toContain('open, done')
      }
    })

    it('rejects unknown fields', () => {
      const c = createCollection('Tracker', trackerSchema)
      expect(() => addItem(c.id, { title: 'x', bogus: 1 })).toThrow(/unknown field/)
    })

    it('coerces CLI-style string input and applies status default', () => {
      const c = createCollection('Tracker', trackerSchema)
      const item = addItem(c.id, { title: 'Ship it', rating: '4' })
      expect(item.data).toEqual({ title: 'Ship it', rating: 4, status: 'open' })
    })

    it('requires the primary field on add', () => {
      const c = createCollection('Tracker', trackerSchema)
      expect(() => addItem(c.id, { status: 'open' })).toThrow(/primary field is required/)
    })

    it('rejects malformed dates', () => {
      const c = createCollection('Tracker', trackerSchema)
      expect(() => addItem(c.id, { title: 'x', due: 'someday' })).toThrow(/YYYY-MM-DD/)
    })

    it('null clears a field on update', () => {
      const c = createCollection('Tracker', trackerSchema)
      const item = addItem(c.id, { title: 'x', due: '2026-08-01' })
      const updated = updateItem(item.id, { due: null })
      expect(updated?.data.due).toBeUndefined()
      expect(updated?.data.title).toBe('x')
    })

    it('keeps legacy-invalid values editable on other keys', () => {
      const c = createCollection('Tracker', trackerSchema)
      const item = addItem(c.id, { title: 'x', status: 'open' })
      // Simulate legacy garbage written before validation existed
      getDb().prepare('UPDATE collection_items SET data = ? WHERE id = ?')
        .run(JSON.stringify({ title: 'x', status: 'not-a-real-status' }), item.id)
      // Editing an unrelated key succeeds and preserves the garbage untouched
      const updated = updateItem(item.id, { title: 'renamed' })
      expect(updated?.data.title).toBe('renamed')
      expect(updated?.data.status).toBe('not-a-real-status')
      // But writing the offending key demands validity
      expect(() => updateItem(item.id, { status: 'still-bogus' })).toThrow(CollectionValidationError)
    })

    it('resolves option values case-insensitively to canonical form', () => {
      const c = createCollection('Tracker', trackerSchema)
      const item = addItem(c.id, { title: 'x', status: 'DONE' })
      expect(item.data.status).toBe('done')
    })
  })
})
