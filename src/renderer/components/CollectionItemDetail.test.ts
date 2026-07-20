import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CollectionItemDetail from './CollectionItemDetail.vue'
import type { Collection, CollectionItem } from '../../shared/session'
import type { LibraryAsset } from '../../shared/library'

const collection: Collection = {
  id: 'c1', name: 'Tracker', icon: '', features: [], archived: false,
  createdAt: '2025-01-01', updatedAt: '2025-01-01',
  schema: [{ name: 'title', type: 'text', primary: true }],
}

function makeItem(overrides: Partial<CollectionItem> = {}): CollectionItem {
  return {
    id: 'item1', collectionId: 'c1', data: { title: 'Studio work' }, sortOrder: 0,
    displayNumber: 1, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  }
}

function makeAsset(overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id: 'a1', kind: 'document', format: 'markdown', title: 'Studio catch-up',
    filename: 'a1.md', mediaType: 'text/markdown', sizeBytes: 100,
    managedPath: '/path/a1.md', createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  }
}

function mockWindowBond(references: LibraryAsset[] = []) {
  const mock = {
    getCollectionItem: vi.fn().mockResolvedValue(makeItem()),
    onCollectionsChanged: vi.fn().mockReturnValue(() => {}),
    libraryListReferencesForItem: vi.fn().mockResolvedValue(references),
    getImages: vi.fn().mockResolvedValue([]),
    libraryList: vi.fn().mockResolvedValue([]),
    libraryAddReference: vi.fn().mockResolvedValue({ id: 'ref1', assetId: 'a1', collectionId: 'c1', itemId: 'item1', createdAt: '2025-01-01' }),
    libraryRemoveReference: vi.fn().mockResolvedValue({ ok: true }),
    revealInFinder: vi.fn().mockResolvedValue(undefined),
    openViewer: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(''),
  }
  ;(window as any).bond = mock
  return mock
}

async function mountDetail(references: LibraryAsset[] = []) {
  const bond = mockWindowBond(references)
  const wrapper = mount(CollectionItemDetail, {
    props: { collection, itemId: 'item1' },
    global: { stubs: { Teleport: true } },
  })
  await flushPromises()
  return { wrapper, bond }
}

describe('CollectionItemDetail references', () => {
  it('renders a tile per referenced asset', async () => {
    const { wrapper } = await mountDetail([makeAsset({ id: 'a1', title: 'Studio catch-up' }), makeAsset({ id: 'a2', title: 'Screenshot' })])

    expect(wrapper.findAll('.reference-tile')).toHaveLength(2)
    expect(wrapper.text()).toContain('Studio catch-up')
    expect(wrapper.text()).toContain('Screenshot')
    expect(wrapper.text()).toContain('References (2)')
  })

  it('removing a reference calls the RPC and drops only that tile', async () => {
    const { wrapper, bond } = await mountDetail([makeAsset({ id: 'a1', title: 'Studio catch-up' }), makeAsset({ id: 'a2', title: 'Screenshot' })])
    bond.libraryListReferencesForItem.mockResolvedValue([makeAsset({ id: 'a2', title: 'Screenshot' })])

    // Actions per tile: [showInConversation? , reveal, remove] — a1 has no sourceMessageId, so 2 buttons; the last one is remove.
    const firstTileButtons = wrapper.findAll('.reference-tile')[0].findAll('button')
    await firstTileButtons[firstTileButtons.length - 1].trigger('click')
    await flushPromises()

    expect(bond.libraryRemoveReference).toHaveBeenCalledWith('a1', 'item1')
    expect(wrapper.findAll('.reference-tile')).toHaveLength(1)
    expect(wrapper.text()).toContain('Screenshot')
    expect(wrapper.text()).not.toContain('Studio catch-up')
  })

  it('dispatches bond:scroll-to-message with the source message id', async () => {
    const { wrapper } = await mountDetail([makeAsset({ id: 'a1', sourceMessageId: 'msg-42' })])
    const listener = vi.fn()
    window.addEventListener('bond:scroll-to-message', listener)

    const showBtn = wrapper.findAll('.reference-tile')[0].findAll('button')[0]
    await showBtn.trigger('click')

    expect(listener).toHaveBeenCalled()
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('msg-42')
    window.removeEventListener('bond:scroll-to-message', listener)
  })

  it('does not show the "Show in conversation" action when there is no source message', async () => {
    const { wrapper } = await mountDetail([makeAsset({ id: 'a1', sourceMessageId: undefined })])
    // Only reveal + remove — 2 buttons, no chat-circle action.
    expect(wrapper.findAll('.reference-tile')[0].findAll('button')).toHaveLength(2)
  })

  it('reveals in Finder using the asset managed path', async () => {
    const { wrapper, bond } = await mountDetail([makeAsset({ id: 'a1', managedPath: '/path/a1.md', sourceMessageId: undefined })])
    const revealBtn = wrapper.findAll('.reference-tile')[0].findAll('button')[0]
    await revealBtn.trigger('click')
    expect(bond.revealInFinder).toHaveBeenCalledWith('/path/a1.md')
  })

  it('adding a reference calls libraryAddReference and refreshes the list', async () => {
    const { wrapper, bond } = await mountDetail([])
    bond.libraryList.mockResolvedValue([makeAsset({ id: 'a1', title: 'New report' })])
    bond.libraryListReferencesForItem.mockResolvedValue([makeAsset({ id: 'a1', title: 'New report' })])

    await wrapper.find('.add-reference-btn').trigger('click')
    await flushPromises()

    const pickerItem = wrapper.find('.reference-picker-item')
    await pickerItem.trigger('click')
    await flushPromises()

    expect(bond.libraryAddReference).toHaveBeenCalledWith('a1', 'item1')
    expect(wrapper.text()).toContain('New report')
  })
})
