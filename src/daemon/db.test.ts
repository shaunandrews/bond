import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-db-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('db module', () => {
  describe('getDb', () => {
    it('returns a database instance', () => {
      const db = getDb()
      expect(db).toBeTruthy()
    })

    it('returns the same instance on subsequent calls', () => {
      const db1 = getDb()
      const db2 = getDb()
      expect(db1).toBe(db2)
    })

    it('enables WAL mode', () => {
      const db = getDb()
      const mode = db.pragma('journal_mode') as { journal_mode: string }[]
      expect(mode[0].journal_mode).toBe('wal')
    })

    it('enables foreign keys', () => {
      const db = getDb()
      const fk = db.pragma('foreign_keys') as { foreign_keys: number }[]
      expect(fk[0].foreign_keys).toBe(1)
    })
  })

  describe('schema', () => {
    it('creates sessions table', () => {
      const db = getDb()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all()
      expect(tables).toHaveLength(1)
    })

    it('creates messages table', () => {
      const db = getDb()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").all()
      expect(tables).toHaveLength(1)
    })

    it('creates settings table', () => {
      const db = getDb()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").all()
      expect(tables).toHaveLength(1)
    })

    it('creates todos table with all columns', () => {
      const db = getDb()
      const cols = db.pragma('table_info(todos)') as { name: string }[]
      const names = cols.map(c => c.name)
      expect(names).toContain('id')
      expect(names).toContain('text')
      expect(names).toContain('notes')
      expect(names).toContain('group_name')
      expect(names).toContain('done')
      expect(names).toContain('project_id')
      expect(names).toContain('sort_order')
    })

    it('creates projects table', () => {
      const db = getDb()
      const cols = db.pragma('table_info(projects)') as { name: string }[]
      const names = cols.map(c => c.name)
      expect(names).toContain('id')
      expect(names).toContain('name')
      expect(names).toContain('goal')
      expect(names).toContain('type')
      expect(names).toContain('archived')
      expect(names).toContain('deadline')
    })

    it('creates project_resources table', () => {
      const db = getDb()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_resources'").all()
      expect(tables).toHaveLength(1)
    })

    it('creates collections table', () => {
      const db = getDb()
      const cols = db.pragma('table_info(collections)') as { name: string }[]
      const names = cols.map(c => c.name)
      expect(names).toContain('id')
      expect(names).toContain('name')
      expect(names).toContain('icon')
      expect(names).toContain('schema')
      expect(names).toContain('features')
    })

    it('creates collection_items table', () => {
      const db = getDb()
      const cols = db.pragma('table_info(collection_items)') as { name: string }[]
      const names = cols.map(c => c.name)
      expect(names).toContain('id')
      expect(names).toContain('collection_id')
      expect(names).toContain('data')
      expect(names).toContain('project_id')
      expect(names).toContain('sort_order')
    })

    it('creates images table', () => {
      const db = getDb()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='images'").all()
      expect(tables).toHaveLength(1)
    })

    it('creates operatives table', () => {
      const db = getDb()
      const cols = db.pragma('table_info(operatives)') as { name: string }[]
      const names = cols.map(c => c.name)
      expect(names).toContain('id')
      expect(names).toContain('name')
      expect(names).toContain('prompt')
      expect(names).toContain('status')
      expect(names).toContain('context_window')
    })

    it('creates operative_events table', () => {
      const db = getDb()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operative_events'").all()
      expect(tables).toHaveLength(1)
    })

    it('creates sense tables', () => {
      const db = getDb()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sense_%'").all() as { name: string }[]
      const names = tables.map(t => t.name)
      expect(names).toContain('sense_sessions')
      expect(names).toContain('sense_captures')
      expect(names).toContain('sense_app_text_quality')
    })

    it('creates sessions with all migrated columns', () => {
      const db = getDb()
      const cols = db.pragma('table_info(sessions)') as { name: string }[]
      const names = cols.map(c => c.name)
      expect(names).toContain('edit_mode')
      expect(names).toContain('site_id')
      expect(names).toContain('project_id')
      expect(names).toContain('favorited')
      expect(names).toContain('icon_seed')
      expect(names).toContain('quick')
    })

    it('creates messages with all migrated columns', () => {
      const db = getDb()
      const cols = db.pragma('table_info(messages)') as { name: string }[]
      const names = cols.map(c => c.name)
      expect(names).toContain('images')
      expect(names).toContain('updated_at')
    })
  })

  describe('closeDb', () => {
    it('allows re-opening after close', () => {
      const db1 = getDb()
      expect(db1).toBeTruthy()
      closeDb()
      const db2 = getDb()
      expect(db2).toBeTruthy()
      expect(db2).not.toBe(db1)
    })
  })

  describe('migrations are idempotent', () => {
    it('running getDb twice does not throw', () => {
      getDb()
      closeDb()
      expect(() => getDb()).not.toThrow()
    })
  })
})
