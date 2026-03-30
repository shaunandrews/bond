import { ref, computed } from 'vue'
import type { WordPressSite } from '../../shared/wordpress'

export interface WordPressDeps {
  listWordPressSites: () => Promise<{ available: boolean; sites: WordPressSite[] }>
  createWordPressSite: (name: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
  startWordPressSite: (path: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
  stopWordPressSite: (path: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
}

const defaultDeps: WordPressDeps = {
  listWordPressSites: () => window.bond.listWordPressSites(),
  createWordPressSite: (name) => window.bond.createWordPressSite(name),
  startWordPressSite: (path) => window.bond.startWordPressSite(path),
  stopWordPressSite: (path) => window.bond.stopWordPressSite(path)
}

export function useWordPress(deps: WordPressDeps = defaultDeps) {
  const sites = ref<WordPressSite[]>([])
  const available = ref<boolean | null>(null)
  const loading = ref(false)
  const creating = ref(false)
  const selectedSiteId = ref<string | null>(null)
  const selectedSite = computed(() =>
    sites.value.find((s) => s.id === selectedSiteId.value) ?? null
  )
  const togglingSiteId = ref<string | null>(null)

  async function load() {
    loading.value = true
    try {
      const result = await deps.listWordPressSites()
      available.value = result.available
      sites.value = result.sites
    } catch {
      available.value = false
      sites.value = []
    } finally {
      loading.value = false
    }
  }

  async function createSite() {
    creating.value = true
    try {
      // Find next available number
      let n = 1
      const existingNames = new Set(sites.value.map((s) => s.name))
      while (existingNames.has(`WordPress Site ${n}`)) n++

      const result = await deps.createWordPressSite(`WordPress Site ${n}`)
      available.value = result.available
      sites.value = result.sites
    } finally {
      creating.value = false
    }
  }

  function selectSite(id: string) {
    selectedSiteId.value = id
  }

  function applyResult(result: { available: boolean; sites: WordPressSite[] }) {
    available.value = result.available
    sites.value = result.sites
  }

  async function startSite(id: string, path: string) {
    togglingSiteId.value = id
    try {
      applyResult(await deps.startWordPressSite(path))
    } finally {
      togglingSiteId.value = null
    }
  }

  async function stopSite(id: string, path: string) {
    togglingSiteId.value = id
    try {
      applyResult(await deps.stopWordPressSite(path))
    } finally {
      togglingSiteId.value = null
    }
  }

  return { sites, available, loading, creating, selectedSiteId, selectedSite, togglingSiteId, load, createSite, selectSite, startSite, stopSite }
}
