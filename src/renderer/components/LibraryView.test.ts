import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LibraryView from './LibraryView.vue'
import type { LibraryAsset } from '../../shared/library'

function makeAsset(overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id: 'a1', kind: 'document', format: 'markdown', title: 'Studio catch-up',
    filename: 'a1.md', mediaType: 'text/markdown', sizeBytes: 100, previewText: 'Hello world',
    managedPath: '/path/a1.md', createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  }
}

function mockWindowBond(assets: LibraryAsset[] = []) {
  const mock = {
    libraryList: vi.fn().mockResolvedValue(assets),
    libraryDelete: vi.fn().mockResolvedValue({ ok: true }),
    onLibraryChanged: vi.fn().mockReturnValue(() => {}),
    getImages: vi.fn().mockResolvedValue([]),
    importImage: vi.fn().mockResolvedValue({ id: 'img1' }),
    libraryAddDocument: vi.fn().mockResolvedValue(makeAsset()),
    openViewer: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(''),
    revealInFinder: vi.fn().mockResolvedValue(undefined),
    libraryListBacklinksForAsset: vi.fn().mockResolvedValue([]),
  }
  ;(window as any).bond = mock
  return mock
}

function mountLibraryView() {
  return mount(LibraryView, { global: { stubs: { Teleport: true } } })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LibraryView', () => {
  it('renders a tile per asset', async () => {
    mockWindowBond([makeAsset({ id: 'a1', title: 'Doc one' }), makeAsset({ id: 'a2', title: 'Doc two' })])
    const wrapper = mountLibraryView()
    await flushPromises()

    expect(wrapper.findAll('.library-item')).toHaveLength(2)
    expect(wrapper.text()).toContain('Doc one')
    expect(wrapper.text()).toContain('Doc two')
  })

  it('shows the empty state when there are no assets', async () => {
    mockWindowBond([])
    const wrapper = mountLibraryView()
    await flushPromises()

    expect(wrapper.text()).toContain('Nothing in the Library yet.')
  })

  it('shows preview text for a document tile', async () => {
    mockWindowBond([makeAsset({ previewText: 'A generated report body' })])
    const wrapper = mountLibraryView()
    await flushPromises()

    expect(wrapper.text()).toContain('A generated report body')
  })

  it('re-fetches with the selected kind filter after the debounce', async () => {
    const bond = mockWindowBond([])
    const wrapper = mountLibraryView()
    await flushPromises()
    bond.libraryList.mockClear()

    // BondTab emits update:modelValue — simulate directly via the composable's reactive state
    await wrapper.findComponent({ name: 'BondTab' }).vm.$emit('update:modelValue', 'media')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()

    expect(bond.libraryList).toHaveBeenCalledWith('media', undefined)
  })

  it('debounces search input before re-fetching', async () => {
    const bond = mockWindowBond([])
    const wrapper = mountLibraryView()
    await flushPromises()
    bond.libraryList.mockClear()

    await wrapper.findComponent({ name: 'BondInput' }).vm.$emit('update:modelValue', 'studio')
    expect(bond.libraryList).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(bond.libraryList).toHaveBeenCalledWith(undefined, 'studio')
  })

  it('requires a second click before deleting', async () => {
    const bond = mockWindowBond([makeAsset({ id: 'a1' })])
    const wrapper = mountLibraryView()
    await flushPromises()

    const deleteBtn = wrapper.findAll('.library-actions button')[1]
    await deleteBtn.trigger('click')
    expect(bond.libraryDelete).not.toHaveBeenCalled()

    await deleteBtn.trigger('click')
    expect(bond.libraryDelete).toHaveBeenCalledWith('a1')
  })

  it('reveals in Finder without requiring confirmation', async () => {
    const bond = mockWindowBond([makeAsset({ id: 'a1', managedPath: '/path/a1.md' })])
    const wrapper = mountLibraryView()
    await flushPromises()

    const revealBtn = wrapper.findAll('.library-actions button')[0]
    await revealBtn.trigger('click')
    expect(bond.revealInFinder).toHaveBeenCalledWith('/path/a1.md')
  })

  it('shows an info card with backlinks on hover, and hides it on mouseleave', async () => {
    const bond = mockWindowBond([makeAsset({ id: 'a1', title: 'Studio catch-up' })])
    bond.libraryListBacklinksForAsset.mockResolvedValue([
      { itemId: 'item1', collectionId: 'c1', collectionName: 'Tracker', itemKey: 'BOND-1', itemLabel: 'Studio work' },
    ])
    const wrapper = mountLibraryView()
    await flushPromises()

    expect(wrapper.find('.library-info-card').exists()).toBe(false)

    await wrapper.find('.library-item').trigger('mousemove')
    await flushPromises()

    expect(bond.libraryListBacklinksForAsset).toHaveBeenCalledWith('a1')
    const card = wrapper.find('.library-info-card')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('Studio catch-up')
    expect(card.text()).toContain('Referenced in (1)')
    expect(card.text()).toContain('BOND-1')

    await wrapper.find('.library-item').trigger('mouseleave')
    expect(wrapper.find('.library-info-card').exists()).toBe(false)
  })

  it('shows an empty backlink state on hover when nothing references the asset', async () => {
    const bond = mockWindowBond([makeAsset({ id: 'a1' })])
    bond.libraryListBacklinksForAsset.mockResolvedValue([])
    const wrapper = mountLibraryView()
    await flushPromises()

    await wrapper.find('.library-item').trigger('mousemove')
    await flushPromises()

    expect(wrapper.find('.library-info-card').text()).toContain('Not referenced by any collection item.')
  })

  it('fetches backlinks only once per asset across repeated mousemoves', async () => {
    const bond = mockWindowBond([makeAsset({ id: 'a1' })])
    const wrapper = mountLibraryView()
    await flushPromises()

    const item = wrapper.find('.library-item')
    await item.trigger('mousemove')
    await item.trigger('mousemove')
    await item.trigger('mousemove')
    await flushPromises()

    expect(bond.libraryListBacklinksForAsset).toHaveBeenCalledTimes(1)
  })

  it('renders document previews through the markdown renderer, not as raw source', async () => {
    mockWindowBond([makeAsset({ id: 'a1', format: 'markdown', previewText: '# Big heading\n\nBody copy' })])
    const wrapper = mountLibraryView()
    await flushPromises()

    const page = wrapper.find('.library-doc-page')
    expect(page.exists()).toBe(true)
    expect(page.findComponent({ name: 'MarkdownMessage' }).exists()).toBe(true)
  })

  it('opens markdown documents via the in-app viewer', async () => {
    const bond = mockWindowBond([makeAsset({ id: 'a1', format: 'markdown', managedPath: '/path/a1.md', title: 'Doc' })])
    const wrapper = mountLibraryView()
    await flushPromises()

    await wrapper.find('.library-item').trigger('dblclick')
    expect(bond.openViewer).toHaveBeenCalledWith('/path/a1.md', 'markdown', 'Doc')
    expect(bond.openPath).not.toHaveBeenCalled()
  })

  it('opens PDFs via the native app instead of the in-app viewer', async () => {
    const bond = mockWindowBond([makeAsset({ id: 'a1', format: 'pdf', managedPath: '/path/a1.pdf' })])
    const wrapper = mountLibraryView()
    await flushPromises()

    await wrapper.find('.library-item').trigger('dblclick')
    expect(bond.openPath).toHaveBeenCalledWith('/path/a1.pdf')
    expect(bond.openViewer).not.toHaveBeenCalled()
  })

  it('opens media assets via the native app', async () => {
    const bond = mockWindowBond([makeAsset({ id: 'a1', kind: 'media', format: 'image', managedPath: '/path/a1.png' })])
    const wrapper = mountLibraryView()
    await flushPromises()

    await wrapper.find('.library-item').trigger('dblclick')
    expect(bond.openPath).toHaveBeenCalledWith('/path/a1.png')
  })

  // Regression: switching the filter while a previous reload() was still
  // mid-batch used to spin forever — the stale loop kept reading
  // mediaAssets() off the now-swapped assets.value, got a permanently empty
  // batch, and never advanced loadedCount past its stale `total`.
  it('does not hang when the filter changes while a media batch load is still in flight', async () => {
    const mediaAssets = Array.from({ length: 3 }, (_, i) => makeAsset({ id: `m${i}`, kind: 'media', format: 'image' }))
    const docAssets = [makeAsset({ id: 'd1', kind: 'document' })]
    const bond = mockWindowBond([])
    bond.libraryList.mockImplementation(async (kind?: string) => {
      if (kind === 'media') return mediaAssets
      if (kind === 'document') return docAssets
      return []
    })

    let resolveImages: (() => void) | null = null
    bond.getImages.mockImplementation(() => new Promise((resolve) => {
      resolveImages = () => resolve(mediaAssets.map(() => null))
    }))

    const wrapper = mountLibraryView()
    await flushPromises()

    // Switch to Media — reload() starts, calls getImages, and is left awaiting it.
    await wrapper.findComponent({ name: 'BondTab' }).vm.$emit('update:modelValue', 'media')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()

    // Before that getImages resolves, switch to Documents — a second reload()
    // starts and swaps assets.value out from under the first one.
    await wrapper.findComponent({ name: 'BondTab' }).vm.$emit('update:modelValue', 'document')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()

    // Now let the stale media getImages call resolve.
    resolveImages!()
    await flushPromises()

    // The component must have settled on the LATER (document) filter, not hung.
    expect(wrapper.text()).toContain('Studio catch-up')
    expect(wrapper.findAll('.library-item')).toHaveLength(1)
  })
})
