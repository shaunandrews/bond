import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAgentContextEnvelope, buildMemoryStateSection, harvestPiCompactionSummary, buildSystemPrompt, buildSystemPromptPreview, resolveRecallQuery, shouldRecallMemory } from './agent'
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

  it('includes the first-run interview only while onboarding is pending', async () => {
    // Empty test DB → genuine first run
    expect(buildSystemPromptPreview()).toContain('FIRST-RUN ONBOARDING')

    const { completeFirstRun } = await import('./onboarding')
    completeFirstRun()
    expect(buildSystemPromptPreview()).not.toContain('FIRST-RUN ONBOARDING')
  })

  it('teaches Bond its memory layers and tools', () => {
    const prompt = buildSystemPromptPreview()
    expect(prompt).toContain('Bond has a persistent memory system')
    expect(prompt).toContain('memory_status')
    expect(prompt).toContain('memory_search')
    expect(prompt).toContain('memory_recall')
    expect(prompt).toContain('history_search')
    expect(prompt).toContain('memory_manage')
    expect(prompt).toContain('Never claim that you lack memory')
  })

  it('never tells full-access sessions that writes need approval', () => {
    // Regression: the base prompt claimed "Write operations require user approval"
    // unconditionally, so in full mode — where runtime.ts gates nothing — Bond
    // asked for approval in prose instead of just writing the file.
    const prompt = buildSystemPromptPreview({ editMode: { type: 'full' } })
    expect(prompt).not.toMatch(/write operations require user approval/i)
    expect(prompt).toContain('FULL ACCESS mode')
    expect(prompt).toContain('never ask the user to approve an action in prose')
  })

  it('still states the approval boundary in scoped and read-only modes', () => {
    expect(buildSystemPromptPreview({ editMode: { type: 'scoped', allowedPaths: ['~/Downloads'] } }))
      .toContain('bash commands still require user approval')
    expect(buildSystemPromptPreview({ editMode: { type: 'readonly' } }))
      .toContain('READ-ONLY workspace mode')
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
    expect(envelope).toContain('Retrieved memory')
    expect(envelope).toContain('Transcript recall')
    expect(envelope).toContain('Recent screen context')
    expect(envelope).toContain('Epoch handoff (previous context closed: context_soft_limit)')
    expect(envelope).not.toContain('<unsafe>')
    expect(envelope).not.toContain('<Docs>')

    // Stable state moved to the system prompt: the envelope rides inside the
    // user message and accumulates in session history forever.
    expect(envelope).not.toContain('Core memory:')
    expect(envelope).not.toContain('Working memory:')
  })
})

describe('stable memory state rides the system prompt', () => {
  it('renders core and working state after the soul, only when supplied', () => {
    writeCoreMemoryAtomic({ version: 1, facts: ['Shaun designs first <raw>'], preferences: [], decisions: [], updatedAt: '2026-01-01T00:00:00.000Z' })
    setSetting('memory.working', JSON.stringify(createWorkingState({
      goal: 'Continue the Studio trunk audit',
      artifacts: [{ kind: 'library', ref: '/library/058eb00f.md', lastTouchedAt: '2026-07-21T18:00:00.000Z' }],
      activeSkill: 'audit-triage-feedback',
    })))

    const state = buildMemoryStateSection()
    expect(state).toContain('Core memory')
    expect(state).toContain('058eb00f')
    expect(state).toContain('audit-triage-feedback')

    const withState = buildSystemPrompt({ memoryState: state })
    expect(withState).toContain('<bond-memory-state>')
    expect(withState).toContain('058eb00f')
    expect(withState).toContain('Shaun designs first &lt;raw&gt;')
    expect(withState).not.toContain('<raw>')

    // The closing tag only exists when the block actually renders — the base
    // prompt names <bond-memory-state> in prose when teaching Bond its layers.
    expect(withState).toContain('</bond-memory-state>')
    const withoutState = buildSystemPrompt()
    expect(withoutState).not.toContain('</bond-memory-state>')
    expect(buildSystemPromptPreview()).not.toContain('</bond-memory-state>')
    // The block is last, so the long static prefix stays byte-identical for caching.
    expect(withState.startsWith(withoutState)).toBe(true)
  })

  it('survives an unreadable memory state without breaking the prompt', () => {
    setSetting('memory.working', '{not json')
    expect(() => buildMemoryStateSection()).not.toThrow()
  })
})

