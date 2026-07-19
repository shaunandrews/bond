import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir, getDbPath } from './paths'
import { ensureTranscriptSchema, messagesTableDdl, transcriptPrereqDdl } from './transcript'
import { ensureMemorySchema } from './memory/store'

/** Increment when the persisted Bond product schema is intentionally replaced. */
export const APP_SCHEMA_VERSION = 2

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  resetIfSchemaChanged()
  _db = new Database(getDbPath())
  // Checkpoint any pending WAL from previous processes before setting up
  try { _db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* best effort */ }
  _db.pragma('journal_mode = WAL')
  _db.pragma('busy_timeout = 5000')
  _db.pragma('synchronous = NORMAL')
  _db.pragma('foreign_keys = ON')

  createSchema(_db)
  migrateAddImagesColumn(_db)
  migrateAddEditModeColumn(_db)
  migrateCreateImagesTable(_db)
  migrateFromFiles(_db)
  migrateInlineImages(_db)
  migrateAddSiteIdColumn(_db)
  migrateCreateProjectsTable(_db)
  migrateAddProjectIdColumns(_db)
  migrateAddFavoritedColumn(_db)
  migrateAddIconSeedColumn(_db)
  migrateCreateCollectionsTable(_db)
  migrateAddMessageUpdatedAt(_db)
  migrateAddMessageDataColumn(_db)
  migrateCreateSenseTables(_db)
  migrateFixSenseFtsUpdateTrigger(_db)
  migrateRebuildSenseFts(_db)
  migrateAddQuickColumn(_db)
  migrateAddCollectionFeatures(_db)
  migrateAddCollectionIssuePrefix(_db)
  migrateCreateCollectionItemCommentsTable(_db)
  migrateAddCollectionItemProjectId(_db)
  migrateAddCollectionItemDisplayNumber(_db)
  retireLegacyJournalCollection(_db)
  migrateCreateSenseMemoryTables(_db)
  migrateDropRetiredTables(_db)
  ensureTranscriptSchema(_db)
  ensureMemorySchema(_db)

  return _db
}

type SchemaProbe =
  | { kind: 'current' }
  | { kind: 'stale'; preserveLegacyJournal: boolean }
  | { kind: 'unreadable'; error: unknown }

function probeSchemaVersion(path: string): SchemaProbe {
  let db: Database.Database | null = null
  try {
    db = new Database(path)
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get()
    if (table) {
      const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('schema_version') as { value: string } | undefined
      const version = row ? Number(row.value) : null
      return version === APP_SCHEMA_VERSION ? { kind: 'current' } : { kind: 'stale', preserveLegacyJournal: false }
    }
    // Journal is an independent product table; retain it when opening a
    // database created for that standalone data-layer operation.
    const journal = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_entries'").get())
    return { kind: 'stale', preserveLegacyJournal: journal }
  } catch (error) {
    return { kind: 'unreadable', error }
  } finally {
    try { db?.close() } catch { /* best effort */ }
  }
}

/**
 * Bond's chat model is deliberately a clean cutover: a READABLE database with
 * a missing or stale version belongs to the pre-continuous-Bond product and
 * is wiped along with its Pi sessions and images. A database that cannot even
 * be read (corruption, permissions, a torn WAL) is a different situation —
 * destroying the user's history over it is never acceptable, so it gets
 * quarantined with a rename and everything else is left in place.
 */
function resetIfSchemaChanged(): void {
  const path = getDbPath()
  if (!existsSync(path)) return

  const probe = probeSchemaVersion(path)
  if (probe.kind === 'current') return
  if (probe.kind === 'unreadable') {
    quarantineUnreadableDb(path, probe.error)
    return
  }
  if (probe.preserveLegacyJournal) return

  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(`${path}${suffix}`) } catch { /* absent */ }
  }
  const piSessions = join(getDataDir(), 'pi', 'sessions')
  try {
    for (const file of readdirSync(piSessions)) unlinkSync(join(piSessions, file))
  } catch { /* directory may not exist */ }
  // Images have session foreign keys and are not useful without their rows.
  try {
    for (const file of readdirSync(join(getDataDir(), 'images'))) unlinkSync(join(getDataDir(), 'images', file))
  } catch { /* directory may not exist */ }
}

