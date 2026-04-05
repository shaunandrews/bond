import { ref, computed, watch } from 'vue'
import type { BrowserTab, BrowserCommand, ConsoleEntry, NetworkEntry } from '../../shared/browser'
import { MAX_TABS } from '../../shared/browser'

const STORAGE_KEY = 'bond:browser-tabs'
const FAVORITES_KEY = 'bond:browser-favorites'

export interface BrowserFavorite {
  url: string
  title: string
  favicon: string | null
}

function loadFavorites(): BrowserFavorite[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function persistFavorites(): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites.value))
}

interface PersistedTab {
  id: string
  url: string
  title: string
  favicon: string | null
}

function loadPersistedTabs(): { tabs: BrowserTab[]; activeTabId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { tabs: [], activeTabId: null }
    const data = JSON.parse(raw) as { tabs: PersistedTab[]; activeTabId: string | null }
    const tabs = (data.tabs ?? [])
      .filter((t: PersistedTab) => t.url && t.url !== 'about:blank')
      .map((t: PersistedTab): BrowserTab => ({
        id: t.id,
        url: t.url,
        title: t.title || 'New tab',
        favicon: t.favicon,
        loading: true,
        canGoBack: false,
        canGoForward: false,
        error: null,
      }))
    const activeTabId = tabs.some((t: BrowserTab) => t.id === data.activeTabId) ? data.activeTabId : (tabs[0]?.id ?? null)
    return { tabs, activeTabId }
  } catch {
    return { tabs: [], activeTabId: null }
  }
}

function persistTabs(): void {
  const data = {
    tabs: tabs.value
      .filter(t => t.url && t.url !== 'about:blank')
      .map(t => ({ id: t.id, url: t.url, title: t.title, favicon: t.favicon })),
    activeTabId: activeTabId.value,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

// Singleton state — survives HMR
const restored = loadPersistedTabs()
const tabs = ref<BrowserTab[]>(restored.tabs)
const activeTabId = ref<string | null>(restored.activeTabId)
const consoleLogs = ref<Map<string, ConsoleEntry[]>>(new Map())
const networkLogs = ref<Map<string, NetworkEntry[]>>(new Map())

const activeTab = computed(() =>
  tabs.value.find(t => t.id === activeTabId.value) ?? null
)

const favorites = ref<BrowserFavorite[]>(loadFavorites())

// Persist on change
watch([tabs, activeTabId], persistTabs, { deep: true })
watch(favorites, persistFavorites, { deep: true })

function createTab(url = 'about:blank'): string {
  if (tabs.value.length >= MAX_TABS) {
    // Close oldest tab to make room
    const oldest = tabs.value[0]
    closeTab(oldest.id)
  }
  const id = crypto.randomUUID()
  const tab: BrowserTab = {
    id,
    url,
    title: 'New tab',
    favicon: null,
    loading: url !== 'about:blank',
    canGoBack: false,
    canGoForward: false,
    error: null,
  }
  tabs.value.push(tab)
  activeTabId.value = id
  consoleLogs.value.set(id, [])
  networkLogs.value.set(id, [])
  return id
}

function closeTab(id: string): void {
  const idx = tabs.value.findIndex(t => t.id === id)
  if (idx === -1) return
  tabs.value.splice(idx, 1)
  consoleLogs.value.delete(id)
  networkLogs.value.delete(id)

  if (activeTabId.value === id) {
    if (tabs.value.length > 0) {
      // Switch to nearest tab
      const next = Math.min(idx, tabs.value.length - 1)
      activeTabId.value = tabs.value[next].id
    } else {
      activeTabId.value = null
    }
  }
}

function closeAllTabs(): void {
  tabs.value = []
  activeTabId.value = null
  consoleLogs.value.clear()
  networkLogs.value.clear()
}

function switchTab(id: string): void {
  if (tabs.value.some(t => t.id === id)) {
    activeTabId.value = id
  }
}

function navigate(id: string, url: string): void {
  const tab = tabs.value.find(t => t.id === id)
  if (tab) {
    tab.url = url
    tab.loading = true
    tab.error = null
  }
}

function updateTab(id: string, updates: Partial<BrowserTab>): void {
  const tab = tabs.value.find(t => t.id === id)
  if (tab) Object.assign(tab, updates)
}

function addConsoleEntry(tabId: string, entry: ConsoleEntry): void {
  let log = consoleLogs.value.get(tabId)
  if (!log) {
    log = []
    consoleLogs.value.set(tabId, log)
  }
  log.push(entry)
  // Ring buffer — keep last 500
  if (log.length > 500) log.splice(0, log.length - 500)
}

function addNetworkEntry(tabId: string, entry: NetworkEntry): void {
  let log = networkLogs.value.get(tabId)
  if (!log) {
    log = []
    networkLogs.value.set(tabId, log)
  }
  log.push(entry)
  // Ring buffer — keep last 200
  if (log.length > 200) log.splice(0, log.length - 200)
}

function updateNetworkEntry(tabId: string, requestId: string, updates: Partial<NetworkEntry>): void {
  const log = networkLogs.value.get(tabId)
  if (!log) return
  const entry = log.find(e => e.requestId === requestId)
  if (entry) Object.assign(entry, updates)
}

function getConsoleLog(tabId?: string): ConsoleEntry[] {
  const id = tabId ?? activeTabId.value
  if (!id) return []
  return consoleLogs.value.get(id) ?? []
}

function getNetworkLog(tabId?: string): NetworkEntry[] {
  const id = tabId ?? activeTabId.value
  if (!id) return []
  return networkLogs.value.get(id) ?? []
}

// --- Favorites ---

function addFavorite(url: string, title: string, favicon: string | null): void {
  if (favorites.value.some(f => f.url === url)) return
  favorites.value.push({ url, title, favicon })
}

function removeFavorite(url: string): void {
  const idx = favorites.value.findIndex(f => f.url === url)
  if (idx !== -1) favorites.value.splice(idx, 1)
}

function isFavorite(url: string): boolean {
  return favorites.value.some(f => f.url === url)
}

// Handle commands from the agent (via IPC)
let commandHandler: ((cmd: BrowserCommand) => Promise<unknown>) | null = null

function setCommandHandler(handler: (cmd: BrowserCommand) => Promise<unknown>): void {
  commandHandler = handler
}

async function handleCommand(cmd: BrowserCommand): Promise<unknown> {
  if (commandHandler) return commandHandler(cmd)
  return { error: 'No browser command handler registered' }
}

export function useBrowser() {
  return {
    tabs,
    activeTabId,
    activeTab,
    favorites,
    consoleLogs,
    networkLogs,
    createTab,
    closeTab,
    closeAllTabs,
    switchTab,
    navigate,
    updateTab,
    addFavorite,
    removeFavorite,
    isFavorite,
    addConsoleEntry,
    addNetworkEntry,
    updateNetworkEntry,
    getConsoleLog,
    getNetworkLog,
    setCommandHandler,
    handleCommand,
  }
}
