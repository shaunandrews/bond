import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from '../../shared/agents'
import { buildAgentSystemPrompt, buildAgentUserPrompt, buildReportContract } from './prompt'
import type { AgentDefinition, AgentVerbDefinition } from './definition'

const verb: AgentVerbDefinition = { name: 'critique', description: 'Judge a surface.', workflow: 'Step one. Step two.' }

const definition: AgentDefinition = {
  name: 'felix',
  label: 'Felix',
  role: 'Design Consultant',
  mark: 'F',
  bio: 'bio',
  source: 'builtin',
  sourcePath: null,
  doctrine: 'THE SYSTEM IS THE BOUNDARY.',
  verbs: [verb],
  evidence: [],
  contextDocs: ['DESIGN.md'],
  defaults: DEFAULT_AGENT_SETTINGS,
}

const settings = (overrides: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT_SETTINGS, ...overrides })

describe('buildAgentSystemPrompt', () => {
  it('combines the spine, doctrine, invoked verb, and report contract', () => {
    const prompt = buildAgentSystemPrompt(definition, verb, settings())
    expect(prompt).toContain('You are a specialist consultant')
    expect(prompt).toContain('READ-ONLY')
    expect(prompt).toContain('THE SYSTEM IS THE BOUNDARY')
    expect(prompt).toContain('the "critique" verb: Judge a surface.')
    expect(prompt).toContain('Step one. Step two.')
    expect(prompt).toContain('VERDICT')
  })

  it('includes only the invoked verb\'s workflow', () => {
    const other: AgentVerbDefinition = { name: 'migrate', description: '', workflow: 'MIGRATE ONLY WORKFLOW' }
    const prompt = buildAgentSystemPrompt({ ...definition, verbs: [verb, other] }, verb, settings())
    expect(prompt).not.toContain('MIGRATE ONLY WORKFLOW')
  })

  it('appends user instructions with a guard against overriding the spine', () => {
    const prompt = buildAgentSystemPrompt(definition, verb, settings({ instructions: 'We use theme.json.' }))
    expect(prompt).toContain('We use theme.json.')
    expect(prompt).toContain('never grant write access')
  })

  it('omits the instructions block when empty', () => {
    expect(buildAgentSystemPrompt(definition, verb, settings({ instructions: '   ' }))).not.toContain('USER INSTRUCTIONS')
  })

  it('swaps in the quick report contract', () => {
    const prompt = buildAgentSystemPrompt(definition, verb, settings({ report: 'quick' }))
    expect(prompt).toContain('at most the three most important')
    expect(prompt).not.toContain('EXCEPTIONS:')
  })
})

describe('buildReportContract', () => {
  it('always leads with VERDICT and keeps escalations in the full form', () => {
    expect(buildReportContract('full')).toContain('ESCALATIONS')
    expect(buildReportContract('full').indexOf('VERDICT')).toBeLessThan(buildReportContract('full').indexOf('FINDINGS'))
    expect(buildReportContract('quick')).toContain('Depth is capped, not rigor')
  })
})

describe('buildAgentUserPrompt', () => {
  it('leads with the brief and lists scope paths', () => {
    const prompt = buildAgentUserPrompt({ brief: 'Review settings', paths: ['/a/View.vue'] })
    expect(prompt.startsWith('BRIEF:\nReview settings')).toBe(true)
    expect(prompt).toContain('- /a/View.vue')
  })

  it('states when no paths were given', () => {
    expect(buildAgentUserPrompt({ brief: 'x' })).toContain('no paths were provided')
  })

  it('embeds each found context doc by name and path', () => {
    const prompt = buildAgentUserPrompt({
      brief: 'x',
      docs: { root: '/p', docs: { 'DESIGN.md': { path: '/p/DESIGN.md', text: 'tokens' } } },
    })
    expect(prompt).toContain('<context-doc name="DESIGN.md" path="/p/DESIGN.md">')
    expect(prompt).toContain('tokens')
  })

  it('says so when no context docs were found', () => {
    expect(buildAgentUserPrompt({ brief: 'x', docs: { docs: {} } })).toContain('none found for this scope')
  })

  it('places evidence last with the reconcile-after-your-own-pass instruction', () => {
    const prompt = buildAgentUserPrompt({
      brief: 'x',
      docs: { root: '/p', docs: { 'DESIGN.md': { path: '/p/DESIGN.md', text: 'tokens' } } },
      evidence: ['<evidence source="tests">ok</evidence>'],
    })
    expect(prompt.indexOf('EVIDENCE')).toBeGreaterThan(prompt.indexOf('<context-doc'))
    expect(prompt).toContain('form your own assessment first')
  })

  it('clamps oversized docs', () => {
    const prompt = buildAgentUserPrompt({
      brief: 'x',
      docs: { docs: { 'BIG.md': { path: '/p/BIG.md', text: 'y'.repeat(60_000) } } },
    })
    expect(prompt).toContain('[truncated — 60000 chars total]')
    expect(prompt.length).toBeLessThan(40_000)
  })
})
