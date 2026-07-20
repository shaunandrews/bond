import { describe, expect, it } from 'vitest'
import { firstSentence, parseToolDescription } from './toolCatalog'

/** The real context-a8c description, abbreviated but structurally identical. */
const CONTEXT_A8C = `Load a provider to fetch work-related information at Automattic via tools. Available providers:

- slack: Fetch Slack information (messages, DMs, channels, threads, users). Use when fetching Slack URLs, searching messages or conversations.

- linear: Fetch, create, and update Linear information (issues, projects, teams, assignments). Use when querying, creating, or updating Linear issues.

- mgs: (Matt's Global Search) will search WordPress.com internal educational sites and knowledge bases (Fieldguide, universities, P2s, etc.).
  This is the best and preferred tool for searching posts and P2s across Automattic.`

describe('parseToolDescription', () => {
  it('splits a provider catalog into a lead sentence and entries', () => {
    const parsed = parseToolDescription(CONTEXT_A8C)

    expect(parsed.summary).toBe('Load a provider to fetch work-related information at Automattic via tools. Available providers')
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['slack', 'linear', 'mgs'])
  })

  it('keeps each entry\'s full text and a one-sentence summary', () => {
    const linear = parseToolDescription(CONTEXT_A8C).entries[1]

    expect(linear.description).toContain('Use when querying, creating, or updating Linear issues.')
    expect(linear.summary).toBe('Fetch, create, and update Linear information (issues, projects, teams, assignments).')
  })

  it('folds a wrapped entry back into one entry', () => {
    const mgs = parseToolDescription(CONTEXT_A8C).entries[2]

    expect(mgs.description).toContain('This is the best and preferred tool')
    expect(parseToolDescription(CONTEXT_A8C).entries).toHaveLength(3)
  })

  it('leaves an ordinary description alone', () => {
    const parsed = parseToolDescription('Returns the sum of two numbers')

    expect(parsed.entries).toEqual([])
    expect(parsed.summary).toBe('Returns the sum of two numbers')
  })

  // One stray bullet is a note, not a catalog — restructuring on it would
  // make ordinary tools render as if they proxied something.
  it('does not treat a single bullet as a catalog', () => {
    const parsed = parseToolDescription('Does a thing.\n- note: it can be slow')

    expect(parsed.entries).toEqual([])
    expect(parsed.summary).toContain('- note: it can be slow')
  })

  it('handles an empty or missing description', () => {
    expect(parseToolDescription(undefined)).toEqual({ summary: '', entries: [] })
    expect(parseToolDescription('   ')).toEqual({ summary: '', entries: [] })
  })

  it('accepts asterisk and bullet markers too', () => {
    expect(parseToolDescription('Tools:\n* a: first\n* b: second').entries.map((e) => e.name)).toEqual(['a', 'b'])
    expect(parseToolDescription('Tools:\n• a: first\n• b: second').entries.map((e) => e.name)).toEqual(['a', 'b'])
  })

  it('ignores a bullet that is not a name: value pair', () => {
    const parsed = parseToolDescription('Notes:\n- just a bullet\n- another one')
    expect(parsed.entries).toEqual([])
  })

  it('keeps hyphenated provider names intact', () => {
    expect(parseToolDescription('P:\n- github-a8c: internal\n- a4a: agencies').entries.map((e) => e.name))
      .toEqual(['github-a8c', 'a4a'])
  })
})

describe('firstSentence', () => {
  it('stops at the first sentence break', () => {
    expect(firstSentence('One thing. Two thing.')).toBe('One thing.')
    expect(firstSentence('A question? Then more.')).toBe('A question?')
  })

  it('collapses newlines so a wrapped sentence reads as one line', () => {
    expect(firstSentence('One thing\nspanning lines. Next.')).toBe('One thing spanning lines.')
  })

  it('returns the whole text when there is no sentence break', () => {
    expect(firstSentence('no punctuation here')).toBe('no punctuation here')
  })

  it('caps a runaway sentence', () => {
    expect(firstSentence(`${'x'.repeat(400)}.`, 50)).toHaveLength(51)
  })
})