function quarantineUnreadableDb(path: string, error: unknown): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${path}.corrupt-${stamp}`
  try {
    renameSync(path, target)
    for (const suffix of ['-wal', '-shm']) {
      try { renameSync(`${path}${suffix}`, `${target}${suffix}`) } catch { /* absent */ }
    }
    console.error(
      `[bond] DATABASE UNREADABLE — quarantined instead of wiping.\n` +
      `[bond]   moved ${path} -> ${target}\n` +
      `[bond]   Pi sessions and images were left untouched.\n` +
      `[bond]   original error: ${error instanceof Error ? error.message : String(error)}`
    )
  } catch (renameError) {
    // Quarantine itself failed (permissions?). Leave everything in place —
    // the open that follows will fail loudly, which beats deleting anything.
    console.error(`[bond] DATABASE UNREADABLE and quarantine rename failed: ${String(renameError)}`)
  }
}

export function closeDb(): void {
  if (_db) {
    try { _db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* best effort */ }
    _db.close()
    _db = null
  }
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      summary TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  // transcript.ts is the single owner of the messages table shape. A fresh
  // install gets the canonical DDL directly — no legacy shape, no rebuild.
  // Epochs and turns must exist first: messages carries FK references to
  // both, and with foreign_keys = ON a missing parent table fails every
  // insert (migrateFromFiles writes messages before ensureTranscriptSchema).
  db.exec(transcriptPrereqDdl())
  db.exec(messagesTableDdl('messages'))

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, position);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('schema_version', String(APP_SCHEMA_VERSION))
}

function migrateAddImagesColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[]
  if (!columns.some(c => c.name === 'images')) {
    db.exec('ALTER TABLE messages ADD COLUMN images TEXT')
  }
}

function migrateAddEditModeColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(sessions)') as { name: string }[]
  if (!columns.some(c => c.name === 'edit_mode')) {
    db.exec("ALTER TABLE sessions ADD COLUMN edit_mode TEXT NOT NULL DEFAULT '{\"type\":\"full\"}'")
  }
}

function migrateCreateImagesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_images_session ON images(session_id);
  `)
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

function migrateInlineImages(db: Database.Database): void {
  // Check if already migrated
  const flag = db.prepare('SELECT value FROM settings WHERE key = ?').get('images_migrated') as { value: string } | undefined
  if (flag?.value === '1') return

  const rows = db.prepare('SELECT id, session_id, images FROM messages WHERE images IS NOT NULL').all() as
    { id: string; session_id: string; images: string }[]
  if (rows.length === 0) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('images_migrated', '1')
    return
  }

  const imagesDir = join(getDataDir(), 'images')
  mkdirSync(imagesDir, { recursive: true })

  const insertImage = db.prepare(
    'INSERT INTO images (id, session_id, filename, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const updateMsg = db.prepare('UPDATE messages SET images = ? WHERE id = ?')

  const migrate = db.transaction(() => {
    const now = new Date().toISOString()

    for (const row of rows) {
      let parsed: unknown
      try { parsed = JSON.parse(row.images) } catch { continue }
      if (!Array.isArray(parsed) || parsed.length === 0) continue

      // Skip if already migrated (array of strings = image IDs)
      if (typeof parsed[0] === 'string') continue

      // Old format: array of { data, mediaType } objects
      const imageIds: string[] = []
      for (const img of parsed) {
        if (!img || typeof img.data !== 'string' || typeof img.mediaType !== 'string') continue
        const id = randomUUID()
        const ext = MIME_TO_EXT[img.mediaType] ?? '.png'
        const filename = `${id}${ext}`
        const buf = Buffer.from(img.data, 'base64')

        writeFileSync(join(imagesDir, filename), buf)
        insertImage.run(id, row.session_id, filename, img.mediaType, buf.length, now)
        imageIds.push(id)
      }

      if (imageIds.length > 0) {
        updateMsg.run(JSON.stringify(imageIds), row.id)
      }
    }

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('images_migrated', '1')
  })

  migrate()
}

function migrateAddSiteIdColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(sessions)') as { name: string }[]
  if (!columns.some(c => c.name === 'site_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN site_id TEXT')
  }
}

/**
 * Projects is a retired feature, but the TABLE must stay as a stub:
 * `sessions`, `collection_items`, `sense_debriefs`, and `sense_facts` all
 * hold live `REFERENCES projects(id)` foreign keys, and with
 * `PRAGMA foreign_keys = ON` dropping the parent table would break inserts
 * on all four. Nothing reads or writes projects anymore.
 */
function migrateCreateProjectsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'generic',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function migrateAddProjectIdColumns(db: Database.Database): void {
  const sessionCols = db.pragma('table_info(sessions)') as { name: string }[]
  if (!sessionCols.some(c => c.name === 'project_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL')
  }
}

function migrateAddFavoritedColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(sessions)') as { name: string }[]
  if (!columns.some(c => c.name === 'favorited')) {
    db.exec('ALTER TABLE sessions ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0')
  }
}

function migrateAddIconSeedColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(sessions)') as { name: string }[]
  if (!columns.some(c => c.name === 'icon_seed')) {
    db.exec('ALTER TABLE sessions ADD COLUMN icon_seed INTEGER')
  }
}

function migrateCreateCollectionsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      schema TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(schema)),
      issue_prefix TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_items (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items(collection_id);
  `)
}

function migrateAddMessageUpdatedAt(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[]
  if (!columns.some(c => c.name === 'updated_at')) {
    db.exec("ALTER TABLE messages ADD COLUMN updated_at TEXT")
  }
}

function migrateAddMessageDataColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[]
  if (!columns.some(c => c.name === 'data')) {
    db.exec('ALTER TABLE messages ADD COLUMN data TEXT')
  }
}

function migrateCreateSenseTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sense_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      capture_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sense_captures (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sense_sessions(id) ON DELETE CASCADE,
      captured_at TEXT NOT NULL,
      image_path TEXT,
      app_name TEXT,
      app_bundle_id TEXT,
      window_title TEXT,
      visible_windows TEXT DEFAULT '[]',
      text_source TEXT NOT NULL DEFAULT 'pending',
      text_status TEXT NOT NULL DEFAULT 'pending',
      text_content TEXT,
      capture_trigger TEXT,
      ambiguous INTEGER NOT NULL DEFAULT 0,
      image_purged_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sense_captures_session ON sense_captures(session_id);
    CREATE INDEX IF NOT EXISTS idx_sense_captures_time ON sense_captures(captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sense_captures_app ON sense_captures(app_name);
    CREATE INDEX IF NOT EXISTS idx_sense_captures_status ON sense_captures(text_status);

    CREATE TABLE IF NOT EXISTS sense_app_text_quality (
      bundle_id TEXT PRIMARY KEY,
      preferred_source TEXT NOT NULL DEFAULT 'accessibility',
      avg_accessibility_chars INTEGER NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `)

  // FTS5 virtual table — create only if it doesn't exist
  // (virtual tables don't support IF NOT EXISTS in all SQLite versions)
  const hasFts = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sense_fts'"
  ).get()

  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE sense_fts USING fts5(
        text_content,
        app_name,
        window_title,
        content=sense_captures,
        content_rowid=rowid
      );

      CREATE TRIGGER sense_fts_insert AFTER INSERT ON sense_captures
        WHEN NEW.text_content IS NOT NULL BEGIN
          INSERT INTO sense_fts(rowid, text_content, app_name, window_title)
          VALUES (NEW.rowid, NEW.text_content, NEW.app_name, NEW.window_title);
      END;

      ${SENSE_FTS_UPDATE_TRIGGER}

      CREATE TRIGGER sense_fts_delete AFTER DELETE ON sense_captures
        WHEN OLD.text_content IS NOT NULL BEGIN
          INSERT INTO sense_fts(sense_fts, rowid, text_content, app_name, window_title)
          VALUES ('delete', OLD.rowid, OLD.text_content, OLD.app_name, OLD.window_title);
      END;
    `)
  }
}

/**
 * The update trigger must handle NULL text transitions per-half: emit the
 * external-content 'delete' only when the OLD row was actually indexed, and
 * insert only when the NEW row is indexable. The original single
 * `WHEN NEW.text_content IS NOT NULL` guard skipped the whole trigger on a
 * text -> NULL transition, stranding a stale index entry, and emitted a
 * bogus 'delete' for never-indexed rows on NULL -> text.
 */
const SENSE_FTS_UPDATE_TRIGGER = `
      CREATE TRIGGER sense_fts_update AFTER UPDATE OF text_content ON sense_captures BEGIN
        INSERT INTO sense_fts(sense_fts, rowid, text_content, app_name, window_title)
        SELECT 'delete', OLD.rowid, OLD.text_content, OLD.app_name, OLD.window_title
        WHERE OLD.text_content IS NOT NULL;
        INSERT INTO sense_fts(rowid, text_content, app_name, window_title)
        SELECT NEW.rowid, NEW.text_content, NEW.app_name, NEW.window_title
        WHERE NEW.text_content IS NOT NULL;
      END;
