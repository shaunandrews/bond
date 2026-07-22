import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  AGENT_RUN_STATES,
  TERMINAL_AGENT_RUN_STATES,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunResourceCaps,
  type AgentRunState,
  type AgentRunWorkspace,
  type AgentRunWorkspaceState,
} from '../../../shared/agent-runs'
import type { AgentSettings } from '../../../shared/agents'
import { getDb } from '../../db'
import { ensureAgentRunSchema } from './schema'

type RunRow = {
  id: string
  idempotency_key: string
  agent_name: string
  agent_label: string
  verb: string
  task_brief: string
  paths_json: string
  workspace_json: string
  workspace_state_json: string
  base_sha: string | null
  allowed_paths_json: string
  settings_json: string
  agent_definition_version: string
  command_policy_version: string
  acceptance_checks_json: string
  resource_caps_json: string
  checkpoint_json: string | null
  status: AgentRunState
  result: string | null
  error_class: string | null
  error_message: string | null
  recovery_count: number
  completion_message_id: string | null
  completion_inserted_at: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  cancelled_at: string | null
}

type EventRow = {
  id: number
  run_id: string
  sequence: number
  type: string
  from_state: AgentRunState | null
  to_state: AgentRunState | null
  data: string
  created_at: string
}

export interface CreateAgentRunRecord {
  id?: string
  idempotencyKey: string
  agent: string
  agentLabel: string
  verb: string
  brief: string
  paths: string[]
  workspace: AgentRunWorkspace
  workspaceState?: AgentRunWorkspaceState
  baseSha: string | null
  allowedPaths: string[]
  settings: AgentSettings
  agentDefinitionVersion: string
  commandPolicyVersion: string
  acceptanceChecks: string[]
  resourceCaps: AgentRunResourceCaps
  now?: string
}

export interface TransitionOptions {
  eventType: string
  data?: Record<string, unknown>
  result?: string | null
  errorClass?: string | null
  errorMessage?: string | null
  checkpoint?: Record<string, unknown> | null
  now?: string
}

const TRANSITIONS: Record<AgentRunState, readonly AgentRunState[]> = {
  queued: ['preparing-workspace', 'cancelled'],
  'preparing-workspace': ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['needs-input', 'succeeded', 'failed', 'cancelled', 'interrupted'],
  'needs-input': ['running', 'failed', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: ['preparing-workspace', 'running', 'failed', 'cancelled'],
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function rowToRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    agent: row.agent_name,
    agentLabel: row.agent_label,
    verb: row.verb,
    brief: row.task_brief,
    paths: parseJson<string[]>(row.paths_json),
    workspace: parseJson<AgentRunWorkspace>(row.workspace_json),
    workspaceState: parseJson<AgentRunWorkspaceState>(row.workspace_state_json),
    baseSha: row.base_sha,
    allowedPaths: parseJson<string[]>(row.allowed_paths_json),
    settings: parseJson<AgentSettings>(row.settings_json),
    agentDefinitionVersion: row.agent_definition_version,
    commandPolicyVersion: row.command_policy_version,
    acceptanceChecks: parseJson<string[]>(row.acceptance_checks_json),
    resourceCaps: parseJson<AgentRunResourceCaps>(row.resource_caps_json),
    checkpoint: row.checkpoint_json ? parseJson<Record<string, unknown>>(row.checkpoint_json) : null,
    status: row.status,
    result: row.result,
    errorClass: row.error_class,
    errorMessage: row.error_message,
    recoveryCount: row.recovery_count,
    completionMessageId: row.completion_message_id,
    completionInsertedAt: row.completion_inserted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  }
}

function rowToEvent(row: EventRow): AgentRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    fromState: row.from_state,
    toState: row.to_state,
    data: parseJson<Record<string, unknown>>(row.data),
    createdAt: row.created_at,
  }
}

function dbFor(db?: Database.Database): Database.Database {
  const resolved = db ?? getDb()
  ensureAgentRunSchema(resolved)
  return resolved
}

function nextSequence(db: Database.Database, runId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_run_events WHERE run_id = ?').get(runId) as { sequence: number }
  return row.sequence
}

