import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir, getDbPath } from './paths'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  _db = new Database(getDbPath())
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
  migrateCreateTodosTable(_db)
  migrateAddTodoNotesColumn(_db)
  migrateAddTodoGroupColumn(_db)
  migrateCreateProjectsTable(_db)
  migrateAddProjectIdColumns(_db)
  migrateAddProjectDeadlineColumn(_db)
  migrateAddTodoSortOrder(_db)
  migrateAddFavoritedColumn(_db)
  migrateAddIconSeedColumn(_db)
  migrateCreateCollectionsTable(_db)
  migrateCreateJournalTable(_db)
  migrateAddMessageUpdatedAt(_db)
  migrateCreatePendingApprovalsTable(_db)
  migrateCreateJournalCommentsTable(_db)

  return _db
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
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      summary TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT,
      streaming INTEGER,
      kind TEXT,
      name TEXT,
      summary TEXT,
      status TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, position);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
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

function migrateCreateTodosTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function migrateAddTodoNotesColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(todos)') as { name: string }[]
  if (!columns.some(c => c.name === 'notes')) {
    db.exec("ALTER TABLE todos ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
  }
}

function migrateAddTodoGroupColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(todos)') as { name: string }[]
  if (!columns.some(c => c.name === 'group_name')) {
    db.exec("ALTER TABLE todos ADD COLUMN group_name TEXT NOT NULL DEFAULT ''")
  }
}

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

    CREATE TABLE IF NOT EXISTS project_resources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_resources_project ON project_resources(project_id);
  `)
}

function migrateAddProjectIdColumns(db: Database.Database): void {
  const sessionCols = db.pragma('table_info(sessions)') as { name: string }[]
  if (!sessionCols.some(c => c.name === 'project_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL')
  }

  const todoCols = db.pragma('table_info(todos)') as { name: string }[]
  if (!todoCols.some(c => c.name === 'project_id')) {
    db.exec('ALTER TABLE todos ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL')
  }
}

function migrateAddProjectDeadlineColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(projects)') as { name: string }[]
  if (!columns.some(c => c.name === 'deadline')) {
    db.exec('ALTER TABLE projects ADD COLUMN deadline TEXT')
  }
}

function migrateAddTodoSortOrder(db: Database.Database): void {
  const columns = db.pragma('table_info(todos)') as { name: string }[]
  if (!columns.some(c => c.name === 'sort_order')) {
    db.exec('ALTER TABLE todos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    // Backfill existing todos with sequential sort_order based on created_at
    const rows = db.prepare('SELECT id FROM todos ORDER BY created_at ASC').all() as { id: string }[]
    const stmt = db.prepare('UPDATE todos SET sort_order = ? WHERE id = ?')
    rows.forEach((row, i) => stmt.run(i, row.id))
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

function migrateCreateJournalTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_journal_created ON journal_entries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_journal_project ON journal_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_journal_author ON journal_entries(author);
  `)
}

function migrateAddMessageUpdatedAt(db: Database.Database): void {
  const columns = db.pragma('table_info(messages)') as { name: string }[]
  if (!columns.some(c => c.name === 'updated_at')) {
    db.exec("ALTER TABLE messages ADD COLUMN updated_at TEXT")
  }
}

function migrateCreatePendingApprovalsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      input TEXT,
      title TEXT,
      description TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_session ON pending_approvals(session_id);
  `)
}

function migrateCreateJournalCommentsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_comments (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_journal_comments_entry ON journal_comments(entry_id, created_at ASC);
  `)
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
