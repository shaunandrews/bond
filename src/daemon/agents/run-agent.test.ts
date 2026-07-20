import { beforeEach, describe, expect, it, vi } from 'vitest'

const created: any[] = []
let fakeSession: any

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn(async (options: any) => {
    created.push(options)
    return { session: fakeSession }
  }),
  DefaultResourceLoader: vi.fn().mockImplementation(function (this: any, options: any) {
    this.options = options
    this.reload = vi.fn(async () => {})
  }),
  SessionManager: { inMemory: vi.fn(() => 'in-memory-session') },
  SettingsManager: { inMemory: vi.fn((settings: any) => ({ inMemory: settings })) },
  getAgentDir: vi.fn(() => '/agent-dir'),
}))

vi.mock('../pi/model', () => ({
  selectModel: vi.fn(async () => ({ model: { provider: 'anthropic', id: 'claude-test' }, modelRuntime: 'runtime' })),
}))

import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent'
import { selectModel } from '../pi/model'
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from '../../shared/agents'
import { AGENT_BASE_TOOLS, runAgentConsult, thinkingLevelFor, toolsForAgent } from './run-agent'
import type { AgentDefinition, AgentVerbDefinition } from './definition'

const verb: AgentVerbDefinition = { name: 'critique', description: '', workflow: 'Workflow.' }

const definition: AgentDefinition = {
  name: 'felix',
  label: 'Felix',
  role: 'Design Consultant',
  mark: 'F',
  bio: '',
  source: 'builtin',
  sourcePath: null,
  doctrine: 'Doctrine.',
  verbs: [verb],
  evidence: [],
  contextDocs: [],
  defaults: DEFAULT_AGENT_SETTINGS,
}

const settings = (overrides: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT_SETTINGS, ...overrides })

function makeSession(overrides: Partial<any> = {}) {
  return {
    prompt: vi.fn(async () => {}),
    abort: vi.fn(),
    dispose: vi.fn(),
    agent: { state: { errorMessage: undefined } },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'ignored' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'VERDICT: fine.' }] },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  created.length = 0
  fakeSession = makeSession()
  vi.clearAllMocks()
})

describe('toolsForAgent', () => {
  it('gives the read-only base by default', () => {
    expect(toolsForAgent(settings())).toEqual(AGENT_BASE_TOOLS)
    expect(AGENT_BASE_TOOLS).not.toContain('write')
    expect(AGENT_BASE_TOOLS).not.toContain('bash')
  })

  it('adds granted web tools and ignores anything else', () => {
    expect(toolsForAgent(settings({ tools: ['web_search'] }))).toEqual([...AGENT_BASE_TOOLS, 'web_search'])
    expect(toolsForAgent(settings({ tools: ['bash' as never] }))).toEqual(AGENT_BASE_TOOLS)
  })
})

describe('thinkingLevelFor', () => {
  it('maps default to undefined and passes the rest through', () => {
    expect(thinkingLevelFor('default')).toBeUndefined()
    expect(thinkingLevelFor('max')).toBe('max')
  })
})

describe('runAgentConsult', () => {
  it('creates an isolated read-only session and returns the report', async () => {
    const report = await runAgentConsult({ definition, verb, settings: settings(), brief: 'Judge it' })
    expect(report).toBe('VERDICT: fine.')
    expect(created[0].tools).toEqual(AGENT_BASE_TOOLS)
    expect(created[0].sessionManager).toBe('in-memory-session')
    expect(SettingsManager.inMemory).toHaveBeenCalledWith({ transport: 'sse' })
    expect(fakeSession.dispose).toHaveBeenCalled()
  })

  it('builds the system prompt from the definition and invoked verb', async () => {
    await runAgentConsult({ definition, verb, settings: settings(), brief: 'x' })
    const prompt = (DefaultResourceLoader as any).mock.calls[0][0].systemPromptOverride()
    expect(prompt).toContain('Doctrine.')
    expect(prompt).toContain('the "critique" verb')
  })

  it('passes the thinking level only when it is not default', async () => {
    await runAgentConsult({ definition, verb, settings: settings({ thinking: 'high' }), brief: 'x' })
    expect(created[0].thinkingLevel).toBe('high')

    created.length = 0
    await runAgentConsult({ definition, verb, settings: settings(), brief: 'x' })
    expect(created[0].thinkingLevel).toBeUndefined()
  })

  it('uses the agent tier when set and the parent tier when inheriting', async () => {
    await runAgentConsult({ definition, verb, settings: settings({ model: 'high' }), brief: 'x', parentModel: 'fast' })
    expect(selectModel).toHaveBeenLastCalledWith('high')

    await runAgentConsult({ definition, verb, settings: settings({ model: 'inherit' }), brief: 'x', parentModel: 'fast' })
    expect(selectModel).toHaveBeenLastCalledWith('fast')
  })

  it('registers the web extension only when tools are granted', async () => {
    await runAgentConsult({ definition, verb, settings: settings(), brief: 'x' })
    expect((DefaultResourceLoader as any).mock.calls[0][0].extensionFactories).toEqual([])

    await runAgentConsult({ definition, verb, settings: settings({ tools: ['web_search'] }), brief: 'x' })
    expect((DefaultResourceLoader as any).mock.calls[1][0].extensionFactories).toHaveLength(1)
  })

  it('aborts when the parent signal fires', async () => {
    const controller = new AbortController()
    fakeSession = makeSession({ prompt: vi.fn(async () => void controller.abort()) })
    await expect(runAgentConsult({ definition, verb, settings: settings(), brief: 'x', signal: controller.signal }))
      .rejects.toThrow('cancelled')
    expect(fakeSession.abort).toHaveBeenCalled()
  })

  it('stops at the leash and names the setting to change', async () => {
    vi.useFakeTimers()
    try {
      fakeSession = makeSession({
        prompt: vi.fn(async () => {
          await vi.advanceTimersByTimeAsync(31_000)
        }),
      })
      await expect(runAgentConsult({ definition, verb, settings: settings({ leash: 30 }), brief: 'x' }))
        .rejects.toThrow('leash')
      expect(fakeSession.abort).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces agent error state and empty reports as failures', async () => {
    fakeSession = makeSession({ agent: { state: { errorMessage: 'model exploded' } } })
    await expect(runAgentConsult({ definition, verb, settings: settings(), brief: 'x' })).rejects.toThrow('model exploded')

    fakeSession = makeSession({ messages: [] })
    await expect(runAgentConsult({ definition, verb, settings: settings(), brief: 'x' })).rejects.toThrow('empty report')
  })
})
