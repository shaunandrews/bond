import { describe, expect, it } from 'vitest'
import { buildFelixSystemPrompt, buildFelixUserPrompt } from './prompt'

describe('buildFelixSystemPrompt', () => {
  it('includes identity, core doctrine, verb doctrine, report format, and attribution', () => {
    const prompt = buildFelixSystemPrompt('critique')
    expect(prompt).toContain('You are Felix')
    expect(prompt).toContain('THE SYSTEM IS THE BOUNDARY')
    expect(prompt).toContain('VERB: CRITIQUE')
    expect(prompt).toContain('REPORT FORMAT')
    expect(prompt).toContain('github.com/pbakaus/impeccable')
  })

  it('includes both registers plus an inference instruction when register is unspecified', () => {
    const prompt = buildFelixSystemPrompt('critique')
    expect(prompt).toContain('REGISTER: BRAND')
    expect(prompt).toContain('REGISTER: PRODUCT')
    expect(prompt).toContain('register was not specified')
  })

  it('includes only the named register when specified', () => {
    const prompt = buildFelixSystemPrompt('critique', 'product')
    expect(prompt).toContain('REGISTER: PRODUCT')
    expect(prompt).not.toContain('REGISTER: BRAND')
    expect(prompt).not.toContain('register was not specified')
  })

  it('gives authoring verbs the DESIGN.md format contract but not critique', () => {
    expect(buildFelixSystemPrompt('critique')).not.toContain('DESIGN.MD FORMAT CONTRACT')
    expect(buildFelixSystemPrompt('define')).toContain('DESIGN.MD FORMAT CONTRACT')
    expect(buildFelixSystemPrompt('refine')).toContain('DESIGN.MD FORMAT CONTRACT')
    expect(buildFelixSystemPrompt('migrate')).toContain('DESIGN.MD FORMAT CONTRACT')
  })
})

describe('buildFelixUserPrompt', () => {
  it('leads with the brief and lists scope paths', () => {
    const prompt = buildFelixUserPrompt({ brief: 'Review the settings screen', paths: ['/a/SettingsView.vue', '/a/app.css'] })
    expect(prompt.startsWith('BRIEF:\nReview the settings screen')).toBe(true)
    expect(prompt).toContain('- /a/SettingsView.vue')
    expect(prompt).toContain('- /a/app.css')
  })

  it('states when no paths were provided', () => {
    const prompt = buildFelixUserPrompt({ brief: 'General advice' })
    expect(prompt).toContain('no paths were provided')
  })

  it('embeds context docs with their paths, and says when none were found', () => {
    const withDocs = buildFelixUserPrompt({
      brief: 'x',
      docs: { root: '/p', product: { path: '/p/PRODUCT.md', text: 'strategy' }, design: { path: '/p/DESIGN.md', text: 'tokens' } },
    })
    expect(withDocs).toContain('<product-md path="/p/PRODUCT.md">')
    expect(withDocs).toContain('strategy')
    expect(withDocs).toContain('<design-md path="/p/DESIGN.md">')

    const withoutDocs = buildFelixUserPrompt({ brief: 'x' })
    expect(withoutDocs).toContain('no PRODUCT.md or DESIGN.md found')
  })

  it('places machine evidence last with the reconcile-after-your-own-pass instruction', () => {
    const prompt = buildFelixUserPrompt({
      brief: 'x',
      docs: { design: { path: '/p/DESIGN.md', text: 'tokens' } },
      evidence: ['<evidence source="impeccable-detector">stuff</evidence>'],
    })
    expect(prompt.indexOf('MACHINE EVIDENCE')).toBeGreaterThan(prompt.indexOf('<design-md'))
    expect(prompt).toContain('own assessment from the code first')
    expect(prompt.trimEnd().endsWith('</evidence>')).toBe(true)
  })

  it('clamps oversized docs instead of flooding the prompt', () => {
    const prompt = buildFelixUserPrompt({
      brief: 'x',
      docs: { design: { path: '/p/DESIGN.md', text: 'y'.repeat(60_000) } },
    })
    expect(prompt.length).toBeLessThan(40_000)
    expect(prompt).toContain('[truncated — 60000 chars total]')
  })
})
