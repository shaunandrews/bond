import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { setDataDir, getDbPath } from './paths'
import { getDb, closeDb, APP_SCHEMA_VERSION } from './db'

const RETIRED_TABLES = ['todos', 'projects', 'project_resources', 'journal_entries', 'journal_comments', 'operatives', 'operative_events', 'pending_approvals']

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name)
}

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

    it('pins APP_SCHEMA_VERSION at 2', () => {
      // A version bump routes every existing install through
      // resetIfSchemaChanged's deliberate-cutover WIPE of the user's database,
      // Pi sessions, and images. All schema evolution must ship as normal
      // in-version migrations instead — this pin only moves when a wipe is
      // the explicit, intended product decision.
      expect(APP_SCHEMA_VERSION).toBe(2)
    })

    it('creates none of the retired tables on a fresh install', () => {
      const db = getDb()
      const names = tableNames(db)
      for (const table of RETIRED_TABLES) {
        expect(names, `${table} should not exist`).not.toContain(table)
      }
    })

    it('drops the retired projects table and every project_id column', () => {
      // Projects was retired long ago and only survived because four tables
      // held REFERENCES projects(id). Both sides are gone now.
      const db = getDb()
      expect(db.pragma('table_info(projects)')).toEqual([])
      for (const table of ['sessions', 'collection_items', 'sense_debriefs', 'sense_facts']) {
        const names = (db.pragma(`table_info(${table})`) as { name: string }[]).map(c => c.name)
        expect(names).not.toContain('project_id')
      }
    })

    it('keeps memory_items.project_id — a scope string, not a foreign key', () => {
      const db = getDb()
      const names = (db.pragma('table_info(memory_items)') as { name: string }[]).map(c => c.name)
      expect(names).toContain('project_id')
    })

    it('creates the canonical messages shape directly — nullable session_id, seq present', () => {
      const db = getDb()
      const cols = db.pragma('table_info(messages)') as { name: string; notnull: number }[]
      const byName = new Map(cols.map(c => [c.name, c]))
      expect(byName.get('session_id')?.notnull).toBe(0)
      expect(byName.has('seq')).toBe(true)
      expect(byName.has('epoch_id')).toBe(true)
      expect(byName.has('created_at')).toBe(true)
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
      expect(names).toContain('sort_order')
    })

    it('does not create an empty Journal collection on fresh installs', () => {
      const db = getDb()
      const collection = db.prepare("SELECT id FROM collections WHERE name = 'Journal'").get()
      expect(collection).toBeUndefined()
    })

    it('preserves a legacy standalone-journal DB by exporting entries to JSON before the drop', () => {
      // A pre-app_meta DB whose only product table is journal_entries is NOT
      // wiped (the preserveLegacyJournal probe) — it gets opened, stamped,
      // its journal exported to a JSON backup, and the table dropped.
      const legacy = new Database(getDbPath())
      legacy.exec(`
        CREATE TABLE journal_entries (
          id TEXT PRIMARY KEY,
          author TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          project_id TEXT,
          session_id TEXT,
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `)
      const now = new Date().toISOString()
      legacy.prepare('INSERT INTO journal_entries (id, author, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('legacy-entry', 'user', 'Old Note', 'Body', '["old"]', now, now)
      legacy.close()

      const db = getDb()
      const collection = db.prepare("SELECT id FROM collections WHERE name = 'Journal'").get()
      expect(collection).toBeUndefined()
      expect(tableNames(db)).not.toContain('journal_entries')

      const backups = readdirSync(testDir).filter(f => f.startsWith('journal-legacy-backup-') && f.endsWith('.json'))
      expect(backups).toHaveLength(1)
      const backup = JSON.parse(readFileSync(join(testDir, backups[0]), 'utf-8')) as { entries: Array<Record<string, unknown>>; comments: unknown[] }
      expect(backup.entries).toHaveLength(1)
      expect(backup.entries[0]).toMatchObject({ id: 'legacy-entry', title: 'Old Note', body: 'Body' })
      expect(backup.comments).toEqual([])
    })

    it('creates images table', () => {
      const db = getDb()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='images'").all()
      expect(tables).toHaveLength(1)
    })

    it('creates assets and asset_references tables', () => {
      const db = getDb()
      const names = tableNames(db)
      expect(names).toContain('assets')
      expect(names).toContain('asset_references')
    })

    it('drops populated retired tables on upgrade while live data survives', () => {
      // A current-version DB carrying retired-feature data: the tables go,
      // the journal is exported, and NOTHING routes through the cutover wipe.
      const old = new Database(getDbPath())
      old.exec(`
        CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO app_meta VALUES ('schema_version', '${APP_SCHEMA_VERSION}');
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT 'New chat',
          summary TEXT NOT NULL DEFAULT '',
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO sessions VALUES ('keep-me', 'Live session', '', 0, '2026-01-01', '2026-01-01');
        CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO todos VALUES ('t1', 'old todo', 0, '2026-01-01', '2026-01-01');
        CREATE TABLE operatives (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued');
        INSERT INTO operatives (id, name) VALUES ('o1', 'op');
        CREATE TABLE journal_entries (
          id TEXT PRIMARY KEY,
          author TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO journal_entries (id, author, title, body, created_at, updated_at)
        VALUES ('j1', 'user', 'Kept Note', 'Kept Body', '2026-01-01', '2026-01-01');
      `)
      old.close()

      const db = getDb()
      const names = tableNames(db)
      for (const table of RETIRED_TABLES) {
        expect(names, `${table} should be dropped`).not.toContain(table)
      }

      // The session row SURVIVED — this path must never wipe.
      const session = db.prepare("SELECT title FROM sessions WHERE id = 'keep-me'").get() as { title: string }
      expect(session.title).toBe('Live session')

      const backups = readdirSync(testDir).filter(f => f.startsWith('journal-legacy-backup-') && f.endsWith('.json'))
      expect(backups).toHaveLength(1)
      const backup = JSON.parse(readFileSync(join(testDir, backups[0]), 'utf-8')) as { entries: Array<Record<string, unknown>> }
      expect(backup.entries[0]).toMatchObject({ id: 'j1', title: 'Kept Note' })
    })

    it('drops populated project_id columns on upgrade without losing the rows', () => {
      // The real upgrade shape: a current-version DB whose sessions and
      // collection_items still carry REFERENCES projects(id), with a live
      // project actually assigned. The columns and parent go; the rows stay.
      const old = new Database(getDbPath())
      old.exec(`
        CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO app_meta VALUES ('schema_version', '${APP_SCHEMA_VERSION}');
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          goal TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL DEFAULT 'generic',
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO projects VALUES ('p1', 'Old project', '', 'generic', 0, '2026-01-01', '2026-01-01');
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT 'New chat',
          summary TEXT NOT NULL DEFAULT '',
          archived INTEGER NOT NULL DEFAULT 0,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO sessions VALUES ('s1', 'Assigned session', '', 0, 'p1', '2026-01-01', '2026-01-01');
      `)
      old.close()

      const db = getDb()

      expect(tableNames(db)).not.toContain('projects')
      const sessionCols = (db.pragma('table_info(sessions)') as { name: string }[]).map(c => c.name)
      expect(sessionCols).not.toContain('project_id')

      // The row that pointed at a project survived the column drop intact.
      const session = db.prepare("SELECT title FROM sessions WHERE id = 's1'").get() as { title: string }
      expect(session.title).toBe('Assigned session')
      expect(db.pragma('foreign_key_check')).toEqual([])
    })

    it('keeps inserts working on the four tables that used to hold the FK', () => {
      const db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO sessions (id, title, summary, archived, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .run('s-fk', 'FK test', '', now, now)
      db.prepare('INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('col-fk', 'Test collection', now, now)
      expect(() => {
        db.prepare('INSERT INTO collection_items (id, collection_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run('item-fk', 'col-fk', now, now)
        db.prepare('INSERT INTO sense_debriefs (id, session_id, summary, created_at) VALUES (?, ?, ?, ?)')
          .run('deb-fk', 's-fk', 'a summary', now)
        db.prepare('INSERT INTO sense_facts (id, fact, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run('fact-fk', 'a fact', now, now)
      }).not.toThrow()
      expect(db.pragma('foreign_key_check')).toEqual([])
    })

    it('seeds next_display_number from each collection\'s existing max', () => {
      let db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('col-a', 'With items', now, now)
      db.prepare('INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('col-b', 'Empty', now, now)
      for (const n of [1, 2, 7]) {
        db.prepare('INSERT INTO collection_items (id, collection_id, display_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(`item-${n}`, 'col-a', n, now, now)
      }
      // Simulate a pre-migration database, then reopen to re-run migrations
      db.exec('ALTER TABLE collections DROP COLUMN next_display_number')
      closeDb()
      db = getDb()

      const a = db.prepare("SELECT next_display_number as n FROM collections WHERE id = 'col-a'").get() as { n: number }
      const b = db.prepare("SELECT next_display_number as n FROM collections WHERE id = 'col-b'").get() as { n: number }
      expect(a.n).toBe(8) // max(7) + 1, gaps preserved
      expect(b.n).toBe(1)
    })

    it('never renumbers items that already hold a display number across reopens', () => {
      // Regression: the display-number backfill used to reassign 1..N on every
      // boot, silently rewriting user-visible keys after any deletion.
      let db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('col-r', 'Tracker', now, now)
      for (const n of [1, 3, 9]) { // gaps from deletions must survive
        db.prepare('INSERT INTO collection_items (id, collection_id, display_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(`item-${n}`, 'col-r', n, now, now)
      }
      // A row an old daemon inserted without a number gets the next free one
      db.prepare('INSERT INTO collection_items (id, collection_id, display_number, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
        .run('item-unnumbered', 'col-r', now, now)
      closeDb()
      db = getDb()

      const rows = db.prepare('SELECT id, display_number FROM collection_items WHERE collection_id = ? ORDER BY display_number').all('col-r') as { id: string; display_number: number }[]
      expect(rows).toEqual([
        { id: 'item-1', display_number: 1 },
        { id: 'item-3', display_number: 3 },
        { id: 'item-9', display_number: 9 },
        { id: 'item-unnumbered', display_number: 10 },
      ])
    })

    it('creates sense tables', () => {
      const db = getDb()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sense_%'").all() as { name: string }[]
      const names = tables.map(t => t.name)
      expect(names).toContain('sense_sessions')
      expect(names).toContain('sense_captures')
      expect(names).toContain('sense_app_text_quality')
    })

    it('keeps sessions with all migrated columns', () => {
      const db = getDb()
      const cols = db.pragma('table_info(sessions)') as { name: string }[]
      const names = cols.map(c => c.name)
      expect(names).toContain('edit_mode')
      expect(names).toContain('site_id')
      expect(names).toContain('favorited')
      expect(names).toContain('icon_seed')
      expect(names).toContain('quick')
    })

    it('keeps messages with all migrated columns', () => {
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

describe('schema reset vs quarantine', () => {
  it('quarantines an unreadable database instead of wiping user data', () => {
    // Regression: a merely-unreadable DB (torn WAL, permissions, corruption)
    // used to take the same wipe path as a deliberate schema cutover,
    // destroying Pi sessions and images along with it.
    writeFileSync(getDbPath(), 'this is not a sqlite database')
    const piDir = join(testDir, 'pi', 'sessions')
    const imgDir = join(testDir, 'images')
    mkdirSync(piDir, { recursive: true })
    mkdirSync(imgDir, { recursive: true })
    writeFileSync(join(piDir, 'session.jsonl'), '{"role":"user"}\n')
    writeFileSync(join(imgDir, 'photo.png'), 'png-bytes')

    const db = getDb()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all()).toHaveLength(1)

    const quarantined = readdirSync(testDir).filter((f) => f.startsWith('bond.db.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(existsSync(join(piDir, 'session.jsonl'))).toBe(true)
    expect(existsSync(join(imgDir, 'photo.png'))).toBe(true)
  })

  it('still wipes a readable database with a stale schema version (cutover)', () => {
    const old = new Database(getDbPath())
    old.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT)")
    old.prepare("INSERT INTO app_meta (key, value) VALUES ('schema_version', '1')").run()
    old.exec("CREATE TABLE relic (id TEXT)")
    old.prepare("INSERT INTO relic (id) VALUES ('old-data')").run()
    old.close()
    const piDir = join(testDir, 'pi', 'sessions')
    mkdirSync(piDir, { recursive: true })
    writeFileSync(join(piDir, 'session.jsonl'), '{"role":"user"}\n')

    const db = getDb()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relic'").all()).toHaveLength(0)
    expect(existsSync(join(piDir, 'session.jsonl'))).toBe(false)
    expect(readdirSync(testDir).filter((f) => f.startsWith('bond.db.corrupt-'))).toHaveLength(0)
  })

  it('leaves a current-version database untouched', () => {
    const db1 = getDb()
    db1.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'Keep me', datetime('now'), datetime('now'))"
    ).run()
    closeDb()

    const db2 = getDb()
    const rows = db2.prepare("SELECT title FROM sessions WHERE id = 's1'").all() as { title: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Keep me')
  })
})

describe('assets media backfill', () => {
  it('mirrors pre-existing images rows into assets with unchanged ids', () => {
    let db = getDb()
    const now = new Date().toISOString()
    db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('s1', 'Screenshots', now, now)
    db.prepare('INSERT INTO images (id, session_id, filename, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('img-1', 's1', 'img-1.png', 'image/png', 1234, now)

    // Simulate a pre-Library database, then reopen to re-run migrations.
    db.prepare("DELETE FROM settings WHERE key = 'assets_media_backfilled'").run()
    db.exec('DELETE FROM assets')
    closeDb()
    db = getDb()

    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get('img-1') as Record<string, unknown>
    expect(asset).toMatchObject({
      id: 'img-1',
      kind: 'media',
      format: 'image',
      filename: 'img-1.png',
      media_type: 'image/png',
      size_bytes: 1234,
    })
  })

  it('is idempotent — does not duplicate rows on a second open', () => {
    let db = getDb()
    const now = new Date().toISOString()
    db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('s1', 'Screenshots', now, now)
    db.prepare('INSERT INTO images (id, session_id, filename, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('img-1', 's1', 'img-1.png', 'image/png', 1234, now)
    // The initial getDb() already ran the backfill against an empty images
    // table and set the flag — reset both to simulate a genuine pre-migration
    // database with this row present.
    db.prepare("DELETE FROM settings WHERE key = 'assets_media_backfilled'").run()
    db.exec('DELETE FROM assets')
    closeDb()
    db = getDb() // first real backfill runs here

    const count1 = (db.prepare('SELECT COUNT(*) as n FROM assets WHERE id = ?').get('img-1') as { n: number }).n
    closeDb()
    db = getDb() // flag is set — must not re-run

    const count2 = (db.prepare('SELECT COUNT(*) as n FROM assets WHERE id = ?').get('img-1') as { n: number }).n
    expect(count1).toBe(1)
    expect(count2).toBe(1)
  })
})

describe('sense_fts index integrity', () => {
  function seedCapture(db: Database.Database, id: string, text: string | null): void {
    const now = new Date().toISOString()
    db.prepare('INSERT OR IGNORE INTO sense_sessions (id, started_at, created_at) VALUES (?, ?, ?)').run('ss1', now, now)
    db.prepare(
      'INSERT INTO sense_captures (id, session_id, captured_at, app_name, window_title, text_content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'ss1', now, 'TestApp', 'A window', text, now)
  }

  function ftsMatches(db: Database.Database, term: string): number {
    return db.prepare('SELECT rowid FROM sense_fts WHERE sense_fts MATCH ?').all(`"${term}"`).length
  }

  it('update trigger tracks text transitions through NULL (regression)', () => {
    // The original trigger's single WHEN NEW.text_content IS NOT NULL guard
    // skipped the whole body on text -> NULL, stranding a stale index entry.
    const db = getDb()
    seedCapture(db, 'c1', null)
    expect(ftsMatches(db, 'zephyr')).toBe(0)

    db.prepare("UPDATE sense_captures SET text_content = 'zephyr sighting' WHERE id = 'c1'").run()
    expect(ftsMatches(db, 'zephyr')).toBe(1)

    db.prepare("UPDATE sense_captures SET text_content = NULL WHERE id = 'c1'").run()
    expect(ftsMatches(db, 'zephyr')).toBe(0)
  })

  it('rebuilds a drifted index exactly once, guarded by the settings flag', () => {
    const db = getDb()
    expect((db.prepare("SELECT value FROM settings WHERE key = 'sense_fts_rebuilt'").get() as { value: string }).value).toBe('1')
    seedCapture(db, 'c1', 'driftwood on the shore')

    // Simulate historical drift: empty the index behind the triggers' back.
    db.exec("INSERT INTO sense_fts(sense_fts) VALUES('delete-all')")
    expect(ftsMatches(db, 'driftwood')).toBe(0)

    // Flag set -> reopening does NOT rebuild.
    closeDb()
    expect(ftsMatches(getDb(), 'driftwood')).toBe(0)

    // Flag cleared -> reopening repairs the index and restores the flag.
    getDb().prepare("DELETE FROM settings WHERE key = 'sense_fts_rebuilt'").run()
    closeDb()
    const repaired = getDb()
    expect(ftsMatches(repaired, 'driftwood')).toBe(1)
    expect((repaired.prepare("SELECT value FROM settings WHERE key = 'sense_fts_rebuilt'").get() as { value: string }).value).toBe('1')
  })
})
