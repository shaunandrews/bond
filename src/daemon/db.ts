import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir, getDbPath } from './paths'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

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
  migrateCreateSenseTables(_db)
  migrateCreateOperativesTable(_db)
  migrateAddQuickColumn(_db)
  migrateAddCollectionFeatures(_db)
  migrateCreateCollectionItemCommentsTable(_db)
  migrateAddCollectionItemProjectId(_db)
  migrateJournalToCollection(_db)

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

      CREATE TRIGGER sense_fts_update AFTER UPDATE OF text_content ON sense_captures
        WHEN NEW.text_content IS NOT NULL BEGIN
          INSERT INTO sense_fts(sense_fts, rowid, text_content, app_name, window_title)
          VALUES ('delete', OLD.rowid, OLD.text_content, OLD.app_name, OLD.window_title);
          INSERT INTO sense_fts(rowid, text_content, app_name, window_title)
          VALUES (NEW.rowid, NEW.text_content, NEW.app_name, NEW.window_title);
      END;

      CREATE TRIGGER sense_fts_delete AFTER DELETE ON sense_captures
        WHEN OLD.text_content IS NOT NULL BEGIN
          INSERT INTO sense_fts(sense_fts, rowid, text_content, app_name, window_title)
          VALUES ('delete', OLD.rowid, OLD.text_content, OLD.app_name, OLD.window_title);
      END;
    `)
  }
}

function migrateCreateOperativesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operatives (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      session_id TEXT,
      sdk_session_id TEXT,
      worktree TEXT,
      branch TEXT,
      model TEXT,
      result_summary TEXT,
      error_message TEXT,
      exit_code INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      timeout_ms INTEGER,
      max_budget_usd REAL,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_operatives_status ON operatives(status);
    CREATE INDEX IF NOT EXISTS idx_operatives_session ON operatives(session_id);

    CREATE TABLE IF NOT EXISTS operative_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operative_id TEXT NOT NULL REFERENCES operatives(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_operative_events_operative ON operative_events(operative_id, id);
  `)
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

function migrateJournalToCollection(db: Database.Database): void {
  // Check if journal_entries table exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_entries'").all() as { name: string }[]
  if (tables.length === 0) return

  // Check if we've already migrated
  const migrated = db.prepare("SELECT value FROM settings WHERE key = 'journal_migrated_to_collection'").get() as { value: string } | undefined
  if (migrated) return

  const now = new Date().toISOString()

  // Check if a "Journal" collection already exists
  const existing = db.prepare("SELECT id FROM collections WHERE name = 'Journal'").get() as { id: string } | undefined

  const collectionId = existing?.id ?? randomUUID()

  if (!existing) {
    const schema = JSON.stringify([
      { name: 'title', type: 'text', primary: true },
      { name: 'body', type: 'longtext' },
      { name: 'author', type: 'select', options: ['user', 'bond'] },
      { name: 'tags', type: 'tags' },
      { name: 'pinned', type: 'boolean' }
    ])
    const features = JSON.stringify(['comments', 'projectLink', 'autoMeta', 'bondComment'])
    db.prepare(
      'INSERT INTO collections (id, name, icon, schema, features, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
    ).run(collectionId, 'Journal', '📓', schema, features, now, now)
  }

  // Migrate entries
  const entries = db.prepare(
    'SELECT id, author, title, body, tags, project_id, session_id, pinned, created_at, updated_at FROM journal_entries ORDER BY created_at ASC'
  ).all() as Array<{
    id: string; author: string; title: string; body: string; tags: string
    project_id: string | null; session_id: string | null; pinned: number
    created_at: string; updated_at: string
  }>

  const insertItem = db.prepare(
    'INSERT OR IGNORE INTO collection_items (id, collection_id, data, project_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )

  const insertComment = db.prepare(
    'INSERT OR IGNORE INTO collection_item_comments (id, item_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)'
  )

  db.transaction(() => {
    entries.forEach((entry, i) => {
      let tags: string[] = []
      try { tags = JSON.parse(entry.tags) } catch { /* empty */ }

      const data: Record<string, unknown> = {
        title: entry.title,
        body: entry.body,
        author: entry.author,
        tags,
        pinned: entry.pinned === 1,
      }
      if (entry.session_id) {
        data.sessionId = entry.session_id
      }

      insertItem.run(
        entry.id, collectionId, JSON.stringify(data),
        entry.project_id, i, entry.created_at, entry.updated_at
      )

      // Migrate comments for this entry
      const comments = db.prepare(
        'SELECT id, author, body, created_at FROM journal_comments WHERE entry_id = ? ORDER BY created_at ASC'
      ).all(entry.id) as Array<{ id: string; author: string; body: string; created_at: string }>

      for (const comment of comments) {
        insertComment.run(comment.id, entry.id, comment.author, comment.body, comment.created_at)
      }
    })

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('journal_migrated_to_collection', '1')
  })()
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
