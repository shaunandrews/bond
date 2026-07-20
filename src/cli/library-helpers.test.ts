import { describe, it, expect } from 'vitest'
import { findAsset, formatSize, detectDocFormat, detectDocFormatFromResponse } from './library-helpers'

describe('findAsset', () => {
  const assets = [{ id: 'aaa111' }, { id: 'bbb222' }, { id: 'ccc333' }]

  it('resolves a 1-based numeric index', () => {
    expect(findAsset(assets, '2')).toBe(assets[1])
  })

  it('resolves a case-insensitive id prefix', () => {
    expect(findAsset(assets, 'BBB')).toBe(assets[1])
  })

  it('returns undefined for an out-of-range index', () => {
    expect(findAsset(assets, '99')).toBeUndefined()
  })

  it('returns undefined for no match', () => {
    expect(findAsset(assets, 'zzz')).toBeUndefined()
  })
})

describe('formatSize', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatSize(500)).toBe('500 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('detectDocFormat', () => {
  it('maps known extensions to format/mediaType', () => {
    expect(detectDocFormat('.md')).toEqual({ format: 'markdown', mediaType: 'text/markdown' })
    expect(detectDocFormat('.TXT')).toEqual({ format: 'plaintext', mediaType: 'text/plain' })
    expect(detectDocFormat('.pdf')).toEqual({ format: 'pdf', mediaType: 'application/pdf' })
  })

  it('falls back to other/octet-stream for unknown extensions', () => {
    expect(detectDocFormat('.xyz')).toEqual({ format: 'other', mediaType: 'application/octet-stream' })
  })
})

describe('detectDocFormatFromResponse', () => {
  it('prefers a known content-type header over the url extension', () => {
    expect(detectDocFormatFromResponse('text/markdown', '.txt')).toEqual({ format: 'markdown', mediaType: 'text/markdown' })
  })

  it('falls back to the url extension when content-type is unknown', () => {
    expect(detectDocFormatFromResponse('application/octet-stream', '.pdf')).toEqual({ format: 'pdf', mediaType: 'application/pdf' })
  })

  it('falls back to other when neither resolves', () => {
    expect(detectDocFormatFromResponse(undefined, '.xyz')).toEqual({ format: 'other', mediaType: 'application/octet-stream' })
  })
})
