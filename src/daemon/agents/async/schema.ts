import type Database from 'better-sqlite3'

const STATE_CHECK = "'queued','preparing-workspace','running','needs-input','succeeded','failed','cancelled','interrupted'"

export function ensureAgentRunSchema(db: Database.Database): void {
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
      workspace_state_json TEXT NOT NULL DEFAULT '{"status":"pending","createdAt":null,"retainedAt":null,"discardedAt":null}' CHECK(json_valid(workspace_state_json)),
      base_sha TEXT,
      allowed_paths_json TEXT NOT NULL CHECK(json_valid(allowed_paths_json)),
      settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
      agent_definition_version TEXT NOT NULL,
      command_policy_version TEXT NOT NULL,
      acceptance_checks_json TEXT NOT NULL CHECK(json_valid(acceptance_checks_json)),
      resource_caps_json TEXT NOT NULL CHECK(json_valid(resource_caps_json)),
      checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
      status TEXT NOT NULL CHECK(status IN (${STATE_CHECK})),
      result TEXT,
      error_class TEXT,
      error_message TEXT,
      recovery_count INTEGER NOT NULL DEFAULT 0,
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

    CREATE TRIGGER IF NOT EXISTS agent_run_events_no_update
    BEFORE UPDATE ON agent_run_events
    BEGIN
      SELECT RAISE(ABORT, 'agent_run_events is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS agent_run_events_no_delete
    BEFORE DELETE ON agent_run_events
    BEGIN
      SELECT RAISE(ABORT, 'agent_run_events is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS agent_runs_immutable_dispatch
    BEFORE UPDATE OF
      idempotency_key, agent_name, agent_label, verb, task_brief, paths_json,
      workspace_json, base_sha, allowed_paths_json, settings_json,
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
}
