import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openLibraryAsset, revealLibraryAsset } from './library'
import type { LibraryAsset } from '../../shared/library'

function makeAsset(overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id: 'a1', kind: 'document', format: 'markdown', title: 'Doc',
    filename: 'a1.md', mediaType: 'text/markdown', sizeBytes: 100,
    managedPath: '/path/a1.md', createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  }
}

beforeEach(() => {
  ;(window as any).bond = {
    openViewer: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(''),
    revealInFinder: vi.fn().mockResolvedValue(undefined),
  }
})

describe('openLibraryAsset', () => {
  it('opens markdown documents via the in-app viewer', () => {
    const asset = makeAsset({ format: 'markdown', managedPath: '/path/a.md', title: 'Doc' })
    openLibraryAsset(asset)
    expect(window.bond.openViewer).toHaveBeenCalledWith('/path/a.md', 'markdown', 'Doc')
    expect(window.bond.openPath).not.toHaveBeenCalled()
  })

  it('opens plaintext documents via the in-app viewer', () => {
    const asset = makeAsset({ format: 'plaintext', managedPath: '/path/a.txt' })
    openLibraryAsset(asset)
    expect(window.bond.openViewer).toHaveBeenCalledWith('/path/a.txt', 'plaintext', 'Doc')
  })

  it('opens pdf/html/other documents via the native app', () => {
    for (const format of ['pdf', 'html', 'other'] as const) {
      vi.clearAllMocks()
      const asset = makeAsset({ format, managedPath: `/path/a.${format}` })
      openLibraryAsset(asset)
      expect(window.bond.openPath).toHaveBeenCalledWith(`/path/a.${format}`)
      expect(window.bond.openViewer).not.toHaveBeenCalled()
    }
  })

  it('opens media assets via the native app', () => {
    const asset = makeAsset({ kind: 'media', format: 'image', managedPath: '/path/a.png' })
    openLibraryAsset(asset)
    expect(window.bond.openPath).toHaveBeenCalledWith('/path/a.png')
  })
})

describe('revealLibraryAsset', () => {
  it('reveals the managed path in Finder', () => {
    const asset = makeAsset({ managedPath: '/path/a.md' })
    revealLibraryAsset(asset)
    expect(window.bond.revealInFinder).toHaveBeenCalledWith('/path/a.md')
  })
})
