import type Database from 'better-sqlite3'

const STATE_CHECK = "'queued','preparing-workspace','running','needs-input','succeeded','failed','cancelled','interrupted'"

export function ensureAgentRunSchema(db: Database.Database): void {
  const hadRawLogTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_run_event_logs'").get())
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      agent_name TEXT NOT NULL,
      agent_label TEXT NOT NULL,
      verb TEXT NOT NULL,
      task_brief TEXT NOT NULL,
      paths_json TEXT NOT NULL CHECK(json_valid(paths_json)),
      workspace_json TEXT NOT NULL CHECK(json_valid(workspace_json)),
      repository_json TEXT CHECK(repository_json IS NULL OR json_valid(repository_json)),
      workspace_state_json TEXT NOT NULL DEFAULT '{"status":"pending","createdAt":null,"retainedAt":null,"discardedAt":null}' CHECK(json_valid(workspace_state_json)),
      base_sha TEXT,
      allowed_paths_json TEXT NOT NULL CHECK(json_valid(allowed_paths_json)),
      settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
      agent_definition_version TEXT NOT NULL,
      command_policy_version TEXT NOT NULL,
      acceptance_checks_json TEXT NOT NULL CHECK(json_valid(acceptance_checks_json)),
      resource_caps_json TEXT NOT NULL CHECK(json_valid(resource_caps_json)),
      checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
      summary_json TEXT CHECK(summary_json IS NULL OR json_valid(summary_json)),
      status TEXT NOT NULL CHECK(status IN (${STATE_CHECK})),
      result TEXT,
      error_class TEXT,
      error_message TEXT,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      completion_message_id TEXT UNIQUE,
      completion_inserted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created
      ON agent_runs(status, created_at);

    CREATE TABLE IF NOT EXISTS agent_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      from_state TEXT CHECK(from_state IS NULL OR from_state IN (${STATE_CHECK})),
      to_state TEXT CHECK(to_state IS NULL OR to_state IN (${STATE_CHECK})),
      data TEXT NOT NULL CHECK(json_valid(data)),
      created_at TEXT NOT NULL,
      UNIQUE(run_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_sequence
      ON agent_run_events(run_id, sequence);

    CREATE TABLE IF NOT EXISTS agent_run_event_logs (
      event_id INTEGER PRIMARY KEY REFERENCES agent_run_events(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      data TEXT NOT NULL CHECK(json_valid(data)),
      byte_count INTEGER NOT NULL CHECK(byte_count >= 0),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_run_event_logs_created
      ON agent_run_event_logs(created_at, event_id);

    CREATE TRIGGER IF NOT EXISTS agent_run_event_logs_no_update
    BEFORE UPDATE ON agent_run_event_logs
    BEGIN
      SELECT RAISE(ABORT, 'agent run raw logs are append-only');
    END;

    CREATE TABLE IF NOT EXISTS agent_run_questions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('command-allowlist')),
      command_argv_json TEXT NOT NULL CHECK(json_valid(command_argv_json)),
      reason TEXT NOT NULL,
      proposed_allowlist_addition TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','denied')),
      response TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      UNIQUE(run_id, command_argv_json)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_run_questions_run_status
      ON agent_run_questions(run_id, status, created_at);

    CREATE TABLE IF NOT EXISTS agent_run_publications (
      run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
      repository TEXT NOT NULL,
      remote TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      head_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('pending','publishing','published','failed')),
      pr_number INTEGER,
      pr_node_id TEXT,
      pr_url TEXT,
      q_review_required INTEGER NOT NULL DEFAULT 0 CHECK(q_review_required IN (0,1)),
      q_review_status TEXT NOT NULL DEFAULT 'not-required' CHECK(q_review_status IN ('not-required','pending','posted','failed')),
      q_comment_id INTEGER,
      q_comment_url TEXT,
      error_class TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_run_updates (
      run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
      pr_number INTEGER NOT NULL CHECK(pr_number > 0),
      merge_commit_sha TEXT NOT NULL,
      merged_at TEXT NOT NULL,
      changed_paths_json TEXT NOT NULL CHECK(json_valid(changed_paths_json)),
      risk TEXT NOT NULL CHECK(risk IN ('renderer','daemon','scheduled')),
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('detected','deferred','ready','updating','applied','failed')),
      recovery_instructions TEXT,
      error_message TEXT,
      detected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_repositories (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      repo_root TEXT NOT NULL UNIQUE,
      base_ref TEXT NOT NULL,
      allowed_path_prefixes_json TEXT NOT NULL CHECK(json_valid(allowed_path_prefixes_json)),
      github_repository TEXT,
      remote TEXT,
      expected_remote_url TEXT,
      credential_ref TEXT,
      command_rules_json TEXT NOT NULL CHECK(json_valid(command_rules_json)),
      acceptance_checks_json TEXT NOT NULL CHECK(json_valid(acceptance_checks_json)),
      trusted_in_place INTEGER NOT NULL DEFAULT 0 CHECK(trusted_in_place IN (0,1)),
      built_in INTEGER NOT NULL DEFAULT 0 CHECK(built_in IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS agent_run_events_no_update
    BEFORE UPDATE ON agent_run_events
    BEGIN
      SELECT RAISE(ABORT, 'agent_run_events is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS agent_run_events_no_delete
    BEFORE DELETE ON agent_run_events
    WHEN EXISTS (SELECT 1 FROM agent_runs WHERE id = OLD.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'agent_run_events is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS agent_runs_immutable_dispatch
    BEFORE UPDATE OF
      idempotency_key, agent_name, agent_label, verb, task_brief, paths_json,
      workspace_json, repository_json, base_sha, allowed_paths_json, settings_json,
      agent_definition_version, command_policy_version,
      acceptance_checks_json, resource_caps_json, created_at
    ON agent_runs
    BEGIN
      SELECT RAISE(ABORT, 'agent run dispatch contract is immutable');
    END;
  `)

  const columns = db.pragma('table_info(agent_runs)') as Array<{ name: string }>
  if (!columns.some(column => column.name === 'workspace_state_json')) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN workspace_state_json TEXT NOT NULL DEFAULT '{"status":"pending","createdAt":null,"retainedAt":null,"discardedAt":null}' CHECK(json_valid(workspace_state_json))`)
  }
  if (!columns.some(column => column.name === 'attempt_count')) db.exec('ALTER TABLE agent_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0')
  if (!columns.some(column => column.name === 'retry_count')) db.exec('ALTER TABLE agent_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0')
  if (!columns.some(column => column.name === 'next_retry_at')) db.exec('ALTER TABLE agent_runs ADD COLUMN next_retry_at TEXT')
  if (!columns.some(column => column.name === 'summary_json')) db.exec('ALTER TABLE agent_runs ADD COLUMN summary_json TEXT CHECK(summary_json IS NULL OR json_valid(summary_json))')
  if (!columns.some(column => column.name === 'repository_json')) db.exec('ALTER TABLE agent_runs ADD COLUMN repository_json TEXT CHECK(repository_json IS NULL OR json_valid(repository_json))')

  const publicationTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_run_publications'").get() as { sql?: string } | undefined
  if (publicationTable?.sql?.includes("repository = 'shaunandrews/bond'")) db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE agent_run_publications_v2 (
      run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
      repository TEXT NOT NULL, remote TEXT NOT NULL, base_ref TEXT NOT NULL, head_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','publishing','published','failed')),
      pr_number INTEGER, pr_node_id TEXT, pr_url TEXT,
      q_review_required INTEGER NOT NULL DEFAULT 0 CHECK(q_review_required IN (0,1)),
      q_review_status TEXT NOT NULL DEFAULT 'not-required' CHECK(q_review_status IN ('not-required','pending','posted','failed')),
      q_comment_id INTEGER, q_comment_url TEXT, error_class TEXT, error_message TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT
    );
    INSERT INTO agent_run_publications_v2 SELECT * FROM agent_run_publications;
    DROP TABLE agent_run_publications;
    ALTER TABLE agent_run_publications_v2 RENAME TO agent_run_publications;
    PRAGMA foreign_keys = ON;
  `)

  if (!hadRawLogTable) db.exec(`
    INSERT OR IGNORE INTO agent_run_event_logs (event_id, run_id, data, byte_count, created_at)
    SELECT id, run_id, data, length(CAST(data AS BLOB)), created_at FROM agent_run_events;

    DROP TRIGGER agent_run_events_no_update;
    UPDATE agent_run_events SET data = '{}';
    CREATE TRIGGER agent_run_events_no_update
    BEFORE UPDATE ON agent_run_events
    BEGIN
      SELECT RAISE(ABORT, 'agent_run_events is append-only');
    END;
  `)
  db.exec(`
    UPDATE agent_runs SET summary_json = json_object(
      'status', status,
      'agentLabel', agent_label,
      'verb', verb,
      'brief', substr(task_brief, 1, 280),
      'finalReport', CASE WHEN result IS NULL THEN NULL ELSE substr(result, 1, 2000) END,
      'errorClass', error_class,
      'errorMessage', CASE WHEN error_message IS NULL THEN NULL ELSE substr(error_message, 1, 1000) END,
      'completedAt', completed_at
    )
    WHERE summary_json IS NULL AND status IN ('succeeded','failed','cancelled') AND completed_at IS NOT NULL;
  `)

  const deleteTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'agent_run_events_no_delete'").get() as { sql?: string } | undefined
  if (deleteTrigger?.sql && !deleteTrigger.sql.includes('WHEN EXISTS')) {
    db.exec(`
      DROP TRIGGER agent_run_events_no_delete;
      CREATE TRIGGER agent_run_events_no_delete
      BEFORE DELETE ON agent_run_events
      WHEN EXISTS (SELECT 1 FROM agent_runs WHERE id = OLD.run_id)
      BEGIN
        SELECT RAISE(ABORT, 'agent_run_events is append-only');
      END;
    `)
  }
}
