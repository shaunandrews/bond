import { ref, computed, watch } from 'vue'
import type { Collection, CollectionItem, FieldDef } from '../../shared/session'

const STORAGE_KEY = 'bond:activeCollectionId'

export function useCollections() {
  const collections = ref<Collection[]>([])
  const activeCollectionId = ref<string | null>(localStorage.getItem(STORAGE_KEY))
  const loading = ref(false)

  watch(activeCollectionId, (id) => {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  })

  const activeCollections = computed(() =>
    collections.value.filter((c) => !c.archived)
  )

  const archivedCollections = computed(() =>
    collections.value.filter((c) => c.archived)
  )

  const activeCollection = computed(() =>
    collections.value.find((c) => c.id === activeCollectionId.value) ?? null
  )

  async function load() {
    loading.value = true
    try {
      collections.value = await window.bond.listCollections()
    } finally {
      loading.value = false
    }
  }

  async function create(name: string, schema: FieldDef[], icon?: string): Promise<Collection> {
    const collection = await window.bond.createCollection(name, schema, icon)
    collections.value.unshift(collection)
    activeCollectionId.value = collection.id
    return collection
  }

  function select(id: string | null) {
    activeCollectionId.value = id
  }

  async function archive(id: string) {
    const updated = await window.bond.updateCollection(id, { archived: true })
    if (updated) {
      const idx = collections.value.findIndex((c) => c.id === id)
      if (idx !== -1) collections.value[idx] = updated
      if (activeCollectionId.value === id) {
        const next = activeCollections.value[0]
        activeCollectionId.value = next?.id ?? null
      }
    }
  }

  async function unarchive(id: string) {
    const updated = await window.bond.updateCollection(id, { archived: false })
    if (updated) {
      const idx = collections.value.findIndex((c) => c.id === id)
      if (idx !== -1) collections.value[idx] = updated
    }
  }

  async function update(id: string, updates: Partial<Pick<Collection, 'name' | 'icon' | 'schema'>>) {
    const updated = await window.bond.updateCollection(id, updates)
    if (updated) {
      const idx = collections.value.findIndex((c) => c.id === id)
      if (idx !== -1) collections.value[idx] = updated
    }
    return updated
  }

  async function remove(id: string) {
    const ok = await window.bond.deleteCollection(id)
    if (ok) {
      collections.value = collections.value.filter((c) => c.id !== id)
      if (activeCollectionId.value === id) {
        const next = activeCollections.value[0]
        activeCollectionId.value = next?.id ?? null
      }
    }
  }

  return {
    collections,
    activeCollectionId,
    activeCollection,
    activeCollections,
    archivedCollections,
    loading,
    load,
    create,
    select,
    archive,
    unarchive,
    update,
    remove,
  }
}
