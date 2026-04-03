import { ref, computed } from 'vue'
import type { JournalEntry } from '../../shared/session'

export interface JournalDeps {
  listJournalEntries: (opts?: { author?: string; projectId?: string; tag?: string; limit?: number; offset?: number }) => Promise<JournalEntry[]>
  getJournalEntry: (id: string) => Promise<JournalEntry | null>
  createJournalEntry: (params: { author: 'user' | 'bond'; title: string; body: string; tags?: string[]; projectId?: string; sessionId?: string }) => Promise<JournalEntry>
  updateJournalEntry: (id: string, updates: Partial<Pick<JournalEntry, 'title' | 'body' | 'tags' | 'pinned' | 'projectId'>>) => Promise<JournalEntry | null>
  deleteJournalEntry: (id: string) => Promise<boolean>
  searchJournalEntries: (query: string) => Promise<JournalEntry[]>
  generateJournalMeta: (id: string) => Promise<JournalEntry | null>
  onJournalChanged: (fn: () => void) => () => void
}

export function useJournal(deps: JournalDeps = window.bond) {
  const entries = ref<JournalEntry[]>([])
  const activeEntryId = ref<string | null>(null)
  const loading = ref(false)

  const activeEntry = computed(() =>
    entries.value.find(e => e.id === activeEntryId.value) ?? null
  )

  const pinnedEntries = computed(() =>
    entries.value.filter(e => e.pinned)
  )

  async function load(opts?: { author?: string; projectId?: string; tag?: string; limit?: number }) {
    loading.value = true
    try {
      entries.value = await deps.listJournalEntries(opts)
    } finally {
      loading.value = false
    }
  }

  async function create(params: { author: 'user' | 'bond'; title: string; body: string; tags?: string[]; projectId?: string; sessionId?: string }): Promise<JournalEntry> {
    const entry = await deps.createJournalEntry(params)
    entries.value.unshift(entry)
    return entry
  }

  const generatingMetaId = ref<string | null>(null)

  async function createAndGenerate(body: string, projectId?: string): Promise<JournalEntry> {
    // Create with first-line placeholder title
    const firstLine = body.split('\n')[0].trim()
    const placeholder = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine || 'Untitled'
    const entry = await create({ author: 'user', title: placeholder, body, projectId })
    // Generate title + tags in background
    generatingMetaId.value = entry.id
    deps.generateJournalMeta(entry.id).then(updated => {
      if (updated) {
        const idx = entries.value.findIndex(e => e.id === entry.id)
        if (idx !== -1) entries.value[idx] = updated
      }
    }).finally(() => {
      generatingMetaId.value = null
    })
    return entry
  }

  async function update(id: string, updates: Partial<Pick<JournalEntry, 'title' | 'body' | 'tags' | 'pinned' | 'projectId'>>) {
    const updated = await deps.updateJournalEntry(id, updates)
    if (updated) {
      const idx = entries.value.findIndex(e => e.id === id)
      if (idx !== -1) entries.value[idx] = updated
    }
    return updated
  }

  async function remove(id: string) {
    const ok = await deps.deleteJournalEntry(id)
    if (ok) {
      entries.value = entries.value.filter(e => e.id !== id)
      if (activeEntryId.value === id) activeEntryId.value = null
    }
  }

  async function search(query: string) {
    loading.value = true
    try {
      entries.value = await deps.searchJournalEntries(query)
    } finally {
      loading.value = false
    }
  }

  function select(id: string | null) {
    activeEntryId.value = id
  }

  async function togglePin(id: string) {
    const entry = entries.value.find(e => e.id === id)
    if (entry) {
      await update(id, { pinned: !entry.pinned })
    }
  }

  return {
    entries,
    activeEntryId,
    activeEntry,
    pinnedEntries,
    generatingMetaId,
    loading,
    load,
    create,
    createAndGenerate,
    update,
    remove,
    search,
    select,
    togglePin
  }
}
