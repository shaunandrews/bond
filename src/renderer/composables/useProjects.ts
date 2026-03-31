import { ref, computed, watch } from 'vue'
import type { WordPressSite, WordPressSiteDetails, WpSiteMap, WpThemeJson } from '../../shared/wordpress'

export interface ProjectsDeps {
  listProjects: () => Promise<{ available: boolean; sites: WordPressSite[] }>
  getProjectDetails: (path: string) => Promise<WordPressSiteDetails | null>
  getProjectSiteMap: (path: string) => Promise<WpSiteMap | null>
  getProjectThemeJson: (path: string) => Promise<WpThemeJson | null>
  createProject: (name: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
  deleteProject: (path: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
  startProject: (path: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
  stopProject: (path: string) => Promise<{ available: boolean; sites: WordPressSite[] }>
}

const defaultDeps: ProjectsDeps = {
  listProjects: () => window.bond.listWordPressSites(),
  getProjectDetails: (path) => window.bond.getWordPressSiteDetails(path),
  getProjectSiteMap: (path) => window.bond.getWordPressSiteMap(path),
  getProjectThemeJson: (path) => window.bond.getWordPressThemeJson(path),
  createProject: (name) => window.bond.createWordPressSite(name),
  deleteProject: (path) => window.bond.deleteWordPressSite(path),
  startProject: (path) => window.bond.startWordPressSite(path),
  stopProject: (path) => window.bond.stopWordPressSite(path)
}

export function useProjects(deps: ProjectsDeps = defaultDeps) {
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

  const siteMap = ref<WpSiteMap | null>(null)
  const loadingSiteMap = ref(false)

  const themeJson = ref<WpThemeJson | null>(null)
  const loadingThemeJson = ref(false)

  async function loadDetails(path: string) {
    loadingDetails.value = true
    siteDetails.value = null
    try {
      siteDetails.value = await deps.getProjectDetails(path)
    } finally {
      loadingDetails.value = false
    }
  }

  async function loadSiteMap(path: string) {
    loadingSiteMap.value = true
    try {
      siteMap.value = await deps.getProjectSiteMap(path)
    } finally {
      loadingSiteMap.value = false
    }
  }

  async function loadThemeJson(path: string) {
    loadingThemeJson.value = true
    try {
      themeJson.value = await deps.getProjectThemeJson(path)
    } finally {
      loadingThemeJson.value = false
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
        siteMap.value = null
        themeJson.value = null
        return
      }
      const site = selectedSite.value
      if (site?.running) {
        loadDetails(site.path)
      } else {
        siteDetails.value = null
        siteMap.value = null
        themeJson.value = null
      }
    }
  )

  async function load() {
    loading.value = true
    try {
      const result = await deps.listProjects()
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
      while (existingNames.has(`Project ${n}`)) n++

      const result = await deps.createProject(`Project ${n}`)
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
      applyResult(await deps.startProject(path))
    } finally {
      togglingSiteId.value = null
    }
  }

  async function stopSite(id: string, path: string) {
    togglingSiteId.value = id
    try {
      applyResult(await deps.stopProject(path))
    } finally {
      togglingSiteId.value = null
    }
  }

  const deleting = ref(false)

  async function deleteSite(path: string) {
    deleting.value = true
    try {
      applyResult(await deps.deleteProject(path))
      selectedSiteId.value = null
    } finally {
      deleting.value = false
    }
  }

  return { sites, available, loading, creating, deleting, selectedSiteId, selectedSite, siteDetails, loadingDetails, siteMap, loadingSiteMap, themeJson, loadingThemeJson, togglingSiteId, load, createSite, selectSite, startSite, stopSite, deleteSite, loadSiteMap, loadThemeJson }
}
