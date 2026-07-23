import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let agentsDir = ''
let settingsOverride: Record<string, unknown> = {}

vi.mock('../settings', () => ({
  getAgentSettingsOverride: vi.fn((name: string) => settingsOverride[name] ?? {}),
}))

import { effectiveAgentSettings, findAgent, getAgentsDir, loadAgentRoster } from './registry'

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), 'bond-agents-'))
  settingsOverride = {}
})

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true })
})

function writeAgent(name: string, content: string): void {
  mkdirSync(join(agentsDir, name), { recursive: true })
  writeFileSync(join(agentsDir, name, 'AGENT.md'), content)
}

describe('getAgentsDir', () => {
  it('lives under ~/.bond/agents', () => {
    expect(getAgentsDir()).toMatch(/\.bond\/agents$/)
  })
})

describe('loadAgentRoster', () => {
  it('includes the bundled agents with no user files present', () => {
    const { agents, problems } = loadAgentRoster({ dir: agentsDir })
    expect(problems).toEqual([])
    expect(agents.map(agent => agent.name)).toEqual(['felix', 'mathis', 'q'])
    expect(agents.every(agent => agent.source === 'builtin')).toBe(true)
  })

  it('adds a valid user agent to the roster', () => {
    writeAgent('scout', `---
name: scout
role: Recon
verbs: [look]
---
Doctrine.

## verb: look
W.`)
    const { agents } = loadAgentRoster({ dir: agentsDir })
    expect(agents.map(agent => agent.name)).toEqual(['felix', 'mathis', 'q', 'scout'])
    const scout = agents.find(agent => agent.name === 'scout')!
    expect(scout.source).toBe('user')
    expect(scout.sourcePath).toContain('scout/AGENT.md')
  })

  it('lets a user definition override a bundled agent of the same name', () => {
    writeAgent('felix', `---
name: felix
role: My Felix
verbs: [look]
---
Custom doctrine.

## verb: look
W.`)
    const felix = loadAgentRoster({ dir: agentsDir }).agents.find(agent => agent.name === 'felix')!
    expect(felix.source).toBe('user')
    expect(felix.role).toBe('My Felix')
    expect(felix.doctrine).toBe('Custom doctrine.')
  })

  it('reports an invalid definition as a problem instead of dropping it silently', () => {
    writeAgent('broken', `---
name: broken
---
No verbs here.`)
    const { agents, problems } = loadAgentRoster({ dir: agentsDir })
    expect(agents.map(agent => agent.name)).toEqual(['felix', 'mathis', 'q'])
    expect(problems).toHaveLength(1)
    expect(problems[0].source).toContain('broken/AGENT.md')
    expect(problems[0].reason).toContain('at least one verb')
  })

  it('ignores directories without an AGENT.md', () => {
    mkdirSync(join(agentsDir, 'empty'), { recursive: true })
    expect(loadAgentRoster({ dir: agentsDir }).problems).toEqual([])
  })
})

describe('findAgent', () => {
  it('finds by name, case-insensitively, and returns undefined otherwise', () => {
    expect(findAgent('FELIX', { dir: agentsDir })?.label).toBe('Felix')
    expect(findAgent('nobody', { dir: agentsDir })).toBeUndefined()
  })
})

describe('effectiveAgentSettings', () => {
  it('uses the definition defaults when nothing is overridden', () => {
    const felix = findAgent('felix', { dir: agentsDir })!
    expect(effectiveAgentSettings(felix).model).toBe(felix.defaults.model)
    expect(effectiveAgentSettings(felix).model).toBe('high')
  })

  it('layers the persisted override over the definition defaults', () => {
    settingsOverride = { felix: { model: 'fast', instructions: 'Use theme.json.' } }
    const settings = effectiveAgentSettings(findAgent('felix', { dir: agentsDir })!)
    expect(settings.model).toBe('fast')
    expect(settings.instructions).toBe('Use theme.json.')
    // Untouched fields keep the definition's value.
    expect(settings.leash).toBe(300)
  })

  it('discards a garbage override rather than breaking the agent', () => {
    settingsOverride = { felix: { model: 'wishful', tools: ['bash'], leash: 'soon' } }
    const settings = effectiveAgentSettings(findAgent('felix', { dir: agentsDir })!)
    expect(settings.model).toBe('high')
    expect(settings.tools).toEqual([])
    expect(settings.leash).toBe(300)
  })
})