function insertEvent(
  db: Database.Database,
  runId: string,
  type: string,
  fromState: AgentRunState | null,
  toState: AgentRunState | null,
  data: Record<string, unknown>,
  now: string,
): void {
  db.prepare(`
    INSERT INTO agent_run_events (run_id, sequence, type, from_state, to_state, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(runId, nextSequence(db, runId), type, fromState, toState, JSON.stringify(data), now)
}

function assertMatchingDispatch(existing: AgentRun, input: CreateAgentRunRecord): void {
  const expected = {
    agent: input.agent,
    agentLabel: input.agentLabel,
    verb: input.verb,
    brief: input.brief,
    paths: input.paths,
    workspace: input.workspace,
    baseSha: input.baseSha,
    allowedPaths: input.allowedPaths,
    settings: input.settings,
    agentDefinitionVersion: input.agentDefinitionVersion,
    commandPolicyVersion: input.commandPolicyVersion,
    acceptanceChecks: input.acceptanceChecks,
    resourceCaps: input.resourceCaps,
  }
  const actual = {
    agent: existing.agent,
    agentLabel: existing.agentLabel,
    verb: existing.verb,
    brief: existing.brief,
    paths: existing.paths,
    workspace: existing.workspace,
    baseSha: existing.baseSha,
    allowedPaths: existing.allowedPaths,
    settings: existing.settings,
    agentDefinitionVersion: existing.agentDefinitionVersion,
    commandPolicyVersion: existing.commandPolicyVersion,
    acceptanceChecks: existing.acceptanceChecks,
    resourceCaps: existing.resourceCaps,
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Idempotency key "${input.idempotencyKey}" already belongs to a different agent run.`)
  }
}

export function createAgentRunRecord(input: CreateAgentRunRecord, dbArg?: Database.Database): { run: AgentRun; created: boolean } {
  const db = dbFor(dbArg)
  const existing = getAgentRunByIdempotencyKey(input.idempotencyKey, db)
  if (existing) {
    assertMatchingDispatch(existing, input)
    return { run: existing, created: false }
  }

  const id = input.id ?? randomUUID()
  const now = input.now ?? nowIso()
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO agent_runs (
          id, idempotency_key, agent_name, agent_label, verb, task_brief,
          paths_json, workspace_json, workspace_state_json, base_sha, allowed_paths_json,
          settings_json, agent_definition_version, command_policy_version,
          acceptance_checks_json, resource_caps_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(
        id, input.idempotencyKey, input.agent, input.agentLabel, input.verb, input.brief,
        JSON.stringify(input.paths), JSON.stringify(input.workspace), JSON.stringify(input.workspaceState ?? {
          status: input.workspace.isolation === 'worktree' ? 'pending' : 'ready',
          createdAt: null,
          retainedAt: null,
          discardedAt: null,
        }), input.baseSha,
        JSON.stringify(input.allowedPaths), JSON.stringify(input.settings),
        input.agentDefinitionVersion, input.commandPolicyVersion,
        JSON.stringify(input.acceptanceChecks), JSON.stringify(input.resourceCaps), now, now,
      )
      insertEvent(db, id, 'dispatched', null, 'queued', {}, now)
    })()
  } catch (error) {
    const raced = getAgentRunByIdempotencyKey(input.idempotencyKey, db)
    if (raced) {
      assertMatchingDispatch(raced, input)
      return { run: raced, created: false }
    }
    throw error
  }
  return { run: getAgentRun(id, db)!, created: true }
}

export function getAgentRun(id: string, dbArg?: Database.Database): AgentRun | null {
  const db = dbFor(dbArg)
  const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as RunRow | undefined
  return row ? rowToRun(row) : null
}

export function getAgentRunByIdempotencyKey(key: string, dbArg?: Database.Database): AgentRun | null {
  const db = dbFor(dbArg)
  const row = db.prepare('SELECT * FROM agent_runs WHERE idempotency_key = ?').get(key) as RunRow | undefined
  return row ? rowToRun(row) : null
}

