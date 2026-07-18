import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAgentContextEnvelope, buildSystemPromptPreview } from './agent'
import { closeDb, getDb } from './db'
import { setDataDir } from './paths'
import { writeCoreMemoryAtomic } from './memory/core-memory'
import { createWorkingState } from './memory/working-state'
import { upsertMemoryItem } from './memory/store'
import { setSetting } from './settings'
import { createEpoch, closeEpoch } from './epochs'
import { insertTurnStart, upsertMessages } from './transcript'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-agent-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

describe('agent prompt/context integration', () => {
  it('keeps debrief and session-management language out of the base prompt', () => {
    const prompt = buildSystemPromptPreview()
    expect(prompt).not.toMatch(/SESSION DEBRIEFS|session debriefs|session management/i)
    expect(prompt).toContain('SENSE — SCREEN AWARENESS')
    expect(prompt).not.toContain('bond sense debrief')
  })

  it('builds a bounded escaped context envelope from memory, transcript recall, screen context, and epoch handoff', () => {
    writeCoreMemoryAtomic({ version: 1, facts: ['Core fact <unsafe>'], preferences: [], decisions: [], updatedAt: '2026-01-01T00:00:00.000Z' })
    setSetting('memory.working', JSON.stringify(createWorkingState({ goal: 'Ship context envelope' })))
    upsertMemoryItem({ id: 'm1', text: 'Use Vitest for agent context tests', projectId: null })

    createEpoch({ id: 'epoch-old', piSessionId: 'pi-old' })
    insertTurnStart({ epochId: 'epoch-old', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'Remember Vitest agent context tests' })
    upsertMessages([{ id: 'b1', role: 'bond', epochId: 'epoch-old', turnId: 'turn-1', text: 'Older transcript answer <do not execute>' }])
    const previousEpoch = closeEpoch({ id: 'epoch-old', reason: 'context_soft_limit' })

    setSetting('sense', JSON.stringify({ enabled: true, autoContextInChat: true }))
    const now = new Date().toISOString()
    getDb().prepare('INSERT INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, ?, ?)').run('sense-1', now, 1, now)
    getDb().prepare(`
      INSERT INTO sense_captures (id, session_id, captured_at, app_name, app_bundle_id, window_title, capture_trigger, text_status, text_content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('cap-1', 'sense-1', now, 'Safari', 'com.apple.Safari', '<Docs>', 'interval', 'done', 'Visible <text>', now)

    const envelope = buildAgentContextEnvelope({ query: 'remember Vitest agent context tests', previousEpoch })
    expect(envelope).toContain('<bond-context-envelope>')
    expect(envelope).toContain('Core fact &lt;unsafe&gt;')
    expect(envelope).toContain('Working memory')
    expect(envelope).toContain('Retrieved memory')
    expect(envelope).toContain('Transcript recall')
    expect(envelope).toContain('Recent screen context')
    expect(envelope).toContain('New epoch handoff')
    expect(envelope).not.toContain('<unsafe>')
    expect(envelope).not.toContain('<Docs>')
  })
})
