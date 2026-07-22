import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  AGENT_RUN_STATES,
  TERMINAL_AGENT_RUN_STATES,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunQuestion,
  type AgentRunPublication,
  type AgentRunResourceCaps,
  type AgentRunSummary,
  type AgentRunState,
  type AgentRunWorkspace,
  type AgentRunWorkspaceState,
} from '../../../shared/agent-runs'
import { normalizeAgentSettings, type AgentSettings } from '../../../shared/agents'
import { getDb } from '../../db'
import { ensureAgentRunSchema } from './schema'
import { redactAgentText, redactAgentValue } from './redaction'

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
  summary_json: string | null
  status: AgentRunState
  result: string | null
  error_class: string | null
  error_message: string | null
  recovery_count: number
  attempt_count: number
  retry_count: number
  next_retry_at: string | null
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
  raw_data?: string | null
  created_at: string
}

type QuestionRow = {
  id: string
  run_id: string
  kind: 'command-allowlist'
  command_argv_json: string
  reason: string
  proposed_allowlist_addition: string
  status: 'pending' | 'approved' | 'denied'
  response: string | null
  created_at: string
  answered_at: string | null
}

type PublicationRow = {
  run_id: string
  repository: 'shaunandrews/bond'
  remote: 'origin'
  base_ref: string
  head_ref: string
  idempotency_key: string
  status: AgentRunPublication['status']
  pr_number: number | null
  pr_node_id: string | null
  pr_url: string | null
  q_review_required: number
  q_review_status: AgentRunPublication['qReviewStatus']
  q_comment_id: number | null
  q_comment_url: string | null
  error_class: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  published_at: string | null
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
    settings: normalizeAgentSettings(parseJson<Partial<AgentSettings>>(row.settings_json)),
    agentDefinitionVersion: row.agent_definition_version,
    commandPolicyVersion: row.command_policy_version,
    acceptanceChecks: parseJson<string[]>(row.acceptance_checks_json),
    resourceCaps: parseJson<AgentRunResourceCaps>(row.resource_caps_json),
    checkpoint: row.checkpoint_json ? parseJson<Record<string, unknown>>(row.checkpoint_json) : null,
    summary: row.summary_json ? parseJson<AgentRunSummary>(row.summary_json) : null,
    status: row.status,
    result: row.result,
    errorClass: row.error_class,
    errorMessage: row.error_message,
    recoveryCount: row.recovery_count,
    attemptCount: row.attempt_count,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at,
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
    data: parseJson<Record<string, unknown>>(row.raw_data ?? row.data),
    rawPayloadAvailable: row.raw_data !== null && row.raw_data !== undefined,
    createdAt: row.created_at,
  }
}

function rowToQuestion(row: QuestionRow): AgentRunQuestion {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    argv: parseJson<string[]>(row.command_argv_json),
    reason: row.reason,
    proposedAllowlistAddition: row.proposed_allowlist_addition,
    status: row.status,
    response: row.response,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  }
}

function rowToPublication(row: PublicationRow): AgentRunPublication {
  return {
    runId: row.run_id,
    repository: row.repository,
    remote: row.remote,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    prNumber: row.pr_number,
    prNodeId: row.pr_node_id,
    prUrl: row.pr_url,
    qReviewRequired: row.q_review_required === 1,
    qReviewStatus: row.q_review_status,
    qCommentId: row.q_comment_id,
    qCommentUrl: row.q_comment_url,
    errorClass: row.error_class,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  }
}

