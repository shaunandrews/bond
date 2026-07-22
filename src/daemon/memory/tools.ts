import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type Database from 'better-sqlite3'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { getDb } from '../db'
import { firstRunToolReminder } from '../onboarding'
import { getSetting } from '../settings'
import { redact } from '../sense/redaction'
import { getSourceMessages, searchActivitySnippets, searchMessages } from '../transcript'
import { getMemoryHealth } from './ledger'
import { readCoreMemory, withCoreMemoryLock, writeCoreMemoryAtomic } from './core-memory'
import {
  countActiveMemoryItems,
  findActiveMemoryByText,
  getMemoryItem,
  getMemoryItemSourceIds,
  searchMemory,
  setMemoryItemSources,
  upsertMemoryItem,
} from './store'
import { MEMORY_ITEM_KINDS, type CoreMemory, type MemoryItem, type MemoryItemKind } from './types'
import { createWorkingState } from './working-state'

export interface MemoryToolResult<T> {
  ok: boolean
  value?: T
  errors: string[]
}

export function validateToolSourceIds(raw: unknown, required = true): string[] {
  if (raw === undefined && !required) return []
  if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string' || !value.trim())) {
    return ['sourceIds must be an array of non-empty strings']
  }
  if (required && raw.length === 0) return ['sourceIds must contain at least one message id']
  return []
}

export function rememberMemory(
  input: { id?: string; text: string; kind?: MemoryItemKind; sourceIds?: string[] },
  options: { db?: Database.Database } = {},
): MemoryToolResult<MemoryItem> {
  const errors = validateToolSourceIds(input.sourceIds, false)
  if (errors.length) return { ok: false, errors }
  try {
    assertSafeMemoryText(input.text)
    const sourceIds = input.sourceIds ?? []
    const item = upsertMemoryItem({
      id: input.id,
      text: input.text,
      kind: input.kind ?? 'fact',
      source: 'user',
      confidence: 1,
      tags: sourceIds.map(id => `source:${id}`),
    }, options.db)
    const db = options.db
    const hasMessagesTable = db?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get()
    if (db && hasMessagesTable && sourceIds.length) setMemoryItemSources(item.id, sourceIds, db)
    return { ok: true, value: item, errors: [] }
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }
}

export function searchMemoryTool(query: string, options: { db?: Database.Database; limit?: number } = {}): MemoryToolResult<ReturnType<typeof searchMemory>> {
  try {
    return { ok: true, value: searchMemory(query, { limit: options.limit }, options.db), errors: [] }
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }
}

export function forgetMemory(id: string, options: { db?: Database.Database } = {}): MemoryToolResult<MemoryItem> {
  const current = getMemoryItem(id, options.db)
  if (!current) return { ok: false, errors: [`Memory item not found: ${id}`] }
  const item = upsertMemoryItem({ ...current, active: false, updatedAt: new Date().toISOString() }, options.db)
  return { ok: true, value: item, errors: [] }
}

export const MEMORY_TOOL_NAMES = [
  'memory_status',
  'memory_search',
  'memory_recall',
  'history_search',
  'memory_manage',
] as const

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  }
}

function sourceIdsFromLegacyTags(tags: string[]): string[] {
  return tags.filter(tag => tag.startsWith('source:')).map(tag => tag.slice('source:'.length)).filter(Boolean)
}

function readWorkingMemory() {
  const raw = getSetting('memory.working')
  if (!raw) return createWorkingState()
  try {
    return createWorkingState(JSON.parse(raw))
  } catch {
    return createWorkingState()
  }
}

function coreListForKind(core: CoreMemory, kind: MemoryItemKind): string[] | null {
  if (kind === 'fact') return core.facts
  if (kind === 'preference') return core.preferences
  if (kind === 'decision') return core.decisions
  return null
}

function assertSafeMemoryText(text: string): void {
  const redacted = redact(text)
  if (redacted === null || redacted !== text) {
    throw new Error('Refusing to store memory that appears to contain credentials or sensitive identifiers.')
  }
}

function addToCore(item: MemoryItem): Promise<void> {
  return withCoreMemoryLock(() => {
    const core = readCoreMemory()
    const list = coreListForKind(core, item.kind)
    if (!list || list.some(value => value.toLocaleLowerCase() === item.text.toLocaleLowerCase())) return
    list.push(item.text)
    writeCoreMemoryAtomic({ ...core, updatedAt: new Date().toISOString() })
  })
}

