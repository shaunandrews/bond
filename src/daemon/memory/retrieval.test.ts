import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { writeCoreMemoryAtomic } from './core-memory'
import { retrieveMemory } from './retrieval'
import { upsertMemoryItem } from './store'

const dbs: Database.Database[] = []
function memoryDb() {
  const db = new Database(':memory:')
  dbs.push(db)
  return db
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

describe('memory retrieval', () => {
  it('combines core, working, project, and global memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bond-retrieval-'))
    try {
      const corePath = join(dir, 'core.json')
      writeCoreMemoryAtomic({ version: 1, facts: ['Core fact'], preferences: [], decisions: [], updatedAt: 'now' }, corePath)
      const db = memoryDb()
      upsertMemoryItem({ id: 'p1', text: 'Project Vitest memory', projectId: 'bond' }, db)
      upsertMemoryItem({ id: 'g1', text: 'Global Vitest memory', projectId: null }, db)

      const result = retrieveMemory({ query: 'Vitest', projectId: 'bond', db, corePath, workingState: { sessionId: 's1', projectId: 'bond', goal: 'test', facts: [], preferences: [], decisions: [], openThreads: [], updatedAt: 'now' } })
      expect(result.retrieved.map(r => r.item.id)).toEqual(['p1', 'g1'])
      expect(result.context).toContain('Core fact')
      expect(result.context).toContain('Goal: test')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
