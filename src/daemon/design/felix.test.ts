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

import { DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { selectModel } from '../pi/model'
import { FELIX_SESSION_TOOLS, runFelixQuery } from './felix'

function makeSession(overrides: Partial<any> = {}) {
  return {
    prompt: vi.fn(async () => {}),
    abort: vi.fn(),
    dispose: vi.fn(),
    agent: { state: { errorMessage: undefined } },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'ignored' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'VERDICT: solid.' }, { type: 'text', text: ' NEXT: none.' }] },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  created.length = 0
  fakeSession = makeSession()
  vi.clearAllMocks()
})

describe('runFelixQuery', () => {
  it('creates an isolated read-only session and returns the assistant text', async () => {
    const report = await runFelixQuery({ verb: 'critique', brief: 'Judge the settings screen' })
    expect(report).toBe('VERDICT: solid. NEXT: none.')

    expect(created).toHaveLength(1)
    expect(created[0].tools).toEqual(FELIX_SESSION_TOOLS)
    expect(created[0].sessionManager).toBe('in-memory-session')
    expect(SessionManager.inMemory).toHaveBeenCalled()
    expect(SettingsManager.inMemory).toHaveBeenCalledWith({ transport: 'sse' })
    expect(fakeSession.dispose).toHaveBeenCalled()
  })

  it('gives the session Felix\'s system prompt for the verb and register', async () => {
    await runFelixQuery({ verb: 'migrate', register: 'product', brief: 'x' })
    const loaderOptions = (DefaultResourceLoader as any).mock.calls[0][0]
    const systemPrompt = loaderOptions.systemPromptOverride()
    expect(systemPrompt).toContain('VERB: MIGRATE')
    expect(systemPrompt).toContain('REGISTER: PRODUCT')
    expect(loaderOptions.noSkills).toBe(true)
  })

  it('sends the assembled user prompt with brief, scope, and evidence', async () => {
    await runFelixQuery({ verb: 'critique', brief: 'Judge this', paths: ['/p/a.css'], evidence: ['<evidence source="x">e</evidence>'] })
    const sent = fakeSession.prompt.mock.calls[0][0]
    expect(sent).toContain('BRIEF:\nJudge this')
    expect(sent).toContain('- /p/a.css')
    expect(sent).toContain('MACHINE EVIDENCE')
  })

  it('inherits the parent model tier through selectModel', async () => {
    await runFelixQuery({ verb: 'critique', brief: 'x', model: 'high' })
    expect(selectModel).toHaveBeenCalledWith('high')
  })

  it('aborts the session when the parent signal fires', async () => {
    const controller = new AbortController()
    fakeSession = makeSession({
      prompt: vi.fn(async () => {
        controller.abort()
      }),
    })
    await expect(runFelixQuery({ verb: 'critique', brief: 'x', signal: controller.signal })).rejects.toThrow('cancelled')
    expect(fakeSession.abort).toHaveBeenCalled()
    expect(fakeSession.dispose).toHaveBeenCalled()
  })

  it('surfaces agent error state as a failure', async () => {
    fakeSession = makeSession({ agent: { state: { errorMessage: 'model exploded' } } })
    await expect(runFelixQuery({ verb: 'critique', brief: 'x' })).rejects.toThrow('model exploded')
  })

  it('rejects an empty report instead of returning silence', async () => {
    fakeSession = makeSession({ messages: [] })
    await expect(runFelixQuery({ verb: 'critique', brief: 'x' })).rejects.toThrow('empty report')
  })
})