`

/** Replace the mis-guarded update trigger on databases that predate the fix. */
function migrateFixSenseFtsUpdateTrigger(db: Database.Database): void {
  db.exec(`DROP TRIGGER IF EXISTS sense_fts_update;\n${SENSE_FTS_UPDATE_TRIGGER}`)
}

/**
 * One-time index rebuild to repair drift accumulated while the update trigger
 * mishandled NULL transitions (and while nothing queried the index to notice).
 * Guarded by a settings flag, same pattern as `images_migrated`.
 */
function migrateRebuildSenseFts(db: Database.Database): void {
  const flag = db.prepare('SELECT value FROM settings WHERE key = ?').get('sense_fts_rebuilt') as { value: string } | undefined
  if (flag?.value === '1') return
  db.exec("INSERT INTO sense_fts(sense_fts) VALUES('rebuild')")
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('sense_fts_rebuilt', '1')
}

function migrateAddQuickColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(sessions)') as { name: string }[]
  if (!columns.some(c => c.name === 'quick')) {
    db.exec('ALTER TABLE sessions ADD COLUMN quick INTEGER DEFAULT 0')
  }
}

function migrateAddCollectionFeatures(db: Database.Database): void {
  const columns = db.pragma('table_info(collections)') as { name: string }[]
  if (!columns.some(c => c.name === 'features')) {
    db.exec("ALTER TABLE collections ADD COLUMN features TEXT NOT NULL DEFAULT '[]'")
  }
}

function migrateAddCollectionIssuePrefix(db: Database.Database): void {
  const columns = db.pragma('table_info(collections)') as { name: string }[]
  if (!columns.some(c => c.name === 'issue_prefix')) {
    db.exec("ALTER TABLE collections ADD COLUMN issue_prefix TEXT NOT NULL DEFAULT ''")
  }
  db.prepare("UPDATE collections SET issue_prefix = 'BOND' WHERE name = 'Bond Issues' AND issue_prefix = ''").run()
}

function migrateCreateCollectionItemCommentsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_item_comments (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES collection_items(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collection_item_comments_item ON collection_item_comments(item_id, created_at ASC);
  `)
}

function migrateAddCollectionItemProjectId(db: Database.Database): void {
  const columns = db.pragma('table_info(collection_items)') as { name: string }[]
  if (!columns.some(c => c.name === 'project_id')) {
    db.exec('ALTER TABLE collection_items ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL')
  }
}

/** Give every item a stable, collection-local reference number for human use. */
function migrateAddCollectionItemDisplayNumber(db: Database.Database): void {
  const columns = db.pragma('table_info(collection_items)') as { name: string }[]
  if (!columns.some(c => c.name === 'display_number')) {
    db.exec('ALTER TABLE collection_items ADD COLUMN display_number INTEGER NOT NULL DEFAULT 0')
  }

  const collections = db.prepare('SELECT id FROM collections').all() as { id: string }[]
  const update = db.prepare('UPDATE collection_items SET display_number = ? WHERE id = ?')
  const assign = db.transaction(() => {
    for (const collection of collections) {
      const items = db.prepare('SELECT id FROM collection_items WHERE collection_id = ? ORDER BY created_at ASC, id ASC').all(collection.id) as { id: string }[]
      items.forEach((item, index) => update.run(index + 1, item.id))
    }
  })
  assign()
}