function terminalSummary(run: AgentRun, completedAt: string): AgentRunSummary {
  return {
    status: run.status as AgentRunSummary['status'],
    agentLabel: run.agentLabel,
    verb: run.verb,
    brief: redactAgentText(run.brief).slice(0, 280),
    finalReport: run.result ? redactAgentText(run.result).slice(0, 2_000) : null,
    errorClass: run.errorClass,
    errorMessage: run.errorMessage ? redactAgentText(run.errorMessage).slice(0, 1_000) : null,
    completedAt,
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
  const payload = JSON.stringify(redactAgentValue(data))
  const inserted = db.prepare(`
    INSERT INTO agent_run_events (run_id, sequence, type, from_state, to_state, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(runId, nextSequence(db, runId), type, fromState, toState, '{}', now)
  db.prepare(`INSERT INTO agent_run_event_logs (event_id, run_id, data, byte_count, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(Number(inserted.lastInsertRowid), runId, payload, Buffer.byteLength(payload), now)
}

function assertMatchingDispatch(existing: AgentRun, input: CreateAgentRunRecord): void {
  const expected = {
    agent: input.agent,
    agentLabel: input.agentLabel,
    verb: input.verb,
    brief: redactAgentText(input.brief),
    paths: redactAgentValue(input.paths),
    workspace: redactAgentValue(input.workspace),
    baseSha: input.baseSha,
    allowedPaths: redactAgentValue(input.allowedPaths),
    settings: redactAgentValue(input.settings),
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
        id, input.idempotencyKey, input.agent, input.agentLabel, input.verb, redactAgentText(input.brief),
        JSON.stringify(redactAgentValue(input.paths)), JSON.stringify(redactAgentValue(input.workspace)), JSON.stringify(input.workspaceState ?? {
          status: input.workspace.isolation === 'worktree' ? 'pending' : 'ready',
          createdAt: null,
          retainedAt: null,
          discardedAt: null,
        }), input.baseSha,
        JSON.stringify(redactAgentValue(input.allowedPaths)), JSON.stringify(redactAgentValue(input.settings)),
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
  return (db.prepare(`SELECT e.*, l.data AS raw_data
    FROM agent_run_events e LEFT JOIN agent_run_event_logs l ON l.event_id = e.id
    WHERE e.run_id = ? ORDER BY e.sequence ASC`).all(runId) as EventRow[]).map(rowToEvent)
}

export function listAgentRunQuestions(runId: string, dbArg?: Database.Database): AgentRunQuestion[] {
  const db = dbFor(dbArg)
  return (db.prepare('SELECT * FROM agent_run_questions WHERE run_id = ? ORDER BY created_at ASC').all(runId) as QuestionRow[]).map(rowToQuestion)
}

export function listPendingAgentRunQuestions(dbArg?: Database.Database): AgentRunQuestion[] {
  const db = dbFor(dbArg)
  return (db.prepare("SELECT * FROM agent_run_questions WHERE status = 'pending' ORDER BY created_at ASC").all() as QuestionRow[]).map(rowToQuestion)
}

export function getAgentRunPublication(runId: string, dbArg?: Database.Database): AgentRunPublication | null {
  const db = dbFor(dbArg)
  const row = db.prepare('SELECT * FROM agent_run_publications WHERE run_id = ?').get(runId) as PublicationRow | undefined
  return row ? rowToPublication(row) : null
}

export function createAgentRunPublication(input: {
  runId: string
  baseRef: string
  headRef: string
  idempotencyKey: string
  qReviewRequired: boolean
}, now = nowIso(), dbArg?: Database.Database): AgentRunPublication {
  const db = dbFor(dbArg)
  db.transaction(() => {
    const run = getAgentRun(input.runId, db)
    if (!run) throw new Error(`Unknown agent run "${input.runId}".`)
    const existing = getAgentRunPublication(input.runId, db)
    if (existing) {
      if (existing.baseRef !== input.baseRef || existing.headRef !== input.headRef || existing.idempotencyKey !== input.idempotencyKey) {
        throw new Error('The durable publication contract for this run is immutable.')
      }
      return
    }
    db.prepare(`
      INSERT INTO agent_run_publications (
        run_id, repository, remote, base_ref, head_ref, idempotency_key,
        status, q_review_required, q_review_status, created_at, updated_at
      ) VALUES (?, 'shaunandrews/bond', 'origin', ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      input.runId, input.baseRef, input.headRef, input.idempotencyKey,
      input.qReviewRequired ? 1 : 0, input.qReviewRequired ? 'pending' : 'not-required', now, now,
    )
    insertEvent(db, input.runId, 'github_publish_queued', run.status, run.status, {
      repository: 'shaunandrews/bond', remote: 'origin', baseRef: input.baseRef,
      headRef: input.headRef, qReviewRequired: input.qReviewRequired,
    }, now)
  })()
  return getAgentRunPublication(input.runId, db)!
}

export function markAgentRunPublishing(runId: string, now = nowIso(), dbArg?: Database.Database): AgentRunPublication {
  const db = dbFor(dbArg)
  db.transaction(() => {
    const run = getAgentRun(runId, db)
    const publication = getAgentRunPublication(runId, db)
    if (!run || !publication) throw new Error(`Unknown agent run publication "${runId}".`)
    if (publication.status === 'published') return
    insertEvent(db, runId, 'github_publish_started', run.status, run.status, {}, now)
    db.prepare("UPDATE agent_run_publications SET status = 'publishing', error_class = NULL, error_message = NULL, updated_at = ? WHERE run_id = ?").run(now, runId)
  })()
  return getAgentRunPublication(runId, db)!
}

export function markAgentRunPublished(runId: string, pr: { number: number; nodeId: string; url: string }, now = nowIso(), dbArg?: Database.Database): AgentRunPublication {
  const db = dbFor(dbArg)
  db.transaction(() => {
    const run = getAgentRun(runId, db)
    const publication = getAgentRunPublication(runId, db)
    if (!run || !publication) throw new Error(`Unknown agent run publication "${runId}".`)
    if (publication.status === 'published') return
    insertEvent(db, runId, 'github_draft_published', run.status, run.status, { prNumber: pr.number, prUrl: pr.url }, now)
    db.prepare(`UPDATE agent_run_publications SET
      status = 'published', pr_number = ?, pr_node_id = ?, pr_url = ?,
      error_class = NULL, error_message = NULL, updated_at = ?, published_at = ?
      WHERE run_id = ?
    `).run(pr.number, pr.nodeId, pr.url, now, now, runId)
  })()
  return getAgentRunPublication(runId, db)!
}

export function markAgentRunPublishFailed(runId: string, errorClass: string, errorMessage: string, now = nowIso(), dbArg?: Database.Database): AgentRunPublication {
  const db = dbFor(dbArg)
  db.transaction(() => {
    const run = getAgentRun(runId, db)
    const publication = getAgentRunPublication(runId, db)
    if (!run || !publication) throw new Error(`Unknown agent run publication "${runId}".`)
    const message = redactAgentText(errorMessage)
    insertEvent(db, runId, 'github_publish_failed', run.status, run.status, { errorClass, errorMessage: message }, now)
    db.prepare("UPDATE agent_run_publications SET status = 'failed', error_class = ?, error_message = ?, updated_at = ? WHERE run_id = ?")
      .run(errorClass, message, now, runId)
  })()
  return getAgentRunPublication(runId, db)!
}

export function markAgentRunQReview(runId: string, input: {
  status: 'posted' | 'failed'
  commentId?: number
  commentUrl?: string
  errorMessage?: string
}, now = nowIso(), dbArg?: Database.Database): AgentRunPublication {
  const db = dbFor(dbArg)
  db.transaction(() => {
    const run = getAgentRun(runId, db)
    const publication = getAgentRunPublication(runId, db)
    if (!run || !publication) throw new Error(`Unknown agent run publication "${runId}".`)
    const type = input.status === 'posted' ? 'q_review_posted' : 'q_review_failed'
    insertEvent(db, runId, type, run.status, run.status, {
      commentUrl: input.commentUrl ?? null, errorMessage: input.errorMessage ?? null,
    }, now)
    db.prepare(`UPDATE agent_run_publications SET
      q_review_status = ?, q_comment_id = COALESCE(?, q_comment_id),
      q_comment_url = COALESCE(?, q_comment_url), updated_at = ?
      WHERE run_id = ?
    `).run(input.status, input.commentId ?? null, input.commentUrl ?? null, now, runId)
  })()
  return getAgentRunPublication(runId, db)!
}

export function approvedAgentRunCommandGrants(runId: string, dbArg?: Database.Database): Set<string> {
  const db = dbFor(dbArg)
  const rows = db.prepare("SELECT command_argv_json FROM agent_run_questions WHERE run_id = ? AND status = 'approved'").all(runId) as Array<{ command_argv_json: string }>
  return new Set(rows.map(row => row.command_argv_json))
}

export function runsReadyToResume(dbArg?: Database.Database): AgentRun[] {
  const db = dbFor(dbArg)
  return (db.prepare(`
    SELECT r.* FROM agent_runs r
    WHERE r.status = 'needs-input'
      AND EXISTS (
        SELECT 1 FROM agent_run_questions q
        WHERE q.run_id = r.id AND q.status = 'approved'
      )
    ORDER BY r.updated_at ASC
  `).all() as RunRow[]).map(rowToRun)
}

export function listInterruptedAgentRuns(dbArg?: Database.Database): AgentRun[] {
  return listAgentRuns({ statuses: ['interrupted'], limit: 500 }, dbArg)
}

export function scheduleAgentRunRetry(
  id: string,
  errorClass: string,
  errorMessage: string,
  nextRetryAt: string,
  now = nowIso(),
  dbArg?: Database.Database,
): AgentRun {
  const db = dbFor(dbArg)
  db.transaction(() => {
    const current = getAgentRun(id, db)
    if (!current) throw new Error(`Unknown agent run "${id}".`)
    if (!['preparing-workspace', 'running'].includes(current.status)) throw new Error(`Cannot schedule retry while run is ${current.status}.`)
    const message = redactAgentText(errorMessage)
    insertEvent(db, id, 'retry_scheduled', current.status, 'interrupted', {
      errorClass, errorMessage: message, retryNumber: current.retryCount + 1, nextRetryAt,
    }, now)
    db.prepare(`UPDATE agent_runs SET
      status = 'interrupted', error_class = ?, error_message = ?,
      retry_count = retry_count + 1, next_retry_at = ?, updated_at = ?
      WHERE id = ?
    `).run(errorClass, message, nextRetryAt, now, id)
  })()
  return getAgentRun(id, db)!
}

export function parkAgentRunForCommand(
  id: string,
  question: { argv: string[]; reason: string; proposedAllowlistAddition: string },
  checkpoint: Record<string, unknown>,
  now = nowIso(),
  dbArg?: Database.Database,
): { run: AgentRun; question: AgentRunQuestion } {
  const db = dbFor(dbArg)
  const questionId = randomUUID()
  db.transaction(() => {
    const current = getAgentRun(id, db)
    if (!current) throw new Error(`Unknown agent run "${id}".`)
    if (current.status !== 'running') throw new Error(`Cannot park command question while run is ${current.status}.`)
    db.prepare(`
      INSERT INTO agent_run_questions (
        id, run_id, kind, command_argv_json, reason, proposed_allowlist_addition,
        status, created_at
      ) VALUES (?, ?, 'command-allowlist', ?, ?, ?, 'pending', ?)
    `).run(questionId, id, JSON.stringify(redactAgentValue(question.argv)), redactAgentText(question.reason), redactAgentText(question.proposedAllowlistAddition), now)
    insertEvent(db, id, 'command_question_asked', 'running', 'needs-input', {
      questionId, argv: question.argv, reason: question.reason,
      proposedAllowlistAddition: question.proposedAllowlistAddition,
    }, now)
    db.prepare(`UPDATE agent_runs SET status = 'needs-input', checkpoint_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(redactAgentValue(checkpoint)), now, id)
  })()
  const row = db.prepare('SELECT * FROM agent_run_questions WHERE id = ?').get(questionId) as QuestionRow
  return { run: getAgentRun(id, db)!, question: rowToQuestion(row) }
}

export function answerAgentRunQuestion(
  runId: string,
  questionId: string,
  approved: boolean,
  response: string,
  now = nowIso(),
  dbArg?: Database.Database,
): { run: AgentRun; question: AgentRunQuestion; changed: boolean } {
  const db = dbFor(dbArg)
  let changed = false
  db.transaction(() => {
    const run = getAgentRun(runId, db)
    if (!run) throw new Error(`Unknown agent run "${runId}".`)
    const row = db.prepare('SELECT * FROM agent_run_questions WHERE id = ? AND run_id = ?').get(questionId, runId) as QuestionRow | undefined
    if (!row) throw new Error(`Unknown question "${questionId}" for this run.`)
    const desired = approved ? 'approved' : 'denied'
    if (row.status !== 'pending') {
      if (row.status !== desired) throw new Error(`Question was already ${row.status}.`)
      return
    }
    if (run.status !== 'needs-input') throw new Error(`Run is ${run.status}, not waiting for input.`)
    changed = true
    db.prepare('UPDATE agent_run_questions SET status = ?, response = ?, answered_at = ? WHERE id = ?')
      .run(desired, redactAgentText(response), now, questionId)
    if (approved) {
      insertEvent(db, runId, 'command_approved', 'needs-input', 'needs-input', { questionId, argv: parseJson<string[]>(row.command_argv_json), response }, now)
      db.prepare('UPDATE agent_runs SET updated_at = ? WHERE id = ?').run(now, runId)
    } else {
      insertEvent(db, runId, 'command_denied', 'needs-input', 'failed', { questionId, argv: parseJson<string[]>(row.command_argv_json), response }, now)
      db.prepare(`UPDATE agent_runs SET status = 'failed', error_class = 'policy', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(redactAgentText(`Command approval denied: ${response || row.reason}`), now, now, runId)
    }
  })()
  const question = db.prepare('SELECT * FROM agent_run_questions WHERE id = ?').get(questionId) as QuestionRow
  return { run: getAgentRun(runId, db)!, question: rowToQuestion(question), changed }
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
        attempt_count = attempt_count + CASE WHEN ? = 'running' THEN 1 ELSE 0 END,
        next_retry_at = CASE WHEN ? = 'running' THEN NULL ELSE next_retry_at END,
        started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
        cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
        updated_at = ?
      WHERE id = ?
    `).run(
      to,
      options.result == null ? null : redactAgentText(options.result),
      options.errorClass ?? null,
      options.errorMessage == null ? null : redactAgentText(options.errorMessage),
      options.checkpoint === undefined ? null : JSON.stringify(redactAgentValue(options.checkpoint)),
      options.eventType,
      to,
      to,
      to,
      now,
      terminal ? 1 : 0,
      now,
      to,
      now,
      now,
      id,
    )
    if (terminal) {
      const completed = rowToRun(db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as RunRow)
      db.prepare('UPDATE agent_runs SET summary_json = ? WHERE id = ?')
        .run(JSON.stringify(terminalSummary(completed, now)), id)
    }
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
      .run(options.checkpoint === undefined ? null : JSON.stringify(redactAgentValue(options.checkpoint)), now, id)
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

export function agentRunRawLogBytes(dbArg?: Database.Database): number {
  const db = dbFor(dbArg)
  return (db.prepare('SELECT COALESCE(SUM(byte_count), 0) AS bytes FROM agent_run_event_logs').get() as { bytes: number }).bytes
}

export function deleteExpiredTerminalAgentRunLogs(cutoff: string, dbArg?: Database.Database): { deleted: number; bytes: number } {
  const db = dbFor(dbArg)
  const aggregate = db.prepare(`SELECT COUNT(*) AS deleted, COALESCE(SUM(l.byte_count), 0) AS bytes
    FROM agent_run_event_logs l JOIN agent_runs r ON r.id = l.run_id
    WHERE r.status IN ('succeeded','failed','cancelled') AND r.completed_at < ?`).get(cutoff) as { deleted: number; bytes: number }
  db.prepare(`DELETE FROM agent_run_event_logs WHERE event_id IN (
    SELECT l.event_id FROM agent_run_event_logs l JOIN agent_runs r ON r.id = l.run_id
    WHERE r.status IN ('succeeded','failed','cancelled') AND r.completed_at < ?
  )`).run(cutoff)
  return aggregate
}

export function evictOldestTerminalAgentRunLogs(maxBytes: number, dbArg?: Database.Database): { deleted: number; bytes: number } {
  const db = dbFor(dbArg)
  let total = agentRunRawLogBytes(db)
  let deleted = 0
  let bytes = 0
  if (total <= maxBytes) return { deleted, bytes }
  const candidates = db.prepare(`SELECT l.event_id, l.byte_count
    FROM agent_run_event_logs l JOIN agent_runs r ON r.id = l.run_id
    WHERE r.status IN ('succeeded','failed','cancelled')
    ORDER BY l.created_at ASC, l.event_id ASC`).all() as Array<{ event_id: number; byte_count: number }>
  const remove = db.prepare('DELETE FROM agent_run_event_logs WHERE event_id = ?')
  db.transaction(() => {
    for (const candidate of candidates) {
      if (total <= maxBytes) break
      if (remove.run(candidate.event_id).changes) {
        total -= candidate.byte_count
        bytes += candidate.byte_count
        deleted += 1
      }
    }
  })()
  return { deleted, bytes }
}