function replaceInCore(previous: MemoryItem, next: MemoryItem): Promise<void> {
  return withCoreMemoryLock(() => {
    const core = readCoreMemory()
    let changed = false
    for (const values of [core.facts, core.preferences, core.decisions]) {
      const index = values.findIndex(value => value.toLocaleLowerCase() === previous.text.toLocaleLowerCase())
      if (index !== -1) {
        values.splice(index, 1)
        changed = true
      }
    }
    const target = coreListForKind(core, next.kind)
    if (target && changed && !target.some(value => value.toLocaleLowerCase() === next.text.toLocaleLowerCase())) {
      target.push(next.text)
    }
    if (changed) writeCoreMemoryAtomic({ ...core, updatedAt: new Date().toISOString() })
  })
}

function removeFromCore(item: MemoryItem): Promise<void> {
  return withCoreMemoryLock(() => {
    const core = readCoreMemory()
    let changed = false
    for (const values of [core.facts, core.preferences, core.decisions]) {
      const next = values.filter(value => value.toLocaleLowerCase() !== item.text.toLocaleLowerCase())
      if (next.length !== values.length) {
        values.splice(0, values.length, ...next)
        changed = true
      }
    }
    if (changed) writeCoreMemoryAtomic({ ...core, updatedAt: new Date().toISOString() })
  })
}

