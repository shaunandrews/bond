import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent } from 'vue'
import { useJournal, type JournalDeps } from './useJournal'
import type { JournalEntry, JournalComment } from '../../shared/session'

const COMMENT_1: JournalComment = {
  id: 'c1',
  entryId: 'e1',
  author: 'bond',
  body: 'Good thoughts',
  createdAt: '2026-04-01T11:00:00Z'
}

const ENTRY_1: JournalEntry = {
  id: 'e1',
  author: 'user',
  title: 'First entry',
  body: 'Hello world',
  tags: ['test'],
  pinned: false,
  comments: [],
  createdAt: '2026-04-01T10:00:00Z',
  updatedAt: '2026-04-01T10:00:00Z'
}

const ENTRY_1_WITH_COMMENTS: JournalEntry = {
  ...ENTRY_1,
  comments: [COMMENT_1]
}

const ENTRY_2: JournalEntry = {
  id: 'e2',
  author: 'bond',
  title: 'Bond summary',
  body: 'Session recap',
  tags: ['summary'],
  pinned: true,
  comments: [],
  createdAt: '2026-04-02T10:00:00Z',
  updatedAt: '2026-04-02T10:00:00Z'
}

function mockDeps(): JournalDeps {
  return {
    listJournalEntries: vi.fn().mockResolvedValue([ENTRY_1, ENTRY_2]),
    getJournalEntry: vi.fn().mockResolvedValue(ENTRY_1_WITH_COMMENTS),
    createJournalEntry: vi.fn().mockResolvedValue(ENTRY_1),
    updateJournalEntry: vi.fn().mockResolvedValue({ ...ENTRY_1, title: 'Updated', comments: [] }),
    deleteJournalEntry: vi.fn().mockResolvedValue(true),
    searchJournalEntries: vi.fn().mockResolvedValue([ENTRY_1]),
    generateJournalMeta: vi.fn().mockResolvedValue(ENTRY_1),
    addJournalComment: vi.fn().mockResolvedValue(COMMENT_1),
    deleteJournalComment: vi.fn().mockResolvedValue(true),
    generateBondComment: vi.fn().mockResolvedValue(COMMENT_1),
    onJournalChanged: vi.fn().mockReturnValue(vi.fn()),
  }
}

type UseJournalReturn = ReturnType<typeof useJournal>

function withSetup(deps: JournalDeps): UseJournalReturn {
  let result!: UseJournalReturn
  const app = createApp(
    defineComponent({
      setup() {
        result = useJournal(deps)
        return () => null
      },
    })
  )
  app.mount(document.createElement('div'))
  return result
}

describe('useJournal', () => {
  let deps: JournalDeps
  let journal: UseJournalReturn

  beforeEach(() => {
    deps = mockDeps()
    journal = withSetup(deps)
  })

  it('starts with empty state', () => {
    expect(journal.entries.value).toEqual([])
    expect(journal.activeEntryId.value).toBeNull()
    expect(journal.loading.value).toBe(false)
  })

  it('loads entries from deps', async () => {
    await journal.load()
    expect(deps.listJournalEntries).toHaveBeenCalled()
    expect(journal.entries.value).toEqual([ENTRY_1, ENTRY_2])
  })

  it('creates an entry and prepends to list', async () => {
    const params = { author: 'user' as const, title: 'First entry', body: 'Hello world' }
    const result = await journal.create(params)
    expect(deps.createJournalEntry).toHaveBeenCalledWith(params)
    expect(result).toEqual(ENTRY_1)
    expect(journal.entries.value[0]).toEqual(ENTRY_1)
  })

  it('updates an entry in-place', async () => {
    await journal.load()
    await journal.update('e1', { title: 'Updated' })
    expect(deps.updateJournalEntry).toHaveBeenCalledWith('e1', { title: 'Updated' })
    expect(journal.entries.value[0].title).toBe('Updated')
  })

  it('removes an entry', async () => {
    await journal.load()
    await journal.select('e1')
    await journal.remove('e1')
    expect(deps.deleteJournalEntry).toHaveBeenCalledWith('e1')
    expect(journal.entries.value).toHaveLength(1)
    expect(journal.activeEntryId.value).toBeNull()
  })

  it('searches entries', async () => {
    await journal.search('hello')
    expect(deps.searchJournalEntries).toHaveBeenCalledWith('hello')
    expect(journal.entries.value).toEqual([ENTRY_1])
  })

  it('selects an entry and loads full data with comments', async () => {
    await journal.load()
    await journal.select('e1')
    expect(journal.activeEntryId.value).toBe('e1')
    expect(deps.getJournalEntry).toHaveBeenCalledWith('e1')
    // Should have loaded comments from getEntry
    expect(journal.activeEntry.value?.comments).toEqual([COMMENT_1])
  })

  it('deselects entry', async () => {
    await journal.load()
    await journal.select('e1')
    await journal.select(null)
    expect(journal.activeEntryId.value).toBeNull()
    expect(journal.activeEntry.value).toBeNull()
  })

  it('computes pinned entries', async () => {
    await journal.load()
    expect(journal.pinnedEntries.value).toEqual([ENTRY_2])
  })

  it('toggles pin', async () => {
    await journal.load()
    await journal.togglePin('e1')
    expect(deps.updateJournalEntry).toHaveBeenCalledWith('e1', { pinned: true })
  })

  it('adds a user comment to an entry', async () => {
    await journal.load()
    await journal.addComment('e1', 'Nice one')
    expect(deps.addJournalComment).toHaveBeenCalledWith('e1', 'user', 'Nice one')
    expect(journal.entries.value[0].comments).toEqual([COMMENT_1])
  })

  it('deletes a comment from an entry', async () => {
    await journal.load()
    // First add a comment so there's one to delete
    await journal.addComment('e1', 'Nice one')
    await journal.deleteComment('e1', 'c1')
    expect(deps.deleteJournalComment).toHaveBeenCalledWith('c1')
    expect(journal.entries.value[0].comments).toEqual([])
  })

  it('requests a Bond comment', async () => {
    await journal.load()
    expect(journal.generatingBondCommentId.value).toBeNull()
    await journal.requestBondComment('e1')
    expect(deps.generateBondComment).toHaveBeenCalledWith('e1')
    expect(journal.entries.value[0].comments).toEqual([COMMENT_1])
    expect(journal.generatingBondCommentId.value).toBeNull()
  })
})
