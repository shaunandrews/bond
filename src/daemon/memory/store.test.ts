import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { buildFtsQuery, ensureMemorySchema, getMemoryItem, listRecentMemory, searchMemory, upsertMemoryItem } from './store'

const dbs: Database.Database[] = []
function memoryDb(): Database.Database {
  const db = new Database(':memory:')
  dbs.push(db)
  ensureMemorySchema(db)
  return db
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

describe('memory store', () => {
  it('builds FTS queries from sanitized terms only', () => {
    expect(buildFtsQuery('sqlite OR "drop" -stuff email@example.com')).toBe('"sqlite" OR "or" OR "drop" OR "stuff" OR "email" OR "example" OR "com"')
    expect(buildFtsQuery('"*()')).toBeNull()
  })

  it('upserts and retrieves validated rows', () => {
    const db = memoryDb()
    const item = upsertMemoryItem({ id: 'm1', text: 'Shaun likes restrained UI', kind: 'preference', source: 'user', tags: ['ui'] }, db)
    expect(item.id).toBe('m1')

    const fetched = getMemoryItem('m1', db)
    expect(fetched?.text).toBe('Shaun likes restrained UI')
    expect(fetched?.tags).toEqual(['ui'])

    upsertMemoryItem({ id: 'm1', text: 'Shaun likes quiet UI', kind: 'preference', source: 'user' }, db)
    expect(getMemoryItem('m1', db)?.text).toBe('Shaun likes quiet UI')
  })

  it('searches active memory with project filtering', () => {
    const db = memoryDb()
    upsertMemoryItem({ id: 'a', text: 'Use FTS safe query builder', projectId: 'bond' }, db)
    upsertMemoryItem({ id: 'b', text: 'Use a media library scan', projectId: 'media' }, db)
    upsertMemoryItem({ id: 'c', text: 'FTS inactive result', active: false, projectId: 'bond' }, db)

    expect(searchMemory('FTS builder', { projectId: 'bond' }, db).map(r => r.item.id)).toEqual(['a'])
    expect(searchMemory('library', { projectId: 'bond' }, db)).toEqual([])
  })

  it('falls back to recent active memory for empty queries', () => {
    const db = memoryDb()
    upsertMemoryItem({ id: 'old', text: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }, db)
    upsertMemoryItem({ id: 'new', text: 'new', updatedAt: '2026-01-02T00:00:00.000Z' }, db)

    expect(searchMemory('***', { limit: 1 }, db).map(r => r.item.id)).toEqual(['new'])
    expect(listRecentMemory({ limit: 2 }, db).map(item => item.id)).toEqual(['new', 'old'])
  })
})
