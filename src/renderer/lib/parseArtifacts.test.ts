import { describe, it, expect } from 'vitest'
import { parseArtifacts, hasArtifacts, hasRichContent } from './parseArtifacts'

describe('parseArtifacts — artifacts', () => {
  it('returns a single text segment for plain text', () => {
    const result = parseArtifacts('Hello world')
    expect(result).toEqual([{ type: 'text', content: 'Hello world' }])
  })

  it('returns empty array for empty string', () => {
    expect(parseArtifacts('')).toEqual([])
  })

  it('parses a single artifact at start of string', () => {
    const input = '<bond-artifact title="Test">Hello</bond-artifact>'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'artifact', title: 'Test', layout: undefined, chrome: undefined, content: 'Hello' },
    ])
  })

  it('parses artifact with all attributes', () => {
    const input = '<bond-artifact title="Grid" layout="wide" chrome="none"><div>content</div></bond-artifact>'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'artifact', title: 'Grid', layout: 'wide', chrome: 'none', content: '<div>content</div>' },
    ])
  })

  it('parses text before and after an artifact', () => {
    const input = 'Before\n\n<bond-artifact title="A">inside</bond-artifact>\n\nAfter'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'text', content: 'Before\n\n' },
      { type: 'artifact', title: 'A', layout: undefined, chrome: undefined, content: 'inside' },
      { type: 'text', content: '\n\nAfter' },
    ])
  })

  it('parses multiple artifacts', () => {
    const input =
      'Intro\n<bond-artifact title="One">first</bond-artifact>' +
      '\nMiddle\n<bond-artifact title="Two" layout="full">second</bond-artifact>\nEnd'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'text', content: 'Intro\n' },
      { type: 'artifact', title: 'One', layout: undefined, chrome: undefined, content: 'first' },
      { type: 'text', content: '\nMiddle\n' },
      { type: 'artifact', title: 'Two', layout: 'full', chrome: undefined, content: 'second' },
      { type: 'text', content: '\nEnd' },
    ])
  })

  it('handles streaming: incomplete opening tag', () => {
    const input = 'Some text\n<bond-artifact title="Tes'
    const result = parseArtifacts(input)
    expect(result.every(s => s.type === 'text')).toBe(true)
  })

  it('handles streaming: open tag complete but no closing tag', () => {
    const input = 'Before\n<bond-artifact title="Streaming"><div>partial'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'text', content: 'Before\n' },
      { type: 'artifact', title: 'Streaming', layout: undefined, chrome: undefined, content: '<div>partial' },
    ])
  })

  it('ignores inline code references', () => {
    const input = 'Use the `<bond-artifact>` tag like this:\n\n<bond-artifact title="Real">content</bond-artifact>'
    const result = parseArtifacts(input)
    expect(result[0]).toEqual({ type: 'text', content: 'Use the `<bond-artifact>` tag like this:\n\n' })
    expect(result[1]).toMatchObject({ type: 'artifact', title: 'Real' })
  })

  it('ignores mid-line artifact tag mentions', () => {
    const input = 'The <bond-artifact> tag renders HTML.\n\n<bond-artifact title="Actual">real</bond-artifact>'
    const result = parseArtifacts(input)
    expect(result[0]).toEqual({ type: 'text', content: 'The <bond-artifact> tag renders HTML.\n\n' })
    expect(result[1]).toMatchObject({ type: 'artifact' })
  })
})

describe('parseArtifacts — embeds', () => {
  it('parses a self-closing embed tag', () => {
    const input = '<bond-embed type="todos" />'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'embed', embedType: 'todos', attrs: {} },
    ])
  })

  it('parses embed with attributes', () => {
    const input = '<bond-embed type="todos" project="Bond" filter="pending" />'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'embed', embedType: 'todos', attrs: { project: 'Bond', filter: 'pending' } },
    ])
  })

  it('parses project embed', () => {
    const input = '<bond-embed type="project" name="Bond" />'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'embed', embedType: 'project', attrs: { name: 'Bond' } },
    ])
  })

  it('parses media embed with limit', () => {
    const input = '<bond-embed type="media" limit="6" />'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'embed', embedType: 'media', attrs: { limit: '6' } },
    ])
  })

  it('parses embed without self-closing slash', () => {
    const input = '<bond-embed type="todos">'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'embed', embedType: 'todos', attrs: {} },
    ])
  })

  it('parses text around embeds', () => {
    const input = 'Here are your todos:\n\n<bond-embed type="todos" project="Bond" />\n\nLet me know!'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'text', content: 'Here are your todos:\n\n' },
      { type: 'embed', embedType: 'todos', attrs: { project: 'Bond' } },
      { type: 'text', content: '\n\nLet me know!' },
    ])
  })

  it('ignores inline embed mentions', () => {
    const input = 'Use <bond-embed type="todos" /> to show todos.\n\n<bond-embed type="todos" />'
    const result = parseArtifacts(input)
    expect(result[0]).toMatchObject({ type: 'text' })
    expect(result[1]).toMatchObject({ type: 'embed', embedType: 'todos' })
  })
})

describe('parseArtifacts — mixed', () => {
  it('parses artifacts and embeds together', () => {
    const input =
      'Summary:\n\n<bond-embed type="project" name="Bond" />\n\n' +
      'And a visual:\n\n<bond-artifact title="Chart" chrome="none"><div>chart</div></bond-artifact>\n\nDone!'
    const result = parseArtifacts(input)
    expect(result).toEqual([
      { type: 'text', content: 'Summary:\n\n' },
      { type: 'embed', embedType: 'project', attrs: { name: 'Bond' } },
      { type: 'text', content: '\n\nAnd a visual:\n\n' },
      { type: 'artifact', title: 'Chart', chrome: 'none', layout: undefined, content: '<div>chart</div>' },
      { type: 'text', content: '\n\nDone!' },
    ])
  })
})

describe('hasRichContent / hasArtifacts', () => {
  it('returns false for plain text', () => {
    expect(hasRichContent('Hello world')).toBe(false)
    expect(hasArtifacts('Hello world')).toBe(false)
  })

  it('returns true for artifacts', () => {
    expect(hasRichContent('text\n<bond-artifact>foo</bond-artifact>')).toBe(true)
  })

  it('returns true for embeds', () => {
    expect(hasRichContent('text\n<bond-embed type="todos" />')).toBe(true)
  })

  it('returns false for inline mentions', () => {
    expect(hasRichContent('Use the <bond-embed> tag')).toBe(false)
    expect(hasRichContent('Use the <bond-artifact> tag')).toBe(false)
  })
})