describe('epoch handoff carries state, not a prose tail', () => {
  it('THE INCIDENT: names the artifact instead of the numbering convention', () => {
    // The 17:05Z handoff delivered "ok, on to 7!" and described the artifact as
    // "a Library markdown file" — no path, no id, no title.
    setSetting('memory.working', JSON.stringify(createWorkingState({
      goal: 'Continue the Studio trunk audit and file findings as Linear issues.',
      artifacts: [
        { kind: 'library', ref: '/library/058eb00f-4d8c-4bb2-93c4-a4aaa16e7290.md', label: 'Studio trunk audit — July 21, 2026', lastTouchedAt: '2026-07-21T18:00:00.000Z' },
        { kind: 'issue', ref: 'STU-2085', lastTouchedAt: '2026-07-21T17:50:00.000Z' },
      ],
      activeSkill: 'audit-triage-feedback',
      checkpoint: 'audit item 8 of 18 filed; next 9',
      openThreads: ['Finish items 9-18'],
    })))

    createEpoch({ id: 'epoch-old', piSessionId: 'pi-old' })
    insertTurnStart({ epochId: 'epoch-old', turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'ok, on to 7!' })
    const previousEpoch = closeEpoch({ id: 'epoch-old', reason: 'context_soft_limit' })

    const envelope = buildAgentContextEnvelope({ query: 'next', previousEpoch })
    expect(envelope).toContain('058eb00f')
    expect(envelope).toContain('STU-2085')
    expect(envelope).toContain('audit-triage-feedback')
    expect(envelope).toContain('audit item 8 of 18 filed; next 9')
    expect(envelope).toContain('ok, on to 7!')
  })

  it('harvests the LAST Pi compaction summary and tolerates junk', () => {
    const file = join(testDir, 'session.jsonl')
    writeFileSync(file, [
      '{"type":"message","role":"user"}',
      '{"type":"compaction","summary":"Old summary"}',
      '{"type":"compaction" broken json',
      '{"type":"compaction","summary":"## Goal\\nStudio trunk audit at /library/058eb00f.md"}',
      '',
    ].join('\n'))

    expect(harvestPiCompactionSummary(file)).toContain('058eb00f')
    expect(harvestPiCompactionSummary(file)).not.toContain('Old summary')
    expect(harvestPiCompactionSummary(join(testDir, 'missing.jsonl'))).toBeNull()
    expect(harvestPiCompactionSummary(null)).toBeNull()
  })

  it('renders a full snapshot even with no compaction record (the incident session had none)', () => {
    setSetting('memory.working', JSON.stringify(createWorkingState({ goal: 'Ship memory reliability' })))
    createEpoch({ id: 'epoch-old', piSessionId: 'pi-old', piSessionFile: join(testDir, 'nope.jsonl') })
    const previousEpoch = closeEpoch({ id: 'epoch-old', reason: 'context_soft_limit' })

    const envelope = buildAgentContextEnvelope({ query: 'next', previousEpoch })
    expect(envelope).toContain('Ship memory reliability')
    expect(envelope).not.toContain('Pi summary')
  })
})

describe('recall query retargeting', () => {
  const working = createWorkingState({
    goal: 'Continue the Studio trunk audit and file findings as Linear issues.',
    checkpoint: 'audit item 8 of 18 filed',
    artifacts: [{ kind: 'library', ref: '/library/058eb00f.md', label: 'Studio trunk audit — July 21, 2026', lastTouchedAt: '2026-07-21T18:00:00.000Z' }],
  })

  it('THE INCIDENT: a short deictic message searches the active work', () => {
    // "Lets move on to 9." — 3 terms of <4 chars, so the gate rejected it and
    // the retrieval query was empty. 176 of 1,245 user messages (14%) do this.
    const resolved = resolveRecallQuery('Lets move on to 9.', working, 'ok, lets file it in linear')
    expect(resolved).not.toBe('')
    expect(resolved).toContain('audit')
    expect(resolved).toContain('item 8 of 18')
    expect(resolved).toContain('linear')
  })

  it('leaves an explicit or specific query untouched', () => {
    expect(resolveRecallQuery('remember this', working, 'prev')).toBe('remember this')
    expect(resolveRecallQuery('where did we land on the composer layout', working, 'prev'))
      .toBe('where did we land on the composer layout')
  })

  it('returns empty when there is nothing to fall back to', () => {
    expect(resolveRecallQuery('next', createWorkingState(), null)).toBe('')
  })

  it('the gate itself still rejects short deictic messages', () => {
    expect(shouldRecallMemory('Lets move on to 9.')).toBe(false)
    expect(shouldRecallMemory('next')).toBe(false)
    expect(shouldRecallMemory('remember the audit')).toBe(true)
  })
})
