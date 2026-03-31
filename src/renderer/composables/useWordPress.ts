import { ref, computed, watch } from 'vue'
import type { WordPressSite, WordPressSiteDetails } from '../../shared/wordpress'

export interface WordPressDeps {
  listWordPressSites: () => Promise<{ available: boolean; sites: WordPressSite[] }>
  getWordPressSiteDetails: (path: string) => Promise<WordPressSiteDetails | null>
  createWordPressSite: (name: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
  deleteWordPressSite: (path: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
  startWordPressSite: (path: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
  stopWordPressSite: (path: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
}

const defaultDeps: WordPressDeps = {
  listWordPressSites: () => window.bond.listWordPressSites(),
  getWordPressSiteDetails: (path) => window.bond.getWordPressSiteDetails(path),
  createWordPressSite: (name) => window.bond.createWordPressSite(name),
  deleteWordPressSite: (path) => window.bond.deleteWordPressSite(path),
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

  const siteDetails = ref<WordPressSiteDetails | null>(null)
  const loadingDetails = ref(false)

  async function loadDetails(path: string) {
    loadingDetails.value = true
    siteDetails.value = null
    try {
      siteDetails.value = await deps.getWordPressSiteDetails(path)
    } finally {
      loadingDetails.value = false
    }
  }

  // Auto-fetch details when selected site changes or its running state changes
  watch(
    () => {
      const site = selectedSite.value
      return site ? `${site.id}:${site.running}` : null
    },
    (key) => {
      if (!key) {
        siteDetails.value = null
        return
      }
      const site = selectedSite.value
      if (site?.running) {
        loadDetails(site.path)
      } else {
        siteDetails.value = null
      }
    }
  )

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

  const deleting = ref(false)

  async function deleteSite(path: string) {
    deleting.value = true
    try {
      applyResult(await deps.deleteWordPressSite(path))
      selectedSiteId.value = null
    } finally {
      deleting.value = false
    }
  }

  return { sites, available, loading, creating, deleting, selectedSiteId, selectedSite, siteDetails, loadingDetails, togglingSiteId, load, createSite, selectSite, startSite, stopSite, deleteSite }
}
