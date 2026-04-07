import { ref, computed } from 'vue'
import type { CollectionItem, ItemComment } from '../../shared/session'

export interface JournalDeps {
  listJournalEntries: (opts?: { author?: string; projectId?: string; tag?: string; limit?: number; offset?: number }) => Promise<CollectionItem[]>
  getJournalEntry: (id: string) => Promise<CollectionItem | null>
  createJournalEntry: (params: { author: 'user' | 'bond'; title: string; body: string; tags?: string[]; projectId?: string; sessionId?: string }) => Promise<CollectionItem>
  updateJournalEntry: (id: string, updates: Record<string, unknown>) => Promise<CollectionItem | null>
  deleteJournalEntry: (id: string) => Promise<boolean>
  searchJournalEntries: (query: string) => Promise<CollectionItem[]>
  generateJournalMeta: (id: string) => Promise<CollectionItem | null>
  addJournalComment: (entryId: string, author: 'user' | 'bond', body: string) => Promise<ItemComment>
  deleteJournalComment: (id: string) => Promise<boolean>
  generateBondComment: (entryId: string) => Promise<ItemComment>
  onJournalChanged: (fn: () => void) => () => void
}

// Helper to extract journal-specific fields from CollectionItem.data
export function getEntryTitle(item: CollectionItem): string {
  return (item.data.title as string) || 'Untitled'
}
export function getEntryBody(item: CollectionItem): string {
  return (item.data.body as string) || ''
}
export function getEntryAuthor(item: CollectionItem): 'user' | 'bond' {
  return (item.data.author as 'user' | 'bond') || 'user'
}
export function getEntryTags(item: CollectionItem): string[] {
  return (item.data.tags as string[]) || []
}
export function getEntryPinned(item: CollectionItem): boolean {
  return (item.data.pinned as boolean) || false
}
export function getEntryComments(item: CollectionItem): ItemComment[] {
  return item.comments || []
}

export function useJournal(deps: JournalDeps = window.bond) {
  const entries = ref<CollectionItem[]>([])
  const activeEntryId = ref<string | null>(null)
  const loading = ref(false)

  const activeEntry = computed(() =>
    entries.value.find(e => e.id === activeEntryId.value) ?? null
  )

  const pinnedEntries = computed(() =>
    entries.value.filter(e => getEntryPinned(e))
  )

  async function load(opts?: { author?: string; projectId?: string; tag?: string; limit?: number }) {
    loading.value = true
    try {
      entries.value = await deps.listJournalEntries(opts)
    } finally {
      loading.value = false
    }
  }

  async function create(params: { author: 'user' | 'bond'; title: string; body: string; tags?: string[]; projectId?: string; sessionId?: string }): Promise<CollectionItem> {
    const entry = await deps.createJournalEntry(params)
    entries.value.unshift(entry)
    return entry
  }

  const generatingMetaId = ref<string | null>(null)

  async function createAndGenerate(body: string, projectId?: string): Promise<CollectionItem> {
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

  async function update(id: string, updates: Record<string, unknown>) {
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
      await update(id, { pinned: !getEntryPinned(entry) })
    }
  }

  // --- Comments ---

  const generatingBondCommentId = ref<string | null>(null)

  async function addComment(entryId: string, body: string) {
    const comment = await deps.addJournalComment(entryId, 'user', body)
    // Append to the in-memory entry's comments
    const entry = entries.value.find(e => e.id === entryId)
    if (entry) entry.comments = [...(entry.comments || []), comment]
    return comment
  }

  async function deleteCommentFromEntry(entryId: string, commentId: string) {
    const ok = await deps.deleteJournalComment(commentId)
    if (ok) {
      const entry = entries.value.find(e => e.id === entryId)
      if (entry) entry.comments = (entry.comments || []).filter(c => c.id !== commentId)
    }
  }

  async function requestBondComment(entryId: string) {
    generatingBondCommentId.value = entryId
    try {
      const comment = await deps.generateBondComment(entryId)
      const entry = entries.value.find(e => e.id === entryId)
      if (entry) entry.comments = [...(entry.comments || []), comment]
    } finally {
      generatingBondCommentId.value = null
    }
  }

  // When selecting an entry, load full data (with comments) from server
  async function selectAndLoad(id: string | null) {
    activeEntryId.value = id
    if (id) {
      const full = await deps.getJournalEntry(id)
      if (full) {
        const idx = entries.value.findIndex(e => e.id === id)
        if (idx !== -1) entries.value[idx] = full
      }
    }
  }

  return {
    entries,
    activeEntryId,
    activeEntry,
    pinnedEntries,
    generatingMetaId,
    generatingBondCommentId,
    loading,
    load,
    create,
    createAndGenerate,
    update,
    remove,
    search,
    select: selectAndLoad,
    togglePin,
    addComment,
    deleteComment: deleteCommentFromEntry,
    requestBondComment
  }
}
