import { ref } from 'vue'
import type { AssetKind, LibraryAsset } from '../../shared/library'

export function useLibrary() {
  const assets = ref<LibraryAsset[]>([])
  const kindFilter = ref<AssetKind | 'all'>('all')
  const query = ref('')
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      assets.value = await window.bond.libraryList(
        kindFilter.value === 'all' ? undefined : kindFilter.value,
        query.value.trim() || undefined
      )
    } finally {
      loading.value = false
    }
  }

  async function deleteAsset(id: string): Promise<boolean> {
    const result = await window.bond.libraryDelete(id)
    if (result.ok) {
      assets.value = assets.value.filter(a => a.id !== id)
    }
    return result.ok
  }

  return { assets, kindFilter, query, loading, load, deleteAsset }
}
