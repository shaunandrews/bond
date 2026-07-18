import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { getMemoryItem } from './store'
import { forgetMemory, rememberMemory, searchMemoryTool, validateToolSourceIds } from './tools'

const dbs: Database.Database[] = []
function memoryDb() {
  const db = new Database(':memory:')
  dbs.push(db)
  return db
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

describe('memory tools', () => {
  it('remembers, searches, and forgets memory', () => {
    const db = memoryDb()
    const remembered = rememberMemory({ id: 'm1', text: 'Remember focused tests', sourceIds: ['u1'] }, { db })
    expect(remembered.ok).toBe(true)
    expect(remembered.value?.tags).toContain('source:u1')

    const found = searchMemoryTool('focused', { db })
    expect(found.value?.[0].item.id).toBe('m1')

    const forgotten = forgetMemory('m1', { db })
    expect(forgotten.ok).toBe(true)
    expect(getMemoryItem('m1', db)?.active).toBe(false)
  })

  it('validates source id shape before writes', () => {
    const errors = validateToolSourceIds(['ok', '', 3], false)
    expect(errors).toEqual(['sourceIds must be an array of non-empty strings'])
  })
})
