import { describe, expect, it } from 'vitest'
import { parseAgentDefinition, parseAgentFrontmatter, splitVerbSections } from './definition'
import { BUILTIN_AGENT_SOURCES } from './builtin'

const MINIMAL = `---
name: scout
verbs: [look]
---

Doctrine for the scout.

## verb: look — Look at a thing.
Steps for looking.
`

describe('parseAgentFrontmatter', () => {
  it('parses scalars, inline lists, and one-level maps', () => {
    const frontmatter = parseAgentFrontmatter(`---
name: q
verbs: [review, patch]
evidence:
  tests: npm run test:run
  types: npx tsc
model: high
---
body`)
    expect(frontmatter.name).toBe('q')
    expect(frontmatter.verbs).toEqual(['review', 'patch'])
    expect(frontmatter.evidence).toEqual({ tests: 'npm run test:run', types: 'npx tsc' })
    expect(frontmatter.model).toBe('high')
  })

  it('strips quotes and ignores comments and blank lines', () => {
    const frontmatter = parseAgentFrontmatter(`---
# a comment
label: "Felix"

role: 'Design Consultant'
---`)
    expect(frontmatter.label).toBe('Felix')
    expect(frontmatter.role).toBe('Design Consultant')
  })

  it('returns nothing without frontmatter', () => {
    expect(parseAgentFrontmatter('no frontmatter here')).toEqual({})
  })
})

describe('splitVerbSections', () => {
  it('separates doctrine from verb sections and reads inline descriptions', () => {
    const { doctrine, sections } = splitVerbSections(`Doctrine text.

## verb: critique — Judge a surface.
Critique workflow.

## verb: define
Define workflow.`)
    expect(doctrine).toBe('Doctrine text.')
    expect(sections.get('critique')).toEqual({ description: 'Judge a surface.', workflow: 'Critique workflow.' })
    expect(sections.get('define')).toEqual({ description: '', workflow: 'Define workflow.' })
  })
})

