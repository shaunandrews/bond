import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/agents'

vi.mock('./registry', () => ({
  loadAgentRoster: vi.fn(() => ({ agents: [definition], problems: [] })),
  effectiveAgentSettings: vi.fn(() => DEFAULT_AGENT_SETTINGS),
}))

import { AGENT_TOOL_NAMES, buildAgentRosterPrompt, createAgentExtensionFactory, expandPath, registerAgentTools, type AgentToolOptions } from './tools'
import type { AgentDefinition } from './definition'

const definition: AgentDefinition = {
  name: 'felix',
  label: 'Felix',
  role: 'Design Consultant',
  mark: 'F',
  bio: 'bio',
  source: 'builtin',
  sourcePath: null,
  doctrine: 'Doctrine.',
  verbs: [
    { name: 'critique', description: 'Judge a surface.', workflow: 'W.' },
    { name: 'migrate', description: 'Map literals to tokens.', workflow: 'W.' },
  ],
  evidence: [{ name: 'detector', command: 'builtin:impeccable-detect', kind: 'native', verbs: ['critique'] }],
  contextDocs: ['DESIGN.md'],
  defaults: DEFAULT_AGENT_SETTINGS,
}

interface RegisteredToolDef {
  name: string
  execute: (toolCallId: string, params: Record<string, any>, signal?: AbortSignal) => Promise<{ content: any[]; details: any }>
}

function fakes(overrides: AgentToolOptions = {}): AgentToolOptions {
  return {
    runConsult: vi.fn(async () => 'VERDICT: fine.'),
    gatherEvidence: vi.fn(async () => ['<evidence source="detector">clean</evidence>']),
    resolveDocs: vi.fn(() => ({ root: '/p', docs: { 'DESIGN.md': { path: '/p/DESIGN.md', text: 'tokens' } } })),
    ...overrides,
  }
}

function collectTools(options: AgentToolOptions = {}): Map<string, RegisteredToolDef> {
  const tools = new Map<string, RegisteredToolDef>()
  registerAgentTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, options)
  return tools
}

describe('registerAgentTools', () => {
  it('registers exactly the exported tool names, and the factory matches', () => {
    expect([...collectTools(fakes()).keys()]).toEqual(AGENT_TOOL_NAMES)
    const names: string[] = []
    createAgentExtensionFactory(fakes())({ registerTool: (def: any) => names.push(def.name) } as any)
    expect(names).toEqual(AGENT_TOOL_NAMES)
  })
})

describe('expandPath', () => {
  it('expands ~ and resolves relative paths against home', () => {
    expect(expandPath('~/x/y.css')).toBe(join(homedir(), 'x/y.css'))
    expect(expandPath('/abs/a.css')).toBe('/abs/a.css')
  })
})

describe('consult_agent', () => {
  it('rejects unknown agents and verbs with the available options named', async () => {
    const tool = collectTools(fakes()).get('consult_agent')!
    await expect(tool.execute('c1', { agent: 'nobody', verb: 'critique', brief: 'x' })).rejects.toThrow('felix')
    await expect(tool.execute('c1', { agent: 'felix', verb: 'roast', brief: 'x' })).rejects.toThrow('critique, migrate')
  })

  it('resolves the agent\'s declared context docs and passes evidence to the consult', async () => {
    const deps = fakes()
    const tool = collectTools(deps).get('consult_agent')!
    const result = await tool.execute('c1', { agent: 'felix', verb: 'critique', brief: 'Judge it', paths: ['/p/src'] })

    expect(deps.resolveDocs).toHaveBeenCalledWith(['/p/src'], ['DESIGN.md'])
    expect(deps.gatherEvidence).toHaveBeenCalledWith(expect.objectContaining({ verb: 'critique', paths: ['/p/src'] }))
    const consultInput = (deps.runConsult as any).mock.calls[0][0]
    expect(consultInput.definition.name).toBe('felix')
    expect(consultInput.verb.name).toBe('critique')
    expect(consultInput.evidence).toHaveLength(1)
    expect(result.content[0].text).toBe('VERDICT: fine.')
    expect(result.details).toMatchObject({ agent: 'felix', verb: 'critique', evidenceRun: 1 })
  })

  it('skips docs and evidence entirely when no paths are in scope', async () => {
    const deps = fakes()
    const tool = collectTools(deps).get('consult_agent')!
    await tool.execute('c1', { agent: 'felix', verb: 'critique', brief: 'General advice' })
    expect(deps.resolveDocs).not.toHaveBeenCalled()
    expect(deps.gatherEvidence).not.toHaveBeenCalled()
    expect((deps.runConsult as any).mock.calls[0][0].evidence).toEqual([])
  })

  it('threads the parent tier, turn approval transport, and abort signal through', async () => {
    const onChunk = vi.fn()
    const deps = fakes({ model: 'high', turnId: 'turn-1', onChunk })
    const tool = collectTools(deps).get('consult_agent')!
    const controller = new AbortController()
    await tool.execute('c1', { agent: 'felix', verb: 'critique', brief: 'x', paths: ['/p'] }, controller.signal)

    expect((deps.gatherEvidence as any).mock.calls[0][0]).toMatchObject({ turnId: 'turn-1', onChunk, signal: controller.signal })
    expect((deps.runConsult as any).mock.calls[0][0]).toMatchObject({ parentModel: 'high', signal: controller.signal })
  })
})

describe('async agent tools', () => {
  it('dispatches immediately and reports idempotent duplicates', async () => {
    const run = { id: 'run-1', agentLabel: 'Felix', status: 'queued' }
    const dispatchRun = vi.fn()
      .mockResolvedValueOnce({ run, created: true })
      .mockResolvedValueOnce({ run, created: false })
    const tool = collectTools(fakes({ dispatchRun: dispatchRun as any })).get('dispatch_agent')!
    const params = { agent: 'felix', verb: 'critique', brief: 'Read it', paths: ['/p'], idempotencyKey: 'same-key' }

    expect((await tool.execute('c1', params)).content[0].text).toContain('Queued')
    expect((await tool.execute('c2', params)).content[0].text).toContain('already dispatched')
    expect(dispatchRun).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'same-key' }))
  })

  it('checks durable status and rejects an unknown run', async () => {
    const detail = { run: { id: 'run-1', agentLabel: 'Felix', verb: 'critique', status: 'succeeded', result: 'report', errorMessage: null }, events: [] }
    const checkRun = vi.fn((id: string) => id === 'run-1' ? detail : null)
    const tool = collectTools(fakes({ checkRun: checkRun as any })).get('check_agent')!

    expect((await tool.execute('c1', { runId: 'run-1' })).content[0].text).toContain('succeeded')
    await expect(tool.execute('c2', { runId: 'missing' })).rejects.toThrow('Unknown agent run')
  })
})

describe('buildAgentRosterPrompt', () => {
  it('lists each agent with role, verbs, and policy guidance', () => {
    const prompt = buildAgentRosterPrompt(() => ({ agents: [definition], problems: [] }))
    expect(prompt).toContain('SPECIALIST AGENTS')
    expect(prompt).toContain('Felix (felix) — Design Consultant')
    expect(prompt).toContain('critique (Judge a surface.)')
    expect(prompt).toContain('Offer to consult them')
  })

  it('is empty when the roster is empty', () => {
    expect(buildAgentRosterPrompt(() => ({ agents: [], problems: [] }))).toBe('')
  })
})