export function listAgentRuns(options: { statuses?: AgentRunState[]; limit?: number } = {}, dbArg?: Database.Database): AgentRun[] {
  const db = dbFor(dbArg)
  const limit = Math.max(1, Math.min(500, Math.round(options.limit ?? 100)))
  if (!options.statuses?.length) {
    return (db.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?').all(limit) as RunRow[]).map(rowToRun)
  }
  const statuses = options.statuses.filter(status => AGENT_RUN_STATES.includes(status))
  if (!statuses.length) return []
  const placeholders = statuses.map(() => '?').join(',')
  return (db.prepare(`SELECT * FROM agent_runs WHERE status IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`).all(...statuses, limit) as RunRow[]).map(rowToRun)
}

export function listAgentRunEvents(runId: string, dbArg?: Database.Database): AgentRunEvent[] {
  const db = dbFor(dbArg)
  return (db.prepare('SELECT * FROM agent_run_events WHERE run_id = ? ORDER BY sequence ASC').all(runId) as EventRow[]).map(rowToEvent)
}

export function transitionAgentRun(id: string, to: AgentRunState, options: TransitionOptions, dbArg?: Database.Database): AgentRun {
  const db = dbFor(dbArg)
  const now = options.now ?? nowIso()
  db.transaction(() => {
    const current = getAgentRun(id, db)
    if (!current) throw new Error(`Unknown agent run "${id}".`)
    if (!TRANSITIONS[current.status].includes(to)) {
      throw new Error(`Invalid agent run transition: ${current.status} -> ${to}`)
    }

    // The event is deliberately inserted first. The transaction makes the
    // event+snapshot atomic; callers broadcast only after this commits.
    insertEvent(db, id, options.eventType, current.status, to, options.data ?? {}, now)
    const terminal = TERMINAL_AGENT_RUN_STATES.includes(to)
    db.prepare(`
      UPDATE agent_runs SET
        status = ?,
        result = COALESCE(?, result),
        error_class = ?,
        error_message = ?,
        checkpoint_json = COALESCE(?, checkpoint_json),
        recovery_count = recovery_count + CASE WHEN ? = 'recovery_started' THEN 1 ELSE 0 END,
        started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
        cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
        updated_at = ?
      WHERE id = ?
    `).run(
      to,
      options.result ?? null,
      options.errorClass ?? null,
      options.errorMessage ?? null,
      options.checkpoint === undefined ? null : JSON.stringify(options.checkpoint),
      options.eventType,
      to,
      now,
      terminal ? 1 : 0,
      now,
      to,
      now,
      now,
      id,
    )
  })()
  return getAgentRun(id, db)!
}

export function appendAgentRunEvent(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  options: { checkpoint?: Record<string, unknown> | null; now?: string } = {},
  dbArg?: Database.Database,
): AgentRun {
  const db = dbFor(dbArg)
  const now = options.now ?? nowIso()
  db.transaction(() => {
    const current = getAgentRun(id, db)
    if (!current) throw new Error(`Unknown agent run "${id}".`)
    insertEvent(db, id, type, current.status, current.status, data, now)
    db.prepare('UPDATE agent_runs SET checkpoint_json = COALESCE(?, checkpoint_json), updated_at = ? WHERE id = ?')
      .run(options.checkpoint === undefined ? null : JSON.stringify(options.checkpoint), now, id)
  })()
  return getAgentRun(id, db)!
}

export function updateAgentRunWorkspaceState(
  id: string,
  workspaceState: AgentRunWorkspaceState,
  eventType: string,
  data: Record<string, unknown> = {},
  now = nowIso(),
  dbArg?: Database.Database,
): AgentRun {
  const db = dbFor(dbArg)
  db.transaction(() => {
    const current = getAgentRun(id, db)
    if (!current) throw new Error(`Unknown agent run "${id}".`)
    insertEvent(db, id, eventType, current.status, current.status, data, now)
    db.prepare('UPDATE agent_runs SET workspace_state_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(workspaceState), now, id)
  })()
  return getAgentRun(id, db)!
}

export function markAgentRunCompletionInserted(id: string, messageId: string, now = nowIso(), dbArg?: Database.Database): AgentRun {
  const db = dbFor(dbArg)
  db.transaction(() => {
    const current = getAgentRun(id, db)
    if (!current) throw new Error(`Unknown agent run "${id}".`)
    if (current.completionInsertedAt) return
    insertEvent(db, id, 'completion_inserted', current.status, current.status, { messageId }, now)
    db.prepare('UPDATE agent_runs SET completion_message_id = ?, completion_inserted_at = ?, updated_at = ? WHERE id = ?')
      .run(messageId, now, now, id)
  })()
  return getAgentRun(id, db)!
}

export function runsAwaitingCompletion(dbArg?: Database.Database): AgentRun[] {
  const db = dbFor(dbArg)
  return (db.prepare(`
    SELECT * FROM agent_runs
    WHERE status IN ('succeeded','failed','cancelled') AND completion_inserted_at IS NULL
    ORDER BY completed_at ASC, created_at ASC
  `).all() as RunRow[]).map(rowToRun)
}
