import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DESIGN_TOOL_NAMES, createDesignExtensionFactory, expandPath, registerDesignTools, type DesignToolOptions } from './tools'

interface RegisteredToolDef {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: any[]; details: any }>
}

function collectTools(options: DesignToolOptions = {}): Map<string, RegisteredToolDef> {
  const tools = new Map<string, RegisteredToolDef>()
  const pi = { registerTool: (def: RegisteredToolDef) => tools.set(def.name, def) }
  registerDesignTools(pi as any, options)
  return tools
}

function fakes(overrides: DesignToolOptions = {}): Required<Pick<DesignToolOptions, 'runFelix' | 'detect' | 'inventory' | 'resolveDocs'>> & DesignToolOptions {
  return {
    runFelix: vi.fn(async () => 'VERDICT: fine.'),
    detect: vi.fn(async () => ({ status: 'ok' as const, findings: [], truncated: false })),
    inventory: vi.fn(() => ({ tokens: [], mapped: [], evidence: '<evidence source="migration-inventory">none</evidence>', scannedFiles: 0 })),
    resolveDocs: vi.fn(() => ({ root: '/p', design: { path: '/p/DESIGN.md', text: 'tokens' } })),
    ...overrides,
  }
}

describe('registerDesignTools', () => {
  it('registers exactly the exported tool names, and the factory matches', () => {
    expect([...collectTools(fakes()).keys()]).toEqual(DESIGN_TOOL_NAMES)
    const names: string[] = []
    createDesignExtensionFactory(fakes())({ registerTool: (def: any) => names.push(def.name) } as any)
    expect(names).toEqual(DESIGN_TOOL_NAMES)
  })
})

describe('expandPath', () => {
  it('expands ~ and resolves relative paths against home', () => {
    expect(expandPath('~/x/y.css')).toBe(join(homedir(), 'x/y.css'))
    expect(expandPath('rel/a.css')).toBe(join(homedir(), 'rel/a.css'))
    expect(expandPath('/abs/a.css')).toBe('/abs/a.css')
  })
})

describe('consult_designer', () => {
  it('rejects unknown verbs and registers with actionable errors', async () => {
    const tool = collectTools(fakes()).get('consult_designer')!
    await expect(tool.execute('c1', { verb: 'roast', brief: 'x' })).rejects.toThrow('critique, define, refine, migrate')
    await expect(tool.execute('c1', { verb: 'critique', brief: 'x', register: 'branding' })).rejects.toThrow('brand')
  })

  it('runs the detector for critique and passes its evidence to Felix', async () => {
    const deps = fakes()
    const tool = collectTools(deps).get('consult_designer')!
    const result = await tool.execute('c1', { verb: 'critique', brief: 'Judge it', paths: ['/p/src'] })

    expect(deps.detect).toHaveBeenCalledWith(['/p/src'], { cwd: '/p' })
    expect(deps.inventory).not.toHaveBeenCalled()
    const felixInput = (deps.runFelix as any).mock.calls[0][0]
    expect(felixInput.verb).toBe('critique')
    expect(felixInput.evidence).toHaveLength(1)
    expect(felixInput.evidence[0]).toContain('impeccable-detector')
    expect(felixInput.docs.design.path).toBe('/p/DESIGN.md')
    expect(result.content[0].text).toBe('VERDICT: fine.')
    expect(result.details.contextDocs.design).toBe('/p/DESIGN.md')
  })

  it('skips the detector for define', async () => {
    const deps = fakes()
    const tool = collectTools(deps).get('consult_designer')!
    await tool.execute('c1', { verb: 'define', brief: 'Write the system', paths: ['/p/src'] })
    expect(deps.detect).not.toHaveBeenCalled()
  })

  it('adds the migration inventory for migrate, fed with the found DESIGN.md', async () => {
    const deps = fakes()
    const tool = collectTools(deps).get('consult_designer')!
    await tool.execute('c1', { verb: 'migrate', brief: 'Adopt the system', paths: ['/p/src'] })

    expect(deps.inventory).toHaveBeenCalledWith(['/p/src'], { designMdText: 'tokens' })
    const felixInput = (deps.runFelix as any).mock.calls[0][0]
    expect(felixInput.evidence).toHaveLength(2)
    expect(felixInput.evidence[1]).toContain('migration-inventory')
  })

  it('consults without paths: no detector, no docs, Felix still runs', async () => {
    const deps = fakes()
    const tool = collectTools(deps).get('consult_designer')!
    await tool.execute('c1', { verb: 'critique', brief: 'General direction advice' })
    expect(deps.detect).not.toHaveBeenCalled()
    expect(deps.resolveDocs).not.toHaveBeenCalled()
    expect((deps.runFelix as any).mock.calls[0][0].evidence).toEqual([])
  })

  it('threads the parent model tier and abort signal through to Felix', async () => {
    const deps = fakes()
    const tool = collectTools({ ...deps, model: 'high' }).get('consult_designer')!
    const controller = new AbortController()
    await tool.execute('c1', { verb: 'critique', brief: 'x' }, controller.signal)
    const felixInput = (deps.runFelix as any).mock.calls[0][0]
    expect(felixInput.model).toBe('high')
    expect(felixInput.signal).toBe(controller.signal)
  })
})
