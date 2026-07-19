import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { closeDb, getDb } from './db'
import { getSetting, getSoul, saveSoul } from './settings'
import { upsertMemoryItem } from './memory/store'
import { registerMemoryTools } from './memory/tools'
import { listMessages } from './transcript'
import {
  beginFirstRun,
  buildFirstRunPromptSection,
  completeFirstRun,
  firstRunToolReminder,
  getFirstRunStatus,
  registerOnboardingTools,
  skipFirstRun,
} from './onboarding'

let testDir: string

const settingKey = 'onboarding.firstRun.v1'

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-onboarding-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

describe('first-run status', () => {
  it('first status call marks a clean install pending and persists it', () => {
    const status = getFirstRunStatus()

    expect(status.status).toBe('pending')
    expect(JSON.parse(getSetting(settingKey) ?? '{}').status).toBe('pending')
    expect(getFirstRunStatus().status).toBe('pending')
  })

  it.each([
    ['transcript messages', () => getDb().prepare("INSERT INTO messages (id, role, text, seq) VALUES ('m1', 'user', 'hello', 1)").run()],
    ['memory items', () => upsertMemoryItem({ id: 'mem1', text: 'Existing memory', source: 'user' })],
    ['collections', () => getDb().prepare("INSERT INTO collections (id, name, icon, schema, features, archived, created_at, updated_at) VALUES ('c1', 'Movies', '', '[]', '[]', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run()],
    ['Sense captures', () => {
      const db = getDb()
      db.prepare("INSERT INTO sense_sessions (id, started_at, created_at) VALUES ('ss1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run()
      db.prepare("INSERT INTO sense_captures (id, session_id, captured_at, created_at) VALUES ('sc1', 'ss1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run()
    }],
    ['images', () => {
      const db = getDb()
      db.prepare("INSERT INTO sessions (id, title, summary, archived, created_at, updated_at) VALUES ('s1', 'x', '', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run()
      db.prepare("INSERT INTO images (id, session_id, filename, media_type, size_bytes, created_at) VALUES ('i1', 's1', 'i1.png', 'image/png', 1, '2026-01-01T00:00:00.000Z')").run()
    }],
  ])('first status call marks existing-user when DB has %s', (_name, seed) => {
    seed()
    expect(getFirstRunStatus().status).toBe('existing-user')
  })

  it('skip and complete update the persisted state', () => {
    expect(skipFirstRun().status).toBe('skipped')
    expect(getFirstRunStatus().status).toBe('skipped')
    expect(completeFirstRun().status).toBe('completed')
    expect(getFirstRunStatus().status).toBe('completed')
  })
})

describe('beginFirstRun', () => {
  it('seeds the intro as the first real transcript message, idempotently', () => {
    expect(getFirstRunStatus().status).toBe('pending')

    beginFirstRun()
    beginFirstRun()

    const messages = listMessages({ limit: 10 }).messages
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('bond')
    // The opener asks exactly one thing: a name. No "across conversations" copy.
    expect(messages[0].text).toContain('what should I call you?')
    expect(messages[0].text).not.toMatch(/across conversations|sessions/i)
    expect(messages[0].data).toMatchObject({ onboarding: true })
  })

  it('does nothing for an existing user', () => {
    getDb().prepare("INSERT INTO messages (id, role, text, seq) VALUES ('m1', 'user', 'hello', 1)").run()
    expect(getFirstRunStatus().status).toBe('existing-user')

    beginFirstRun()

    expect(listMessages({ limit: 10 }).messages).toHaveLength(1)
  })
})

describe('buildFirstRunPromptSection', () => {
  it('gives the agent a mission with craft rules while pending', () => {
    expect(getFirstRunStatus().status).toBe('pending')
    const section = buildFirstRunPromptSection()

    expect(section).toContain('FIRST-RUN ONBOARDING')
    // Mission, not a topic checklist.
    expect(section).toContain('what they want you to BE for them')
    // The frame-picker question, with "just poking around" as a valid frame.
    expect(section).toContain('Just poking around')
    // Explicitly forbids the work/productivity assumption...
    expect(section).toMatch(/Do NOT assume they work/)
    // ...but still proactively learns role and goals, phrased openly.
    expect(section).toContain('their role if they have a job')
    expect(section).toContain('without assuming employment')
    // Thread-pulls dig into the person, never into project status/priorities.
    expect(section).toContain('about the person, never the project')
    expect(section).toContain('who they are, not what their work needs')
    // Conversational craft: one question per turn, react before asking.
    expect(section).toContain('Exactly one question per turn')
    expect(section).toContain('React first with something real')
    // The behavior either/or, the wildcard, and the reflect-back payoff.
    expect(section).toContain('wildcard')
    // The people beat: partner, kids, friends — warm, not a census.
    expect(section).toContain('a partner, kids, parents, siblings, close friends')
    expect(section).toContain('not a census')
    // The soul question: invite the user to shape Bond's persona, with
    // response style folded into the same question, and feed the answer into
    // the soul written at the close.
    expect(section).toContain('persona and response style are ONE question')
    expect(section).toContain('sophisticated English spy')
    expect(section).toContain('wacky beaver')
    expect(section).toContain('backbone of the soul you write at the close')
    // The close is a real ending: reflect back, complete, and don't start
    // project work while the interview is still open.
    expect(section).toContain('a real ending, not a fade-out')
    expect(section).toContain('reflect back what you have learned')
    expect(section).toContain('You are onboarding until you have called complete_onboarding')
    // Memory saves alone must never count as finishing, and the completion
    // call rides in the same tool batch as the saves.
    expect(section).toContain('Saving memories does NOT finish onboarding')
    expect(section).toContain('never one without the other')
    // The close flows straight into the tour — no "want a tour?" ask.
    expect(section).toContain('flow STRAIGHT into the tour')
    // The section's own presence is the status — no bluffing "yep, onboarded".
    expect(section).toContain('only exists in your prompt while onboarding is unfinished')
    // Memory writes and the soul-seeding completion call.
    expect(section).toContain('memory_manage')
    expect(section).toContain('core=true')
    expect(section).toContain('complete_onboarding')
    expect(section).toContain('passing soul')
  })

  it('is empty once onboarding is not pending', () => {
    completeFirstRun()
    expect(buildFirstRunPromptSection()).toBe('')
    skipFirstRun()
    expect(buildFirstRunPromptSection()).toBe('')
  })
})

describe('firstRunToolReminder', () => {
  it('returns the completion reminder only while pending', () => {
    expect(getFirstRunStatus().status).toBe('pending')
    expect(firstRunToolReminder()).toContain('complete_onboarding has NOT been called')
    completeFirstRun()
    expect(firstRunToolReminder()).toBeUndefined()
  })

  it('rides along in memory_manage remember results during onboarding', async () => {
    expect(getFirstRunStatus().status).toBe('pending')
    const tools: Record<string, { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }> }> = {}
    registerMemoryTools({ registerTool: (tool: never) => { tools[(tool as { name: string }).name] = tool as never } } as never)

    const pending = await tools.memory_manage.execute('c1', { action: 'remember', text: 'Shaun plays drums.' })
    expect(pending.content[0].text).toContain('FIRST-RUN ONBOARDING IS STILL OPEN')

    completeFirstRun()
    const done = await tools.memory_manage.execute('c2', { action: 'remember', text: 'Shaun likes coffee.' })
    expect(done.content[0].text).not.toContain('FIRST-RUN ONBOARDING')
  })
})

type RegisteredTool = {
  name: string
  execute: (id: string, params?: unknown) => Promise<{ content: { type: string; text: string }[] }>
}

function registerTools(hooks?: Parameters<typeof registerOnboardingTools>[1]) {
  const tools: Record<string, RegisteredTool> = {}
  const pi = { registerTool: vi.fn((tool: RegisteredTool) => { tools[tool.name] = tool }) }
  registerOnboardingTools(pi as never, hooks)
  return tools
}

describe('complete_onboarding tool', () => {
  it('moves onboarding into the tour and hands back the tour script', async () => {
    expect(getFirstRunStatus().status).toBe('pending')

    const tools = registerTools()
    expect(Object.keys(tools)).toEqual(['complete_onboarding', 'complete_tour', 'show_panel', 'enable_sense'])

    const result = await tools.complete_onboarding.execute('call-1', {})
    expect(getFirstRunStatus().status).toBe('education')
    expect(getSoul()).toBe('')
    // The tour begins in the same turn, driven from the tool result.
    expect(result.content[0].text).toContain('THE TOUR BEGINS NOW')
    expect(result.content[0].text).toContain('show_panel')
  })

  it('seeds the initial soul from the interview', async () => {
    const tools = registerTools()

    await tools.complete_onboarding.execute('call-1', { soul: 'Be blunt and quick with Shaun.\nHe cares about craft.' })

    expect(getFirstRunStatus().status).toBe('education')
    expect(getSoul()).toBe('Be blunt and quick with Shaun.\nHe cares about craft.')
  })

  it('never clobbers a soul the user already wrote', async () => {
    saveSoul('User-authored soul.')
    const tools = registerTools()

    await tools.complete_onboarding.execute('call-1', { soul: 'Agent-drafted soul.' })

    expect(getFirstRunStatus().status).toBe('education')
    expect(getSoul()).toBe('User-authored soul.')
  })
})

describe('tour tools', () => {
  it('complete_tour finishes onboarding from the education stage', async () => {
    const tools = registerTools()
    await tools.complete_onboarding.execute('c1', {})
    expect(getFirstRunStatus().status).toBe('education')

    await tools.complete_tour.execute('c2', {})
    expect(getFirstRunStatus().status).toBe('completed')
  })

  it('show_panel forwards the panel to the renderer hook', async () => {
    const shown: string[] = []
    const tools = registerTools({ showPanel: (panel) => { shown.push(panel) } })

    await tools.show_panel.execute('c1', { panel: 'memory' })
    expect(shown).toEqual(['memory'])
  })

  // Regression, round two: models front-load their tool batch, so the panel
  // opened seconds before the first word of the beat streamed. A blocking
  // "call again" result failed — the model introduced the panel and never
  // retried, so nothing opened. The runtime now defers the open and performs
  // it itself; the tool result must tell the model the open is handled.
  it('show_panel relays a deferred open and forbids retrying', async () => {
    const showPanel = vi.fn(() => 'deferred' as const)
    const tools = registerTools({ showPanel })

    const result = await tools.show_panel.execute('c1', { panel: 'sense' })
    expect(showPanel).toHaveBeenCalledWith('sense')
    expect(result.content[0].text).toContain('QUEUED')
    expect(result.content[0].text).toContain('will open by itself')
    expect(result.content[0].text).toContain('Do NOT call show_panel again')
  })

  it('show_panel reports an immediate open once narration has streamed', async () => {
    const showPanel = vi.fn(() => 'opened' as const)
    const tools = registerTools({ showPanel })

    const result = await tools.show_panel.execute('c1', { panel: 'sense' })
    expect(showPanel).toHaveBeenCalledWith('sense')
    expect(result.content[0].text).toBe('Opened the sense panel.')
  })

  it('show_panel degrades gracefully without a hook', async () => {
    const tools = registerTools()
    const result = await tools.show_panel.execute('c1', { panel: 'sense' })
    expect(result.content[0].text).toContain('unavailable')
  })

  it('enable_sense reports the armed state with the permission caveat', async () => {
    let enabled = false
    const tools = registerTools({ enableSense: () => { enabled = true; return { enabled: true, state: 'armed' } } })

    const result = await tools.enable_sense.execute('c1', {})
    expect(enabled).toBe(true)
    expect(result.content[0].text).toContain('Screen Recording')
    expect(result.content[0].text).toContain('permission was already granted')
  })

  // Regression: the suspended-state note used to tell the model about "the
  // new-user simulation", and the model relayed it verbatim — breaking the
  // fourth wall of the exact first-run being previewed, then stalling.
  it('enable_sense keeps the reply in-world when Sense is suspended (sandbox)', async () => {
    const tools = registerTools({ enableSense: () => ({ enabled: false, state: 'suspended' }) })

    const result = await tools.enable_sense.execute('c1', {})
    expect(result.content[0].text).toContain('Sense is on')
    expect(result.content[0].text).toContain('NEVER mention suspension, sandboxes, simulations')
    expect(result.content[0].text).toContain('forward handoff')
  })

  it('enable_sense degrades gracefully without a hook', async () => {
    const tools = registerTools()
    const result = await tools.enable_sense.execute('c1', {})
    expect(result.content[0].text).toContain('unavailable')
  })
})

describe('tour prompt section', () => {
  it('serves the tour guide while in the education stage', async () => {
    const tools = registerTools()
    await tools.complete_onboarding.execute('c1', {})

    const section = buildFirstRunPromptSection()
    expect(section).toContain('ONBOARDING TOUR')
    // The four beats in tour order — Sense first (useful before any setup),
    // Collections last as the deep finale.
    const positions = ['sense', 'media', 'memory', 'collections'].map(panel => section.indexOf(`show_panel "${panel}"`))
    for (const pos of positions) expect(pos).toBeGreaterThan(-1)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // Collections goes into the weeds; the interview's no-weeds rule is lifted.
    expect(section).toContain('the weeds are welcome here')
    // Bond only knows the panel opens beside the chat — no invented UI.
    expect(section).toContain('never invent locations')
    // Recover from confusion, don't quit.
    expect(section).toContain('never abandon the tour')
    // A guide, not a fast-moving robot: bridge preamble, one panel per turn,
    // narrated panel switches, and a close that lands a concrete first move.
    expect(section).toContain('Open with a bridge')
    expect(section).toContain('PACING IS SACRED: one panel per turn')
    // Regression: panels used to pop open mid-sentence; each beat must
    // introduce the room in its own message before show_panel is called.
    expect(section).toContain('INTRODUCE, then OPEN, then ANCHOR')
    expect(section).toContain('Only after that introduction is fully delivered')
    // Regression: a resolved beat used to end as a dead stop with nothing to
    // answer; every wrap-up must hand forward to the next room.
    expect(section).toContain('forward handoff')
    expect(section).toContain('say "skip"')
    expect(section).toContain('ONE concrete first move')
    // Consent-gated Sense enablement; the permission story comes from the
    // tool result's actual state, never promised up front.
    expect(section).toContain('enable_sense')
    expect(section).toContain('relay honestly what its result says')
    // A real ending plus the self-verifying status line.
    expect(section).toContain('complete_tour')
    expect(section).toContain('complete_tour has NOT been called')
  })
})