describe('parseAgentDefinition', () => {
  it('parses a minimal valid definition with sensible fallbacks', () => {
    const parsed = parseAgentDefinition(MINIMAL, { source: 'user', sourcePath: '/a/AGENT.md' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition).toMatchObject({
      name: 'scout',
      label: 'Scout',
      mark: 'S',
      source: 'user',
      sourcePath: '/a/AGENT.md',
      doctrine: 'Doctrine for the scout.',
    })
    expect(parsed.definition.verbs).toEqual([{ name: 'look', description: 'Look at a thing.', workflow: 'Steps for looking.' }])
  })

  it('requires a name, verbs, and doctrine', () => {
    const parsed = parseAgentDefinition('---\nlabel: Nameless\n---\n', { source: 'user' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('name is required'),
      expect.stringContaining('at least one verb'),
      expect.stringContaining('doctrine is required'),
    ]))
  })

  it('says so plainly when the frontmatter block is missing entirely', () => {
    const parsed = parseAgentDefinition('Just prose, no config.', { source: 'user' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain('frontmatter is required')
  })

  it('rejects a declared verb with no section, and a section with no declaration', () => {
    const missingSection = parseAgentDefinition(`---
name: a
verbs: [one, two]
---
Doctrine.

## verb: one
Workflow.`, { source: 'user' })
    expect(missingSection.ok).toBe(false)
    if (!missingSection.ok) expect(missingSection.errors[0]).toContain('"two" is declared but has no')

    const undeclared = parseAgentDefinition(`---
name: a
verbs: [one]
---
Doctrine.

## verb: one
W.

## verb: rogue
W.`, { source: 'user' })
    expect(undeclared.ok).toBe(false)
    if (!undeclared.ok) expect(undeclared.errors[0]).toContain('not listed in the verbs frontmatter')
  })

  it('parses evidence runners with verb scoping and kind detection', () => {
    const parsed = parseAgentDefinition(`---
name: a
verbs: [one, two]
evidence:
  tests: npm run test:run [one]
  native: builtin:impeccable-detect
---
Doctrine.

## verb: one
W.

## verb: two
W.`, { source: 'builtin' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition.evidence).toEqual([
      { name: 'tests', command: 'npm run test:run', kind: 'shell', verbs: ['one'] },
      { name: 'native', command: 'builtin:impeccable-detect', kind: 'native', verbs: [] },
    ])
  })

  it('rejects an evidence scope naming an undeclared verb', () => {
    const parsed = parseAgentDefinition(`---
name: a
verbs: [one]
evidence:
  tests: npm test [nope]
---
Doctrine.

## verb: one
W.`, { source: 'user' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain('not a declared verb')
  })

  it('reserves builtin: runners for bundled agents', () => {
    const source = `---
name: a
verbs: [one]
evidence:
  sneaky: builtin:impeccable-detect
---
Doctrine.

## verb: one
W.`
    expect(parseAgentDefinition(source, { source: 'user' }).ok).toBe(false)
    expect(parseAgentDefinition(source, { source: 'builtin' }).ok).toBe(true)
  })

  it('rejects write-capable tool grants — agents are read-only', () => {
    const parsed = parseAgentDefinition(`---
name: a
verbs: [one]
tools: [write, bash]
---
Doctrine.

## verb: one
W.`, { source: 'user' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain('agents are read-only')
  })

  it('rejects invalid enum values and clamps the leash', () => {
    const badEnum = parseAgentDefinition(`---
name: a
verbs: [one]
policy: whenever
---
Doctrine.

## verb: one
W.`, { source: 'user' })
    expect(badEnum.ok).toBe(false)

    const clamped = parseAgentDefinition(`---
name: a
verbs: [one]
leash: 99999
---
Doctrine.

## verb: one
W.`, { source: 'user' })
    expect(clamped.ok).toBe(true)
    if (clamped.ok) expect(clamped.definition.defaults.leash).toBe(900)
  })

  it('keeps read-only as the default and parses an explicit write workspace', () => {
    const readOnly = parseAgentDefinition(MINIMAL, { source: 'user' })
    expect(readOnly.ok && readOnly.definition.defaults.workspace).toBe('read-only')
    const writable = parseAgentDefinition(MINIMAL.replace('verbs: [look]', 'verbs: [look]\nworkspace: write'), { source: 'user' })
    expect(writable.ok && writable.definition.defaults.workspace).toBe('write')
  })
})

describe('bundled definitions', () => {
  it('every bundled agent parses cleanly through the same parser as user files', () => {
    for (const source of BUILTIN_AGENT_SOURCES) {
      const parsed = parseAgentDefinition(source, { source: 'builtin' })
      expect(parsed.ok ? [] : parsed.errors).toEqual([])
    }
  })

  it('ships Felix and Q with their expected verbs', () => {
    const parsed = BUILTIN_AGENT_SOURCES.map(source => parseAgentDefinition(source, { source: 'builtin' }))
      .flatMap(result => (result.ok ? [result.definition] : []))
    const felix = parsed.find(definition => definition.name === 'felix')!
    const q = parsed.find(definition => definition.name === 'q')!
    expect(felix.verbs.map(verb => verb.name)).toEqual(['critique', 'define', 'refine', 'migrate'])
    expect(q.verbs.map(verb => verb.name)).toEqual(['review', 'plan', 'patch', 'debug'])
    expect(felix.evidence.map(runner => runner.name)).toEqual(['detector', 'inventory'])
    expect(q.evidence.every(runner => runner.kind === 'shell')).toBe(true)
  })

  it('only Mathis opts into worktree writes', () => {
    const settings = BUILTIN_AGENT_SOURCES.map(source => {
      const parsed = parseAgentDefinition(source, { source: 'builtin' })
      if (!parsed.ok) throw new Error(parsed.errors.join('; '))
      return [parsed.definition.name, parsed.definition.defaults.workspace]
    })
    expect(settings).toEqual([
      ['felix', 'read-only'],
      ['mathis', 'write'],
      ['q', 'read-only'],
    ])
  })
})
