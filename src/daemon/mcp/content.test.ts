import { describe, expect, it } from 'vitest'
import { MAX_RESULT_CHARS, flattenCallResult, truncate } from './content'

describe('truncate', () => {
  it('leaves text within budget alone', () => {
    expect(truncate('short', 100)).toEqual({ text: 'short', truncated: false })
  })

  it('cuts to the budget and says how much was dropped', () => {
    const result = truncate('x'.repeat(500), 100)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('[truncated — 500 chars total]')
    expect(result.text.slice(0, 100)).toBe('x'.repeat(100))
  })

  it('defaults to the shared 20k budget', () => {
    expect(truncate('x'.repeat(MAX_RESULT_CHARS)).truncated).toBe(false)
    expect(truncate('x'.repeat(MAX_RESULT_CHARS + 1)).truncated).toBe(true)
  })
})

describe('flattenCallResult', () => {
  it('joins text blocks with blank lines', () => {
    const result = flattenCallResult({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })
    expect(result.text).toBe('one\n\ntwo')
    expect(result.isError).toBe(false)
    expect(result.truncated).toBe(false)
  })

  it('replaces image and audio blocks with placeholders', () => {
    const result = flattenCallResult({
      content: [
        { type: 'text', text: 'here it is' },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(50_000) },
        { type: 'audio', mimeType: 'audio/wav', data: 'B'.repeat(50_000) },
      ],
    })
    expect(result.text).toBe('here it is\n\n[image omitted — image/png]\n\n[audio omitted — audio/wav]')
    expect(result.text).not.toContain('AAAA')
  })

  it('inlines text resources and names binary ones', () => {
    const result = flattenCallResult({
      content: [
        { type: 'resource', resource: { uri: 'file:///notes.md', text: 'notes body' } },
        { type: 'resource', resource: { uri: 'file:///logo.png', mimeType: 'image/png', blob: 'AAAA' } },
        { type: 'resource_link', name: 'Design doc', uri: 'https://example.com/doc' },
      ],
    })
    expect(result.text).toContain('<resource uri="file:///notes.md">\nnotes body\n</resource>')
    expect(result.text).toContain('[binary resource omitted: file:///logo.png — image/png]')
    expect(result.text).toContain('[resource link: Design doc — https://example.com/doc]')
  })

  it('flags an error result', () => {
    const result = flattenCallResult({ content: [{ type: 'text', text: 'nope' }], isError: true })
    expect(result.isError).toBe(true)
  })

  it('falls back to structured content when there are no content blocks', () => {
    const result = flattenCallResult({ structuredContent: { count: 2 } })
    expect(result.text).toContain('"count": 2')
    // Already shown as the text — carrying it twice just doubles the payload.
    expect(result.structuredContent).toBeUndefined()
  })

  it('carries structured content alongside text when both are present', () => {
    const result = flattenCallResult({ content: [{ type: 'text', text: 'summary' }], structuredContent: { count: 2 } })
    expect(result.text).toBe('summary')
    expect(result.structuredContent).toEqual({ count: 2 })
  })

  it('says so when the server returns nothing at all', () => {
    expect(flattenCallResult({}).text).toBe('[the server returned no content]')
    expect(flattenCallResult(undefined).text).toBe('[the server returned no content]')
    expect(flattenCallResult({ content: [] }).text).toBe('[the server returned no content]')
  })

  it('keeps unknown block types readable instead of dropping them', () => {
    const result = flattenCallResult({ content: [{ type: 'future_thing', text: 'still readable' }, { type: 'opaque' }] })
    expect(result.text).toContain('still readable')
    expect(result.text).toContain('[unsupported content block: opaque]')
  })

  it('truncates an oversized result', () => {
    const result = flattenCallResult({ content: [{ type: 'text', text: 'y'.repeat(30_000) }] }, 1_000)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThan(1_100)
  })
})