function retireLegacyJournalCollection(db: Database.Database): void {
  // Older releases migrated journal entries into a visible special collection.
  // Journal is no longer a Bond feature, so remove only that known generated copy.
  // The original journal_entries rows remain intact as a recovery fallback.
  const journal = db.prepare(`
    SELECT id FROM collections
    WHERE name = 'Journal'
      AND features LIKE '%"autoMeta"%'
      AND features LIKE '%"bondComment"%'
  `).get() as { id: string } | undefined
  if (journal) {
    db.prepare('DELETE FROM collections WHERE id = ?').run(journal.id)
  }
}

// --- One-time migration from file-based storage ---

interface OldSessionFile {
  session: {
    id: string
    title: string
    summary: string
    archived: boolean
    createdAt: string
    updatedAt: string
  }
  messages: Array<{
    id: string
    role: string
    text?: string
    streaming?: boolean
    kind?: string
    name?: string
    summary?: string
    status?: string
  }>
}

function migrateFromFiles(db: Database.Database): void {
  const dataDir = getDataDir()
  const sessionsDir = join(dataDir, 'sessions')

  if (!existsSync(sessionsDir)) return

  const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
  if (files.length === 0) return

  // Check if we already have sessions (don't re-migrate)
  const count = db.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }
  if (count.n > 0) return

  const insertSession = db.prepare(
    'INSERT OR IGNORE INTO sessions (id, title, summary, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const insertMessage = db.prepare(
    'INSERT OR IGNORE INTO messages (id, session_id, position, role, text, streaming, kind, name, summary, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )

  const migrate = db.transaction(() => {
    for (const file of files) {
      try {
        const raw = readFileSync(join(sessionsDir, file), 'utf-8')
        const data = JSON.parse(raw) as OldSessionFile
        const s = data.session

        insertSession.run(s.id, s.title, s.summary, s.archived ? 1 : 0, s.createdAt, s.updatedAt)

        for (let i = 0; i < data.messages.length; i++) {
          const m = data.messages[i]
          insertMessage.run(
            m.id, s.id, i, m.role,
            m.text ?? null,
            m.streaming ? 1 : null,
            m.kind ?? null,
            m.name ?? null,
            m.summary ?? null,
            m.status ?? null
          )
        }
      } catch {
        // Skip malformed files
      }
    }
  })

  migrate()

  // Migrate settings files
  const soulPath = join(dataDir, 'soul.md')
  const modelPath = join(dataDir, 'model.txt')
  const accentPath = join(dataDir, 'accent-color.txt')

  const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')

  if (existsSync(soulPath)) {
    try {
      upsertSetting.run('soul', readFileSync(soulPath, 'utf-8'))
      unlinkSync(soulPath)
    } catch { /* ignore */ }
  }
  if (existsSync(modelPath)) {
    try {
      upsertSetting.run('model', readFileSync(modelPath, 'utf-8').trim())
      unlinkSync(modelPath)
    } catch { /* ignore */ }
  }
  if (existsSync(accentPath)) {
    try {
      upsertSetting.run('accent_color', readFileSync(accentPath, 'utf-8').trim())
      unlinkSync(accentPath)
    } catch { /* ignore */ }
  }

  // Move old sessions directory out of the way
  try {
    renameSync(sessionsDir, join(dataDir, 'sessions.bak'))
  } catch { /* ignore */ }
}

function migrateCreateSenseMemoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sense_debriefs (
      id TEXT PRIMARY KEY,
      session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      session_title TEXT NOT NULL DEFAULT '',
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,

      summary TEXT NOT NULL,
      topics TEXT NOT NULL DEFAULT '[]',
      decisions TEXT NOT NULL DEFAULT '[]',
      open_threads TEXT NOT NULL DEFAULT '[]',
      key_facts TEXT NOT NULL DEFAULT '[]',

      topics_text TEXT NOT NULL DEFAULT '',
      decisions_text TEXT NOT NULL DEFAULT '',
      open_threads_text TEXT NOT NULL DEFAULT '',
      key_facts_text TEXT NOT NULL DEFAULT '',

      message_count INTEGER NOT NULL DEFAULT 0,
      duration_seconds INTEGER NOT NULL DEFAULT 0,

      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sense_debriefs_created ON sense_debriefs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sense_debriefs_project ON sense_debriefs(project_id);

    CREATE TABLE IF NOT EXISTS sense_facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      source_debrief_id TEXT REFERENCES sense_debriefs(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sense_facts_active ON sense_facts(active, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sense_facts_project ON sense_facts(project_id);
  `)

  // FTS5 virtual table — guard with existence check (same pattern as sense_fts)
  const hasDebriefFts = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sense_debriefs_fts'"
  ).get()

  if (!hasDebriefFts) {
    db.exec(`
      CREATE VIRTUAL TABLE sense_debriefs_fts USING fts5(
        summary,
        topics_text,
        decisions_text,
        open_threads_text,
        key_facts_text,
        session_title,
        content=sense_debriefs,
        content_rowid=rowid
      );

      CREATE TRIGGER sense_debriefs_fts_insert AFTER INSERT ON sense_debriefs BEGIN
        INSERT INTO sense_debriefs_fts(rowid, summary, topics_text, decisions_text, open_threads_text, key_facts_text, session_title)
        VALUES (NEW.rowid, NEW.summary, NEW.topics_text, NEW.decisions_text, NEW.open_threads_text, NEW.key_facts_text, NEW.session_title);
      END;

      CREATE TRIGGER sense_debriefs_fts_delete AFTER DELETE ON sense_debriefs BEGIN
        INSERT INTO sense_debriefs_fts(sense_debriefs_fts, rowid, summary, topics_text, decisions_text, open_threads_text, key_facts_text, session_title)
        VALUES ('delete', OLD.rowid, OLD.summary, OLD.topics_text, OLD.decisions_text, OLD.open_threads_text, OLD.key_facts_text, OLD.session_title);
      END;

      CREATE TRIGGER sense_debriefs_fts_update AFTER UPDATE ON sense_debriefs BEGIN
        INSERT INTO sense_debriefs_fts(sense_debriefs_fts, rowid, summary, topics_text, decisions_text, open_threads_text, key_facts_text, session_title)
        VALUES ('delete', OLD.rowid, OLD.summary, OLD.topics_text, OLD.decisions_text, OLD.open_threads_text, OLD.key_facts_text, OLD.session_title);
        INSERT INTO sense_debriefs_fts(rowid, summary, topics_text, decisions_text, open_threads_text, key_facts_text, session_title)
        VALUES (NEW.rowid, NEW.summary, NEW.topics_text, NEW.decisions_text, NEW.open_threads_text, NEW.key_facts_text, NEW.session_title);
      END;
    `)
  }
}

/**
 * Retired tables — created and migrated by earlier product iterations,
 * referenced by no code anymore. Legacy journal entries are exported to a
 * JSON backup before the drop (same preservation intent that keeps a
 * pre-app_meta standalone-journal DB from being wiped in
 * resetIfSchemaChanged). Children are dropped before parents so live FK
 * enforcement never sees an orphaned child table.
 */
function migrateDropRetiredTables(db: Database.Database): void {
  const hasJournal = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_entries'").get()
  if (hasJournal) {
    const entries = db.prepare('SELECT * FROM journal_entries').all()
    if (entries.length > 0) {
      const hasComments = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_comments'").get()
      const comments = hasComments ? db.prepare('SELECT * FROM journal_comments').all() : []
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = join(getDataDir(), `journal-legacy-backup-${stamp}.json`)
      writeFileSync(backupPath, JSON.stringify({ entries, comments }, null, 2))
      console.log(`[bond] Legacy journal preserved: ${entries.length} entries exported to ${backupPath}`)
    }
  }

  db.exec(`
    DROP TABLE IF EXISTS operative_events;
    DROP TABLE IF EXISTS operatives;
    DROP TABLE IF EXISTS journal_comments;
    DROP TABLE IF EXISTS journal_entries;
    DROP TABLE IF EXISTS project_resources;
    DROP TABLE IF EXISTS todos;
    DROP TABLE IF EXISTS pending_approvals;
  `)
}
