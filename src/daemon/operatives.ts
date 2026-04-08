import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { getDb } from './db'
import { bondMessageToChunks } from './agent'
import type { BondStreamChunk } from '../shared/stream'
import type { Operative, OperativeEvent, SpawnOperativeOptions } from '../shared/operative'

const MAX_CONCURRENT = 3

/** Cost per million tokens by model */
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.25, output: 1.25 }
}

/** Active operative AbortControllers keyed by operative ID */
const activeOperatives = new Map<string, AbortController>()

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface OperativeRow {
  id: string
  name: string
  prompt: string
  working_dir: string
  status: string
  session_id: string | null
  sdk_session_id: string | null
  worktree: string | null
  branch: string | null
  model: string | null
  result_summary: string | null
  error_message: string | null
  exit_code: number | null
  input_tokens: number
  output_tokens: number
  cost_usd: number
  context_window: number
  timeout_ms: number | null
  max_budget_usd: number | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

function rowToOperative(r: OperativeRow): Operative {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    workingDir: r.working_dir,
    status: r.status as Operative['status'],
    sessionId: r.session_id || undefined,
    sdkSessionId: r.sdk_session_id || undefined,
    worktree: r.worktree || undefined,
    branch: r.branch || undefined,
    model: r.model || undefined,
    resultSummary: r.result_summary || undefined,
    errorMessage: r.error_message || undefined,
    exitCode: r.exit_code ?? undefined,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    contextWindow: r.context_window || undefined,
    timeoutMs: r.timeout_ms ?? undefined,
    maxBudgetUsd: r.max_budget_usd ?? undefined,
    startedAt: r.started_at || undefined,
    completedAt: r.completed_at || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

interface EventRow {
  id: number
  operative_id: string
  kind: string
  data: string
  created_at: string
}

function rowToEvent(r: EventRow): OperativeEvent {
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(r.data) } catch { /* ignore */ }
  return {
    id: r.id,
    operativeId: r.operative_id,
    kind: r.kind,
    data,
    createdAt: r.created_at
  }
}

// ---------------------------------------------------------------------------
// Event storage
// ---------------------------------------------------------------------------

function storeEvent(operativeId: string, chunk: BondStreamChunk): OperativeEvent {
  const db = getDb()
  const now = new Date().toISOString()
  const { kind, ...rest } = chunk as Record<string, unknown>
  const result = db.prepare(
    'INSERT INTO operative_events (operative_id, kind, data, created_at) VALUES (?, ?, ?, ?)'
  ).run(operativeId, kind as string, JSON.stringify(rest), now)
  return {
    id: Number(result.lastInsertRowid),
    operativeId,
    kind: kind as string,
    data: rest as Record<string, unknown>,
    createdAt: now
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listOperatives(filters?: { status?: string; sessionId?: string }): Operative[] {
  const db = getDb()
  const clauses: string[] = []
  const values: unknown[] = []

  if (filters?.status) {
    clauses.push('status = ?')
    values.push(filters.status)
  }
  if (filters?.sessionId) {
    clauses.push('session_id = ?')
    values.push(filters.sessionId)
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM operatives ${where} ORDER BY created_at DESC`).all(...values) as OperativeRow[]
  return rows.map(rowToOperative)
}

export function getOperative(id: string): Operative | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM operatives WHERE id = ?').get(id) as OperativeRow | undefined
  return row ? rowToOperative(row) : null
}

export function getOperativeEvents(id: string, afterId?: number, limit?: number): OperativeEvent[] {
  const db = getDb()
  const clauses = ['operative_id = ?']
  const values: unknown[] = [id]

  if (afterId != null) {
    clauses.push('id > ?')
    values.push(afterId)
  }

  const limitClause = limit ? `LIMIT ${limit}` : ''
  const rows = db.prepare(
    `SELECT * FROM operative_events WHERE ${clauses.join(' AND ')} ORDER BY id ASC ${limitClause}`
  ).all(...values) as EventRow[]
  return rows.map(rowToEvent)
}

export function removeOperative(id: string): boolean {
  cancelOperative(id)
  const db = getDb()
  const result = db.prepare('DELETE FROM operatives WHERE id = ?').run(id)
  return result.changes > 0
}

export function clearOperatives(status?: string): number {
  const db = getDb()
  if (status) {
    const result = db.prepare('DELETE FROM operatives WHERE status = ?').run(status)
    return result.changes
  }
  // Clear all non-running operatives — don't touch active ones
  const result = db.prepare("DELETE FROM operatives WHERE status NOT IN ('running', 'queued')").run()
  return result.changes
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

export function spawnOperative(
  options: SpawnOperativeOptions,
  currentModel: string,
  onChanged: () => void,
  onEvent: (operativeId: string, event: OperativeEvent) => void,
  onSessionSystem: (sessionId: string, text: string) => void
): Operative {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const model = options.model || currentModel

  db.prepare(`
    INSERT INTO operatives (
      id, name, prompt, working_dir, status, session_id, model,
      timeout_ms, max_budget_usd, input_tokens, output_tokens, cost_usd,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, 0, 0, ?, ?)
  `).run(
    id, options.name, options.prompt, options.workingDir,
    options.sessionId ?? null, model,
    options.timeoutMs ?? null, options.maxBudgetUsd ?? null,
    now, now
  )

  const operative = getOperative(id)!

  // Check concurrency limit
  const runningCount = (db.prepare("SELECT COUNT(*) as n FROM operatives WHERE status = 'running'").get() as { n: number }).n
  if (runningCount >= MAX_CONCURRENT) {
    return operative
  }

  startOperative(id, options, model, onChanged, onEvent, onSessionSystem)
  return getOperative(id)!
}

function startOperative(
  id: string,
  options: SpawnOperativeOptions,
  model: string,
  onChanged: () => void,
  onEvent: (operativeId: string, event: OperativeEvent) => void,
  onSessionSystem: (sessionId: string, text: string) => void
): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare("UPDATE operatives SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
  onChanged()

  // Fire-and-forget
  runOperative(id, options, model, onChanged, onEvent, onSessionSystem).catch(err => {
    console.error(`[bond] operative ${id} uncaught error:`, err)
  })
}

async function runOperative(
  id: string,
  options: SpawnOperativeOptions,
  model: string,
  onChanged: () => void,
  onEvent: (operativeId: string, event: OperativeEvent) => void,
  onSessionSystem: (sessionId: string, text: string) => void
): Promise<void> {
  const db = getDb()
  const ac = new AbortController()
  activeOperatives.set(id, ac)

  let timeout: ReturnType<typeof setTimeout> | null = null
  if (options.timeoutMs) {
    timeout = setTimeout(() => ac.abort(), options.timeoutMs)
  }

  // Worktree setup
  let cwd = options.workingDir
  let worktreePath: string | undefined
  let branchName: string | undefined

  if (options.worktree) {
    const gitDir = join(options.workingDir, '.git')
    if (existsSync(gitDir)) {
      branchName = `operative/${id.slice(0, 8)}`
      worktreePath = join(tmpdir(), `bond-worktree-${id.slice(0, 8)}`)
      try {
        execSync(`git worktree add ${worktreePath} -b ${branchName}`, {
          cwd: options.workingDir,
          stdio: 'pipe'
        })
        cwd = worktreePath
        const now = new Date().toISOString()
        db.prepare('UPDATE operatives SET worktree = ?, branch = ?, updated_at = ? WHERE id = ?')
          .run(worktreePath, branchName, now, id)
      } catch (err) {
        console.error(`[bond] operative ${id} worktree creation failed:`, err)
        // Fall back to working dir
        worktreePath = undefined
        branchName = undefined
      }
    }
  }

  // Build system prompt
  let systemPrompt =
    'You are an operative — a standalone coding agent deployed by Bond to work on a specific task.\n' +
    'Focus exclusively on the task described in your prompt.\n\n' +
    'Rules:\n' +
    '- Do not ask questions — make reasonable decisions and document your choices.\n' +
    '- If something is ambiguous, pick the most sensible path and note the assumption.\n' +
    '- When you finish, provide a clear summary of what you did, what files you changed, and any issues encountered.\n' +
    '- Stay focused. Don\'t explore unrelated code or make improvements beyond what was asked.'
  if (options.systemPromptSuffix) {
    systemPrompt += '\n\n' + options.systemPromptSuffix
  }

  const tools = options.allowedTools || ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch']

  let lastTextChunk: string | undefined
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let lastMessageId: string | null = null
  let lastInputTokens = 0
  let contextWindowLimit = 0
  let cumulativeCost = 0

  try {
    const q = query({
      prompt: options.prompt,
      options: {
        abortController: ac,
        cwd,
        model,
        tools: [...tools],
        allowedTools: [...tools],
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        systemPrompt,
        stderr: (text: string) => {
          console.error(`[bond] operative ${id} stderr:`, text.trimEnd())
        },
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'bond-electron/0.1.0'
        } as Record<string, string | undefined>
      } as any
    })

    for await (const message of q) {
      if (ac.signal.aborted) break

      // Extract usage from assistant messages (deduplicate by message ID)
      if (message.type === 'assistant') {
        const msg = message as any
        const msgId = msg.message?.id
        if (msgId && msgId !== lastMessageId) {
          lastMessageId = msgId
          const u = msg.message?.usage
          if (u) {
            lastInputTokens =
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0)
          }
        }
      }

      // Extract usage from result messages
      if (message.type === 'result') {
        const msg = message as any
        if (msg.usage) {
          totalInputTokens += msg.usage.input_tokens ?? 0
          totalOutputTokens += msg.usage.output_tokens ?? 0
        }

        cumulativeCost = msg.total_cost_usd ?? cumulativeCost

        const models = msg.modelUsage ?? {}
        const primary = Object.values(models)[0] as any
        if (primary?.contextWindow) {
          contextWindowLimit = primary.contextWindow
        }

        if (contextWindowLimit > 0) {
          const usageChunk: BondStreamChunk = {
            kind: 'usage_update',
            inputTokens: lastInputTokens,
            contextWindow: contextWindowLimit,
            costUsd: cumulativeCost
          }
          const usageEvent = storeEvent(id, usageChunk)
          onEvent(id, usageEvent)
        }
      }

      for (const chunk of bondMessageToChunks(message)) {
        const event = storeEvent(id, chunk)
        onEvent(id, event)

        if (chunk.kind === 'assistant_text') {
          lastTextChunk = (lastTextChunk ?? '') + chunk.text
        }

        // Track usage from result chunks
        if (chunk.kind === 'result') {
          const now = new Date().toISOString()
          db.prepare(
            'UPDATE operatives SET input_tokens = ?, output_tokens = ?, cost_usd = ?, context_window = ?, updated_at = ? WHERE id = ?'
          ).run(totalInputTokens, totalOutputTokens, cumulativeCost, contextWindowLimit, now, id)
        }
      }
    }

    // Completed successfully
    const now = new Date().toISOString()
    const summary = lastTextChunk ? lastTextChunk.slice(0, 2000) : undefined
    db.prepare(
      "UPDATE operatives SET status = 'completed', exit_code = 0, result_summary = ?, completed_at = ?, updated_at = ? WHERE id = ?"
    ).run(summary ?? null, now, now, id)

  } catch (err) {
    const now = new Date().toISOString()
    if (ac.signal.aborted) {
      db.prepare(
        "UPDATE operatives SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, id)
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err)
      db.prepare(
        "UPDATE operatives SET status = 'failed', error_message = ?, exit_code = 1, completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(errorMsg, now, now, id)
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    activeOperatives.delete(id)
    onChanged()

    const operative = getOperative(id)
    if (operative && options.sessionId) {
      if (operative.status === 'completed') {
        onSessionSystem(options.sessionId, `Operative "${options.name}" completed successfully.${operative.resultSummary ? ` Summary: ${operative.resultSummary.slice(0, 200)}` : ''}`)
      } else if (operative.status === 'failed') {
        onSessionSystem(options.sessionId, `Operative "${options.name}" failed: ${operative.errorMessage ?? 'unknown error'}`)
      } else if (operative.status === 'cancelled') {
        onSessionSystem(options.sessionId, `Operative "${options.name}" was cancelled.`)
      }
    }

    dequeueNext(onChanged, onEvent, onSessionSystem)
  }
}

function dequeueNext(
  onChanged: () => void,
  onEvent: (operativeId: string, event: OperativeEvent) => void,
  onSessionSystem: (sessionId: string, text: string) => void
): void {
  const db = getDb()
  const runningCount = (db.prepare("SELECT COUNT(*) as n FROM operatives WHERE status = 'running'").get() as { n: number }).n
  if (runningCount >= MAX_CONCURRENT) return

  const next = db.prepare("SELECT * FROM operatives WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get() as OperativeRow | undefined
  if (!next) return

  const options: SpawnOperativeOptions = {
    name: next.name,
    prompt: next.prompt,
    workingDir: next.working_dir,
    sessionId: next.session_id || undefined,
    worktree: !!next.worktree,
    model: next.model || undefined,
    timeoutMs: next.timeout_ms ?? undefined,
    maxBudgetUsd: next.max_budget_usd ?? undefined
  }

  startOperative(next.id, options, next.model || 'sonnet', onChanged, onEvent, onSessionSystem)
}

export function cancelOperative(id: string): boolean {
  const ac = activeOperatives.get(id)
  if (ac) {
    ac.abort()
    return true
  }
  // If queued but not started, mark as cancelled directly
  const db = getDb()
  const now = new Date().toISOString()
  const result = db.prepare(
    "UPDATE operatives SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'"
  ).run(now, now, id)
  return result.changes > 0
}

export function recoverOrphanedOperatives(): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    "UPDATE operatives SET status = 'failed', error_message = 'Process lost — daemon restarted', completed_at = ?, updated_at = ? WHERE status IN ('running', 'queued')"
  ).run(now, now)
}

export function abortAllOperatives(): void {
  for (const [, ac] of activeOperatives) {
    ac.abort()
  }
}