export function registerMemoryTools(pi: ExtensionAPI, options: { sourceMessageId?: string } = {}): void {
  pi.registerTool({
    name: 'memory_status',
    label: 'Memory Status',
    description: 'Inspect Bond’s persistent memory system status, counts, and WRITE HEALTH. Reports when memory writes are failing or stale, so you can say so plainly instead of guessing why you cannot recall recent work.',
    parameters: Type.Object({}),
    async execute() {
      const db = getDb()
      const core = readCoreMemory()
      const working = readWorkingMemory()
      const transcript = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role IN ('user', 'bond')").get() as { count: number }
      // Counts alone lie by omission: mid-incident this tool would have
      // reported active: true with 24 stale facts and called it healthy.
      const health = getMemoryHealth(db)
      return toolResult({
        available: true,
        core: { facts: core.facts.length, preferences: core.preferences.length, decisions: core.decisions.length },
        working: {
          active: Boolean(working.goal || working.facts.length || working.preferences.length || working.decisions.length || working.openThreads.length),
          facts: working.facts.length,
          preferences: working.preferences.length,
          decisions: working.decisions.length,
          openThreads: working.openThreads.length,
          artifacts: working.artifacts.map(a => `${a.kind}:${a.ref}`),
          activeSkill: working.activeSkill,
          checkpoint: working.checkpoint,
        },
        health: {
          workingUpdatedAt: health.workingUpdatedAt,
          coreUpdatedAt: health.coreUpdatedAt,
          observerLagSeqs: health.observerLagSeqs,
          consecutiveObserverFailures: health.consecutiveObserverFailures,
          lastError: health.lastError,
          degraded: health.consecutiveObserverFailures >= 2 || health.observerLagSeqs > 48,
        },
        searchableItems: countActiveMemoryItems(db),
        transcriptMessages: transcript.count,
        sense: { available: true, note: 'Sense is observed screen/activity context, not user-stated personal memory.' },
      })
    },
  })

  pi.registerTool({
    name: 'memory_search',
    label: 'Search Memory',
    description: 'Search Bond’s durable sourced memory for facts, preferences, decisions, or open threads.',
    parameters: Type.Object({
      query: Type.String({ description: 'Specific memory query' }),
      kind: Type.Optional(StringEnum(MEMORY_ITEM_KINDS)),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const matches = searchMemory(params.query, { limit: params.limit ?? 8 })
        .filter(result => !params.kind || result.item.kind === params.kind)
        .map(result => ({ ...result.item, score: result.score, sourceIds: getMemoryItemSourceIds(result.item.id) }))
      return toolResult({ results: matches })
    },
  })

  pi.registerTool({
    name: 'memory_recall',
    label: 'Recall Memory Source',
    description: 'Retrieve a memory item and the exact transcript messages that support it.',
    parameters: Type.Object({ id: Type.String({ description: 'Memory item ID returned by memory_search' }) }),
    async execute(_toolCallId, params) {
      const item = getMemoryItem(params.id)
      if (!item) throw new Error(`Memory item not found: ${params.id}`)
      const related = getMemoryItemSourceIds(item.id)
      const sourceIds = related.length ? related : sourceIdsFromLegacyTags(item.tags)
      return toolResult({ item, sourceIds, messages: getSourceMessages(sourceIds) })
    },
  })

  pi.registerTool({
    name: 'history_search',
    label: 'Search History',
    description: 'Search Bond’s exact conversation transcript for previous wording, dates, paths, numbers, or discussions. Matching is per-word AND; "quoted spans" match as phrases; if nothing matches, the search automatically broadens to OR. Prefer 2–3 distinctive terms over a long descriptive sentence. Tool activity (files read/written, commands run) is searched too and returned separately as activityMatches.',
    parameters: Type.Object({
      query: Type.String({ description: 'Specific transcript query — 2-3 distinctive terms' }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const limit = params.limit ?? 8
      // roles filters in SQL: post-LIMIT filtering discarded up to 6 of 8 slots
      // to activity rows and returned empty while matches existed.
      const messages = searchMessages(params.query, { limit, roles: ['user', 'bond'] })
        .map(message => ({ id: message.id, seq: message.seq, role: message.role, text: message.text, createdAt: message.createdAt }))
      // The audit document's content lived in tool outputs all morning (FTS
      // indexes activity events up to 4k chars). Those were the best matches
      // in the index and the old post-filter threw every one of them away.
      const activityMatches = searchActivitySnippets(params.query, 3)
      return toolResult({ messages, activityMatches })
    },
  })

  pi.registerTool({
    name: 'memory_manage',
    label: 'Manage Memory',
    description: 'Remember, update, or forget durable user memory. Use only for explicit remember/forget requests or clear user corrections.',
    parameters: Type.Object({
      action: StringEnum(['remember', 'update', 'forget'] as const),
      id: Type.Optional(Type.String({ description: 'Existing memory ID for update or forget' })),
      text: Type.Optional(Type.String({ description: 'Standalone memory text for remember or update' })),
      kind: Type.Optional(StringEnum(MEMORY_ITEM_KINDS)),
      core: Type.Optional(Type.Boolean({ description: 'Also keep this stable item in always-available Core memory' })),
    }),
    async execute(_toolCallId, params) {
      if (params.action === 'remember') {
        if (!params.text?.trim()) throw new Error('text is required when remembering')
        assertSafeMemoryText(params.text.trim())
        const existing = findActiveMemoryByText(params.text.trim())
        const item = existing ?? upsertMemoryItem({
          text: params.text.trim(),
          kind: params.kind ?? 'fact',
          source: 'user',
          confidence: 1,
          tags: ['explicit'],
        })
        const previousSources = getMemoryItemSourceIds(item.id)
        const sourceIds = options.sourceMessageId
          ? setMemoryItemSources(item.id, [...previousSources, options.sourceMessageId])
          : previousSources
        if (params.core) await addToCore(item)
        const firstRunReminder = firstRunToolReminder()
        return toolResult({
          action: 'remembered',
          item,
          sourceIds,
          core: Boolean(params.core),
          ...(firstRunReminder ? { firstRunOnboarding: firstRunReminder } : {}),
        })
      }

      if (!params.id) throw new Error('id is required when updating or forgetting')
      const current = getMemoryItem(params.id)
      if (!current) throw new Error(`Memory item not found: ${params.id}`)

      if (params.action === 'forget') {
        const item = upsertMemoryItem({ ...current, active: false, updatedAt: new Date().toISOString() })
        await removeFromCore(current)
        return toolResult({ action: 'forgotten', item })
      }

      const nextText = params.text?.trim() || current.text
      assertSafeMemoryText(nextText)
      const item = upsertMemoryItem({
        ...current,
        text: nextText,
        kind: params.kind ?? current.kind,
        source: 'user',
        updatedAt: new Date().toISOString(),
      })
      if (options.sourceMessageId) {
        const existingSources = getMemoryItemSourceIds(item.id)
        setMemoryItemSources(item.id, [...existingSources, options.sourceMessageId])
      }
      await replaceInCore(current, item)
      if (params.core) await addToCore(item)
      return toolResult({ action: 'updated', item, core: Boolean(params.core) })
    },
  })
}

export function createMemoryExtensionFactory(options: { sourceMessageId?: string } = {}) {
  return (pi: ExtensionAPI) => registerMemoryTools(pi, options)
}
