import { ref, computed } from 'vue'
import type { CoreMemory, MemoryItem, MemoryItemInput, MemorySourcesResult, RetrievedMemory, WorkingState } from '../../shared/memory'

const emptyCore = (): CoreMemory => ({ version: 1, facts: [], preferences: [], decisions: [], updatedAt: new Date().toISOString() })
const emptyWorking = (): WorkingState => ({ sessionId: null, projectId: null, goal: '', facts: [], preferences: [], decisions: [], openThreads: [], updatedAt: new Date().toISOString() })

const core = ref<CoreMemory>(emptyCore())
const working = ref<WorkingState>(emptyWorking())
const results = ref<RetrievedMemory[]>([])
const sources = ref<MemorySourcesResult>({ sourceIds: [], messages: [] })
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function loadMemory() {
  loading.value = true
  error.value = null
  try {
    const [coreValue, workingValue, searchValue] = await Promise.all([
      window.bond.memoryCore(),
      window.bond.memoryWorking(),
      window.bond.memorySearch('', 20),
    ])
    core.value = coreValue
    working.value = workingValue
    results.value = searchValue.results
  } catch (err) {
    error.value = message(err)
  } finally {
    loading.value = false
  }
}

async function saveCore(next: CoreMemory) {
  saving.value = true
  error.value = null
  try {
    core.value = await window.bond.memoryUpdateCore(next)
  } catch (err) {
    error.value = message(err)
    throw err
  } finally {
    saving.value = false
  }
}

async function saveWorking(next: WorkingState) {
  saving.value = true
  error.value = null
  try {
    working.value = await window.bond.memoryUpdateWorking(next)
  } catch (err) {
    error.value = message(err)
    throw err
  } finally {
    saving.value = false
  }
}

async function clearWorking() {
  working.value = await window.bond.memoryClearWorking()
}

async function search(query: string, limit = 20) {
  loading.value = true
  error.value = null
  try {
    const value = await window.bond.memorySearch(query, limit)
    results.value = value.results
  } catch (err) {
    error.value = message(err)
  } finally {
    loading.value = false
  }
}

async function upsert(item: MemoryItemInput): Promise<MemoryItem> {
  const saved = await window.bond.memoryUpsert(item)
  await search('', 20)
  return saved
}

async function remove(id: string) {
  const backup = [...results.value]
  results.value = results.value.filter(result => result.item.id !== id)
  try {
    await window.bond.memoryDelete(id)
  } catch (err) {
    results.value = backup
    error.value = message(err)
  }
}

async function loadSources(id: string) {
  sources.value = await window.bond.memorySources(id)
}

const isEmpty = computed(() => results.value.length === 0)

export function useMemory() {
  return {
    core,
    working,
    results,
    sources,
    loading,
    saving,
    error,
    isEmpty,
    loadMemory,
    saveCore,
    saveWorking,
    clearWorking,
    search,
    upsert,
    remove,
    loadSources,
  }
}
