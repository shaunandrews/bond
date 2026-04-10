import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent } from 'vue'
import { useCollections } from './useCollections'
import type { Collection, FieldDef } from '../../shared/session'

function makeCollection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: 'c1', name: 'Test', icon: '', schema: [], features: [],
    archived: false, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  }
}

function mockWindowBond() {
  const mock = {
    listCollections: vi.fn().mockResolvedValue([]),
    createCollection: vi.fn().mockResolvedValue(makeCollection()),
    updateCollection: vi.fn().mockResolvedValue(makeCollection()),
    deleteCollection: vi.fn().mockResolvedValue(true),
  }
  ;(window as any).bond = mock
  return mock
}

type UseCollectionsReturn = ReturnType<typeof useCollections>

function withSetup(): UseCollectionsReturn {
  let result!: UseCollectionsReturn
  const app = createApp(
    defineComponent({
      setup() {
        result = useCollections()
        return () => null
      },
    })
  )
  app.mount(document.createElement('div'))
  return result
}

describe('useCollections', () => {
  let bond: ReturnType<typeof mockWindowBond>
  let collections: UseCollectionsReturn

  beforeEach(() => {
    localStorage.clear()
    bond = mockWindowBond()
    collections = withSetup()
  })

  describe('load', () => {
    it('fetches collections from window.bond', async () => {
      const data = [makeCollection({ id: 'c1' }), makeCollection({ id: 'c2', archived: true })]
      bond.listCollections.mockResolvedValue(data)

      await collections.load()
      expect(collections.collections.value).toHaveLength(2)
      expect(collections.activeCollections.value).toHaveLength(1)
      expect(collections.archivedCollections.value).toHaveLength(1)
    })
  })

  describe('create', () => {
    it('adds collection and selects it', async () => {
      const newCol = makeCollection({ id: 'new-1', name: 'New' })
      bond.createCollection.mockResolvedValue(newCol)

      const schema: FieldDef[] = [{ name: 'title', type: 'text' }]
      const result = await collections.create('New', schema, '📝')
      expect(result.name).toBe('New')
      expect(collections.collections.value).toHaveLength(1)
      expect(collections.activeCollectionId.value).toBe('new-1')
    })
  })

  describe('select', () => {
    it('updates activeCollectionId', () => {
      collections.select('c1')
      expect(collections.activeCollectionId.value).toBe('c1')
    })
  })

  describe('archive', () => {
    it('updates collection in list', async () => {
      const c = makeCollection({ id: 'c1' })
      collections.collections.value = [c]
      collections.activeCollectionId.value = 'c1'

      bond.updateCollection.mockResolvedValue({ ...c, archived: true })

      await collections.archive('c1')
      expect(collections.collections.value[0].archived).toBe(true)
      expect(collections.activeCollectionId.value).toBeNull()
    })
  })

  describe('unarchive', () => {
    it('updates collection in list', async () => {
      const c = makeCollection({ id: 'c1', archived: true })
      collections.collections.value = [c]

      bond.updateCollection.mockResolvedValue({ ...c, archived: false })

      await collections.unarchive('c1')
      expect(collections.collections.value[0].archived).toBe(false)
    })
  })

  describe('update', () => {
    it('updates collection fields', async () => {
      const c = makeCollection({ id: 'c1', name: 'Old' })
      collections.collections.value = [c]

      bond.updateCollection.mockResolvedValue({ ...c, name: 'New' })

      await collections.update('c1', { name: 'New' })
      expect(collections.collections.value[0].name).toBe('New')
    })
  })

  describe('remove', () => {
    it('removes collection from list', async () => {
      collections.collections.value = [makeCollection({ id: 'c1' })]
      collections.activeCollectionId.value = 'c1'

      await collections.remove('c1')
      expect(collections.collections.value).toHaveLength(0)
      expect(collections.activeCollectionId.value).toBeNull()
    })
  })

  describe('computed', () => {
    it('activeCollection resolves from list', () => {
      collections.collections.value = [makeCollection({ id: 'c1' }), makeCollection({ id: 'c2' })]
      collections.activeCollectionId.value = 'c2'
      expect(collections.activeCollection.value?.id).toBe('c2')
    })

    it('activeCollection returns null when no match', () => {
      collections.collections.value = [makeCollection({ id: 'c1' })]
      collections.activeCollectionId.value = 'unknown'
      expect(collections.activeCollection.value).toBeNull()
    })
  })
})
