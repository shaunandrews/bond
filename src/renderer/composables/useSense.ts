import { ref, computed } from 'vue'
import type { SenseCapture, SenseSession } from '../../shared/sense'

export interface AppSummary {
  appName: string
  bundleId: string
  captureCount: number
}

/** Format a Date as a local YYYY-MM-DD string. */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayISO(): string {
  return localDateStr(new Date())
}

function dayStart(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
}

function dayEnd(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
}

/** Deterministic hue from a string (bundle ID or app name) */
export function appHue(identifier: string): number {
  let hash = 0
  for (let i = 0; i < identifier.length; i++) {
    hash = ((hash << 5) - hash + identifier.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}

export function appColor(identifier: string, isDark = false): string {
  const hue = appHue(identifier)
  return isDark
    ? `hsl(${hue}, 50%, 65%)`
    : `hsl(${hue}, 55%, 50%)`
}

// Singleton state
const date = ref<string>(todayISO())
const captures = ref<SenseCapture[]>([])
const sessions = ref<SenseSession[]>([])
const activeCapture = ref<SenseCapture | null>(null)
const activeCaptureImage = ref<string | null>(null)
const previewCapture = ref<SenseCapture | null>(null)
const previewCaptureImage = ref<string | null>(null)
const searchQuery = ref('')
const searchResults = ref<SenseCapture[]>([])
const appFilter = ref<string | null>(null)
const apps = ref<AppSummary[]>([])
const loading = ref(false)
const loadingImage = ref(false)
const loadingPreviewImage = ref(false)
let previewDebounce: ReturnType<typeof setTimeout> | null = null

// Image cache — avoids re-fetching on scrub. Cleared on day change.
const imageCache = new Map<string, string>()
const IMAGE_CACHE_MAX = 200
const PRELOAD_RADIUS = 3 // preload N captures on each side

async function fetchImage(id: string): Promise<string | null> {
  const cached = imageCache.get(id)
  if (cached) return cached
  try {
    const result = await window.bond.senseCapture(id)
    if (result?.image) {
      // Evict oldest if over limit
      if (imageCache.size >= IMAGE_CACHE_MAX) {
        const first = imageCache.keys().next().value
        if (first) imageCache.delete(first)
      }
      imageCache.set(id, result.image)
      return result.image
    }
  } catch (err) {
    console.error('Failed to load capture image:', err)
  }
  return null
}

function preloadNeighbors(id: string) {
  const idx = captures.value.findIndex(c => c.id === id)
  if (idx < 0) return
  for (let offset = 1; offset <= PRELOAD_RADIUS; offset++) {
    const before = captures.value[idx - offset]
    const after = captures.value[idx + offset]
    if (before && !imageCache.has(before.id)) fetchImage(before.id)
    if (after && !imageCache.has(after.id)) fetchImage(after.id)
  }
}

const filteredCaptures = computed(() => {
  if (!appFilter.value) return captures.value
  return captures.value.filter(c =>
    c.appBundleId === appFilter.value || c.appName === appFilter.value
  )
})

const isToday = computed(() => date.value === todayISO())

// Display = preview (hover) ?? active (clicked). Views bind to these.
const displayCapture = computed(() => previewCapture.value ?? activeCapture.value)
const displayCaptureImage = computed(() => {
  if (previewCapture.value) return previewCaptureImage.value
  return activeCaptureImage.value
})
const displayLoadingImage = computed(() => {
  if (previewCapture.value) return loadingPreviewImage.value
  return loadingImage.value
})

// Compute app summaries from captures
function computeApps(caps: SenseCapture[]): AppSummary[] {
  const map = new Map<string, AppSummary>()
  for (const c of caps) {
    const key = c.appBundleId || c.appName || 'unknown'
    const existing = map.get(key)
    if (existing) {
      existing.captureCount++
    } else {
      map.set(key, {
        appName: c.appName || 'Unknown',
        bundleId: c.appBundleId || key,
        captureCount: 1,
      })
    }
  }
  return [...map.values()].sort((a, b) => b.captureCount - a.captureCount)
}

async function loadDay(dateStr: string) {
  date.value = dateStr
  loading.value = true
  activeCapture.value = null
  activeCaptureImage.value = null
  clearPreview()
  imageCache.clear()
  searchQuery.value = ''
  searchResults.value = []
  appFilter.value = null

  try {
    const [caps, sess] = await Promise.all([
      window.bond.senseTimeline(dayStart(dateStr), dayEnd(dateStr), 10000),
      window.bond.senseSessions(dayStart(dateStr), dayEnd(dateStr)),
    ])

    // Normalize DB row keys (snake_case → camelCase)
    captures.value = (caps as unknown as Record<string, unknown>[]).map(normalizeCaptureRow)
    sessions.value = (sess as unknown as Record<string, unknown>[]).map(normalizeSessionRow)
    apps.value = computeApps(captures.value)
  } catch (err) {
    console.error('Failed to load sense day:', err)
    captures.value = []
    sessions.value = []
    apps.value = []
  } finally {
    loading.value = false
  }
}

async function selectCapture(id: string) {
  if (!id) {
    activeCapture.value = null
    activeCaptureImage.value = null
    return
  }

  const cap = captures.value.find(c => c.id === id) || searchResults.value.find(c => c.id === id)
  if (!cap) return

  activeCapture.value = cap

  // Check cache first — if hit, no flash
  const cached = imageCache.get(id)
  if (cached) {
    activeCaptureImage.value = cached
    loadingImage.value = false
    preloadNeighbors(id)
    return
  }

  // Not cached — keep previous image visible while loading (don't null it)
  loadingImage.value = true
  const image = await fetchImage(id)
  // Only apply if still the active capture
  if (activeCapture.value?.id === id) {
    activeCaptureImage.value = image
    loadingImage.value = false
  }
  preloadNeighbors(id)
}

function setPreview(id: string) {
  if (!id) { clearPreview(); return }
  const cap = captures.value.find(c => c.id === id)
  if (!cap) return
  // If already previewing this capture, skip
  if (previewCapture.value?.id === id) return

  previewCapture.value = cap

  // Check cache first — instant display, no debounce needed
  const cached = imageCache.get(id)
  if (cached) {
    previewCaptureImage.value = cached
    loadingPreviewImage.value = false
    if (previewDebounce) { clearTimeout(previewDebounce); previewDebounce = null }
    return
  }

  // Not cached — keep previous preview image visible (don't null it),
  // debounce the fetch to avoid hammering IPC on fast scrub
  if (previewDebounce) clearTimeout(previewDebounce)
  previewDebounce = setTimeout(async () => {
    loadingPreviewImage.value = true
    const image = await fetchImage(id)
    // Only apply if still previewing the same capture
    if (previewCapture.value?.id === id) {
      if (image) previewCaptureImage.value = image
      loadingPreviewImage.value = false
      preloadNeighbors(id)
    }
  }, 80)
}

function clearPreview() {
  if (previewDebounce) { clearTimeout(previewDebounce); previewDebounce = null }
  previewCapture.value = null
  previewCaptureImage.value = null
  loadingPreviewImage.value = false
}

async function search(query: string) {
  searchQuery.value = query
  if (!query.trim()) {
    searchResults.value = []
    return
  }
  try {
    const results = await window.bond.senseSearch(query, 50)
    searchResults.value = (results as unknown as Record<string, unknown>[]).map(normalizeCaptureRow)
  } catch (err) {
    console.error('Failed to search sense:', err)
    searchResults.value = []
  }
}

function setAppFilter(bundleId: string | null) {
  appFilter.value = appFilter.value === bundleId ? null : bundleId
}

function nextDay() {
  const [y, m, d] = date.value.split('-').map(Number)
  const next = new Date(y, m - 1, d + 1)
  const nextStr = localDateStr(next)
  if (nextStr <= todayISO()) {
    loadDay(nextStr)
  }
}

function prevDay() {
  const [y, m, d] = date.value.split('-').map(Number)
  const prev = new Date(y, m - 1, d - 1)
  const prevStr = localDateStr(prev)
  loadDay(prevStr)
}

function jumpToCapture(capture: SenseCapture) {
  const local = new Date(capture.capturedAt)
  const capDate = localDateStr(local)
  if (capDate !== date.value) {
    loadDay(capDate).then(() => {
      activeCapture.value = capture
      selectCapture(capture.id)
    })
  } else {
    activeCapture.value = capture
    selectCapture(capture.id)
  }
}

// Normalize snake_case DB rows to camelCase SenseCapture
function normalizeCaptureRow(row: Record<string, unknown>): SenseCapture {
  return {
    id: row.id as string,
    sessionId: (row.sessionId ?? row.session_id) as string,
    capturedAt: (row.capturedAt ?? row.captured_at) as string,
    imagePath: (row.imagePath ?? row.image_path) as string | undefined,
    appName: (row.appName ?? row.app_name) as string | undefined,
    appBundleId: (row.appBundleId ?? row.app_bundle_id) as string | undefined,
    windowTitle: (row.windowTitle ?? row.window_title) as string | undefined,
    visibleWindows: parseJsonArray(row.visibleWindows ?? row.visible_windows),
    textSource: (row.textSource ?? row.text_source) as SenseCapture['textSource'],
    textStatus: (row.textStatus ?? row.text_status) as SenseCapture['textStatus'],
    textContent: (row.textContent ?? row.text_content) as string | undefined,
    captureTrigger: (row.captureTrigger ?? row.capture_trigger) as SenseCapture['captureTrigger'],
    ambiguous: !!(row.ambiguous),
    imagePurgedAt: (row.imagePurgedAt ?? row.image_purged_at) as string | undefined,
    createdAt: (row.createdAt ?? row.created_at) as string,
  }
}

function normalizeSessionRow(row: Record<string, unknown>): SenseSession {
  return {
    id: row.id as string,
    startedAt: (row.startedAt ?? row.started_at) as string,
    endedAt: (row.endedAt ?? row.ended_at) as string | undefined,
    captureCount: (row.captureCount ?? row.capture_count) as number,
    createdAt: (row.createdAt ?? row.created_at) as string,
  }
}

function parseJsonArray(val: unknown): string[] {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') {
    try { return JSON.parse(val) } catch { return [] }
  }
  return []
}

export function useSense() {
  return {
    // State
    date,
    captures,
    sessions,
    activeCapture,
    activeCaptureImage,
    previewCapture,
    previewCaptureImage,
    displayCapture,
    displayCaptureImage,
    displayLoadingImage,
    searchQuery,
    searchResults,
    appFilter,
    apps,
    loading,
    loadingImage,
    filteredCaptures,
    isToday,

    // Methods
    loadDay,
    selectCapture,
    setPreview,
    clearPreview,
    search,
    setAppFilter,
    nextDay,
    prevDay,
    jumpToCapture,
  }
}
