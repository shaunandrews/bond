import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/agents'
import { runnerHash } from './evidence'
import type { AgentDefinition } from './definition'

let approvedHashes: string[] = []
let stored: Record<string, unknown> = {}
let roster: AgentDefinition[] = []

vi.mock('../settings', () => ({
  getApprovedRunnerHashes: vi.fn(() => approvedHashes),
  revokeRunnerHash: vi.fn((hash: string) => {
    approvedHashes = approvedHashes.filter(entry => entry !== hash)
  }),
  setAgentSettingsOverride: vi.fn((name: string, settings: unknown) => {
    stored[name] = settings
  }),
  getAgentSettingsOverride: vi.fn((name: string) => stored[name] ?? {}),
}))

vi.mock('./registry', async () => {
  const { normalizeAgentSettings } = await vi.importActual<typeof import('../../shared/agents')>('../../shared/agents')
  return {
    loadAgentRoster: vi.fn(() => ({ agents: roster, problems: [{ source: '/bad/AGENT.md', reason: 'no verbs' }] })),
    findAgent: vi.fn((name: string) => roster.find(agent => agent.name === name.toLowerCase())),
    effectiveAgentSettings: vi.fn((definition: AgentDefinition) =>
      normalizeAgentSettings(stored[definition.name] ?? {}, definition.defaults)),
  }
})

import { setAgentSettingsOverride } from '../settings'
import { listAgents, revokeAgentRunner, updateAgentSettings } from './service'

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'q',
    label: 'Q',
    role: 'Coding Consultant',
    mark: 'Q',
    bio: 'bio',
    source: 'builtin',
    sourcePath: null,
    doctrine: 'Doctrine.',
    verbs: [{ name: 'review', description: 'Read a change.', workflow: 'W.' }],
    evidence: [
      { name: 'tests', command: 'npm run test:run', kind: 'shell', verbs: [] },
      { name: 'detector', command: 'builtin:impeccable-detect', kind: 'native', verbs: [] },
    ],
    contextDocs: ['CLAUDE.md'],
    defaults: { ...DEFAULT_AGENT_SETTINGS, model: 'high', leash: 420 },
    ...overrides,
  }
}

beforeEach(() => {
  approvedHashes = []
  stored = {}
  roster = [definition()]
  vi.clearAllMocks()
})

describe('listAgents', () => {
  it('summarizes definitions and passes problems through', () => {
    const { agents, problems } = listAgents()
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ name: 'q', label: 'Q', source: 'builtin', contextDocs: ['CLAUDE.md'] })
    expect(agents[0].verbs).toEqual([{ name: 'review', description: 'Read a change.' }])
    expect(problems).toEqual([{ source: '/bad/AGENT.md', reason: 'no verbs' }])
  })

  it('marks native runners approved and shell runners by their approval state', () => {
    const before = listAgents().agents[0].evidence
    expect(before.find(runner => runner.kind === 'native')!.approved).toBe(true)
    expect(before.find(runner => runner.name === 'tests')!.approved).toBe(false)

    approvedHashes = [runnerHash('npm run test:run')]
    expect(listAgents().agents[0].evidence.find(runner => runner.name === 'tests')!.approved).toBe(true)
  })

  it('reports the definition defaults alongside effective settings', () => {
    const summary = listAgents().agents[0]
    expect(summary.defaults.model).toBe('high')
    expect(summary.settings.model).toBe('high')
    expect(summary.settings.leash).toBe(420)
  })
})

describe('updateAgentSettings', () => {
  it('merges a partial update over current settings without resetting other fields', () => {
    stored = { q: { model: 'fast', instructions: 'Keep it terse.' } }
    const updated = updateAgentSettings('q', { report: 'quick' })

    expect(setAgentSettingsOverride).toHaveBeenCalledWith('q', expect.objectContaining({
      model: 'fast',
      instructions: 'Keep it terse.',
      report: 'quick',
    }))
    expect(updated.settings.report).toBe('quick')
  })

  it('normalizes hostile input rather than persisting it', () => {
    updateAgentSettings('q', { tools: ['bash'], model: 'wishful', leash: 99_999 } as never)
    expect(setAgentSettingsOverride).toHaveBeenCalledWith('q', expect.objectContaining({
      tools: [],
      model: 'high',
      leash: 900,
    }))
  })

  it('rejects an unknown agent', () => {
    expect(() => updateAgentSettings('nobody', { report: 'quick' })).toThrow('Unknown agent')
  })
})

describe('revokeAgentRunner', () => {
  it('drops the approval and returns the refreshed roster', () => {
    approvedHashes = [runnerHash('npm run test:run')]
    const { agents } = revokeAgentRunner('npm run test:run')
    expect(agents[0].evidence.find(runner => runner.name === 'tests')!.approved).toBe(false)
  })
})
