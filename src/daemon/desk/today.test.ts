import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import { getSetting, setSetting } from '../settings'
import { createCollection, listCollections, listItems, listReferences, updateItem } from '../collections'
import {
  addTodayItem,
  carryTodo,
  ensureToday,
  getTodoLink,
  linkTodo,
  listToday,
  localDay,
  TODAY_COLLECTION_NAME,
  unfinishedTodosForThread,
  unlinkTodo,
} from './today'
import { createThread } from './store'
import { DESK_TODAY_COLLECTION_SETTING, DESK_TODAY_PREFIX } from '../../shared/desk'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-today-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

describe('localDay', () => {
  it('uses the user’s local calendar day, not UTC', () => {
    // 23:30 local on the 20th is still the 20th, whatever UTC says
    const local = new Date(2026, 6, 20, 23, 30)
    expect(localDay(local)).toBe('2026-07-20')
  })

  it('pads month and day', () => {
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('ensureToday', () => {
  it('creates the collection with the TODAY prefix and stores its id', () => {
    const collection = ensureToday()
    expect(collection.name).toBe(TODAY_COLLECTION_NAME)
    expect(collection.issuePrefix).toBe(DESK_TODAY_PREFIX)
    expect(getSetting(DESK_TODAY_COLLECTION_SETTING)).toBe(collection.id)
    expect(collection.schema.map(f => f.name)).toEqual(['title', 'status', 'priority', 'day'])
  })

  it('survives repeated initialization without duplicating', () => {
    const first = ensureToday()
    const second = ensureToday()
    const third = ensureToday()
    expect(second.id).toBe(first.id)
    expect(third.id).toBe(first.id)
    expect(listCollections()).toHaveLength(1)
  })

  it('adopts the collection the setting names when two claim TODAY', () => {
    const mine = ensureToday()
    // A second collection claims TODAY — nothing at the DB level stops it
    const impostor = createCollection('Other', [{ name: 'title', type: 'text', primary: true }], '', [], DESK_TODAY_PREFIX)

    const adopted = ensureToday()

    expect(adopted.id).toBe(mine.id)
    expect(adopted.issuePrefix).toBe(DESK_TODAY_PREFIX)
    // the impostor loses the prefix rather than a third collection being minted
    expect(listCollections().find(c => c.id === impostor.id)!.issuePrefix).toBeUndefined()
    expect(listCollections()).toHaveLength(2)
  })

  it('adopts the oldest claimant when the setting names nothing', () => {
    const older = createCollection('A', [{ name: 'title', type: 'text', primary: true }], '', [], DESK_TODAY_PREFIX)
    getDb().prepare('UPDATE collections SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', older.id)
    const newer = createCollection('B', [{ name: 'title', type: 'text', primary: true }], '', [], DESK_TODAY_PREFIX)

    const adopted = ensureToday()

    expect(adopted.id).toBe(older.id)
    expect(listCollections().find(c => c.id === newer.id)!.issuePrefix).toBeUndefined()
  })

  it('leaves exactly one TODAY-n keyspace so listReferences stays unambiguous', () => {
    ensureToday()
    createCollection('Impostor', [{ name: 'title', type: 'text', primary: true }], '', [], DESK_TODAY_PREFIX)
    ensureToday()

    const prefixes = listReferences().map(r => r.key.split('-')[0])
    const todayCollections = listCollections().filter(c => c.issuePrefix === DESK_TODAY_PREFIX)
    expect(todayCollections).toHaveLength(1)
    expect(new Set(prefixes.filter(p => p === DESK_TODAY_PREFIX)).size).toBeLessThanOrEqual(1)
  })

  it('repairs a schema field a user removed', () => {
    const collection = ensureToday()
    getDb().prepare('UPDATE collections SET schema = ? WHERE id = ?')
      .run(JSON.stringify([{ name: 'title', type: 'text', primary: true }]), collection.id)

    const repaired = ensureToday()
    expect(repaired.schema.map(f => f.name)).toEqual(['title', 'status', 'priority', 'day'])
  })

  it('keeps fields the user added', () => {
    const collection = ensureToday()
    getDb().prepare('UPDATE collections SET schema = ? WHERE id = ?')
      .run(JSON.stringify([{ name: 'title', type: 'text', primary: true }, { name: 'notes', type: 'text' }]), collection.id)

    expect(ensureToday().schema.map(f => f.name)).toContain('notes')
  })

  it('restores the prefix if something cleared it', () => {
    const collection = ensureToday()
    getDb().prepare("UPDATE collections SET issue_prefix = '' WHERE id = ?").run(collection.id)
    expect(ensureToday().issuePrefix).toBe(DESK_TODAY_PREFIX)
  })

  it('recreates rather than crashing when the setting points at a deleted collection', () => {
    setSetting(DESK_TODAY_COLLECTION_SETTING, 'gone-forever')
    const collection = ensureToday()
    expect(collection.issuePrefix).toBe(DESK_TODAY_PREFIX)
    expect(getSetting(DESK_TODAY_COLLECTION_SETTING)).toBe(collection.id)
  })
})

describe('the Today list', () => {
  const monday = new Date(2026, 6, 20, 10, 0)
  const tuesday = new Date(2026, 6, 21, 10, 0)

  it('shows items whose day is the current local day', () => {
    addTodayItem({ title: 'Ship the composer fix' }, { now: monday })
    const { items, day } = listToday({ now: monday })
    expect(day).toBe('2026-07-20')
    expect(items.map(i => i.data.title)).toEqual(['Ship the composer fix'])
  })

  it('midnight changes the query, not stored dates', () => {
    const item = addTodayItem({ title: 'Yesterday’s todo' }, { now: monday })
    expect(listToday({ now: tuesday }).items).toHaveLength(0)
    // the item is untouched, still filed under Monday
    expect(listItems(ensureToday().id).find(i => i.id === item.id)!.data.day).toBe('2026-07-20')
  })

  it('defaults new items to status todo', () => {
    const item = addTodayItem({ title: 'A thing' }, { now: monday })
    expect(item.data.status).toBe('todo')
  })

  it('an explicit day overrides the default', () => {
    addTodayItem({ title: 'Filed ahead', day: '2026-07-21' }, { now: monday })
    expect(listToday({ now: monday }).items).toHaveLength(0)
    expect(listToday({ now: tuesday }).items).toHaveLength(1)
  })
})

describe('carryTodo', () => {
  const monday = new Date(2026, 6, 20, 10, 0)
  const tuesday = new Date(2026, 6, 21, 10, 0)

  it('is explicit — it never runs on its own', () => {
    const item = addTodayItem({ title: 'Unfinished' }, { now: monday })
    expect(listToday({ now: tuesday }).items).toHaveLength(0)

    carryTodo(item.id, { now: tuesday })
    expect(listToday({ now: tuesday }).items.map(i => i.id)).toEqual([item.id])
  })

  it('refuses to carry a finished item', () => {
    const item = addTodayItem({ title: 'Done already' }, { now: monday })
    updateItem(item.id, { status: 'done' })
    expect(carryTodo(item.id, { now: tuesday })).toBeNull()

    const cancelled = addTodayItem({ title: 'Dropped' }, { now: monday })
    updateItem(cancelled.id, { status: 'cancelled' })
    expect(carryTodo(cancelled.id, { now: tuesday })).toBeNull()
  })

  it('is idempotent', () => {
    const item = addTodayItem({ title: 'Unfinished' }, { now: monday })
    carryTodo(item.id, { now: tuesday })
    carryTodo(item.id, { now: tuesday })
    expect(listToday({ now: tuesday }).items).toHaveLength(1)
  })

  it('never changes the item’s status', () => {
    const item = addTodayItem({ title: 'Unfinished' }, { now: monday })
    updateItem(item.id, { status: 'in_progress' })
    expect(carryTodo(item.id, { now: tuesday })!.data.status).toBe('in_progress')
  })

  it('returns null for an unknown item', () => {
    expect(carryTodo('nope', { now: tuesday })).toBeNull()
  })
})

describe('todo ↔ thread links', () => {
  const monday = new Date(2026, 6, 20, 10, 0)

  it('links and unlinks explicitly', () => {
    const thread = createThread({ name: 'ISP problem', source: 'user' })
    const item = addTodayItem({ title: 'Call the ISP' }, { now: monday })

    expect(linkTodo(item.id, thread.id).threadId).toBe(thread.id)
    expect(getTodoLink(item.id)!.threadId).toBe(thread.id)
    expect(unlinkTodo(item.id)).toBe(true)
    expect(getTodoLink(item.id)).toBeNull()
    expect(unlinkTodo(item.id)).toBe(false)
  })

  it('relinking replaces rather than duplicating', () => {
    const a = createThread({ name: 'A', source: 'user' })
    const b = createThread({ name: 'B', source: 'user' })
    const item = addTodayItem({ title: 'Thing' }, { now: monday })
    linkTodo(item.id, a.id)
    linkTodo(item.id, b.id)
    expect(getTodoLink(item.id)!.threadId).toBe(b.id)
  })

  it('cascades away with the item', () => {
    const thread = createThread({ name: 'ISP problem', source: 'user' })
    const item = addTodayItem({ title: 'Call the ISP' }, { now: monday })
    linkTodo(item.id, thread.id)
    getDb().prepare('DELETE FROM collection_items WHERE id = ?').run(item.id)
    expect(getTodoLink(item.id)).toBeNull()
  })

  it('survives the thread being deleted, unlinked', () => {
    const thread = createThread({ name: 'ISP problem', source: 'user' })
    const item = addTodayItem({ title: 'Call the ISP' }, { now: monday })
    linkTodo(item.id, thread.id)
    getDb().prepare('DELETE FROM desk_threads WHERE id = ?').run(thread.id)
    expect(getTodoLink(item.id)!.threadId).toBeNull()
  })

  it('surfaces only unfinished linked todos for today', () => {
    const thread = createThread({ name: 'ISP problem', source: 'user' })
    const open = addTodayItem({ title: 'Call the ISP' }, { now: monday })
    const done = addTodayItem({ title: 'Already handled' }, { now: monday })
    const unlinked = addTodayItem({ title: 'Unrelated' }, { now: monday })
    updateItem(done.id, { status: 'done' })
    linkTodo(open.id, thread.id)
    linkTodo(done.id, thread.id)

    const result = unfinishedTodosForThread(thread.id, { now: monday })
    expect(result.map(i => i.id)).toEqual([open.id])
    expect(result.map(i => i.id)).not.toContain(unlinked.id)
  })
})
