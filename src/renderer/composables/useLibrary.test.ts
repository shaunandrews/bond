import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent } from 'vue'
import { useLibrary } from './useLibrary'
import type { LibraryAsset } from '../../shared/library'

function makeAsset(overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id: 'a1', kind: 'document', format: 'markdown', title: 'Test doc',
    filename: 'a1.md', mediaType: 'text/markdown', sizeBytes: 100,
    managedPath: '/path/a1.md', createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  }
}

function mockWindowBond() {
  const mock = {
    libraryList: vi.fn().mockResolvedValue([]),
    libraryDelete: vi.fn().mockResolvedValue({ ok: true }),
  }
  ;(window as any).bond = mock
  return mock
}

type UseLibraryReturn = ReturnType<typeof useLibrary>

function withSetup(): UseLibraryReturn {
  let result!: UseLibraryReturn
  const app = createApp(
    defineComponent({
      setup() {
        result = useLibrary()
        return () => null
      },
    })
  )
  app.mount(document.createElement('div'))
  return result
}

describe('useLibrary', () => {
  let bond: ReturnType<typeof mockWindowBond>
  let lib: UseLibraryReturn

  beforeEach(() => {
    bond = mockWindowBond()
    lib = withSetup()
  })

  it('loads assets from window.bond.libraryList', async () => {
    bond.libraryList.mockResolvedValue([makeAsset()])
    await lib.load()
    expect(lib.assets.value).toHaveLength(1)
    expect(lib.assets.value[0].id).toBe('a1')
  })

  it('passes undefined kind when filter is "all"', async () => {
    lib.kindFilter.value = 'all'
    await lib.load()
    expect(bond.libraryList).toHaveBeenCalledWith(undefined, undefined)
  })

  it('passes the selected kind filter through', async () => {
    lib.kindFilter.value = 'media'
    await lib.load()
    expect(bond.libraryList).toHaveBeenCalledWith('media', undefined)
  })

  it('passes a trimmed, non-empty search query', async () => {
    lib.query.value = '  studio  '
    await lib.load()
    expect(bond.libraryList).toHaveBeenCalledWith(undefined, 'studio')
  })

  it('sets loading true during load and false after', async () => {
    let sawLoading = false
    bond.libraryList.mockImplementation(async () => {
      sawLoading = lib.loading.value
      return []
    })
    await lib.load()
    expect(sawLoading).toBe(true)
    expect(lib.loading.value).toBe(false)
  })

  it('deleteAsset removes the asset from local state on success', async () => {
    bond.libraryList.mockResolvedValue([makeAsset({ id: 'a1' }), makeAsset({ id: 'a2' })])
    await lib.load()

    const ok = await lib.deleteAsset('a1')

    expect(ok).toBe(true)
    expect(lib.assets.value.map(a => a.id)).toEqual(['a2'])
  })

  it('deleteAsset leaves state untouched on failure', async () => {
    bond.libraryDelete.mockResolvedValue({ ok: false })
    bond.libraryList.mockResolvedValue([makeAsset({ id: 'a1' })])
    await lib.load()

    const ok = await lib.deleteAsset('a1')

    expect(ok).toBe(false)
    expect(lib.assets.value).toHaveLength(1)
  })
})
