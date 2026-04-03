import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent } from 'vue'
import { useJournal, type JournalDeps } from './useJournal'
import type { JournalEntry } from '../../shared/session'

const ENTRY_1: JournalEntry = {
  id: 'e1',
  author: 'user',
  title: 'First entry',
  body: 'Hello world',
  tags: ['test'],
  pinned: false,
  createdAt: '2026-04-01T10:00:00Z',
  updatedAt: '2026-04-01T10:00:00Z'
}

const ENTRY_2: JournalEntry = {
  id: 'e2',
  author: 'bond',
  title: 'Bond summary',
  body: 'Session recap',
  tags: ['summary'],
  pinned: true,
  createdAt: '2026-04-02T10:00:00Z',
  updatedAt: '2026-04-02T10:00:00Z'
}

function mockDeps(): JournalDeps {
  return {
    listJournalEntries: vi.fn().mockResolvedValue([ENTRY_1, ENTRY_2]),
    getJournalEntry: vi.fn().mockResolvedValue(ENTRY_1),
    createJournalEntry: vi.fn().mockResolvedValue(ENTRY_1),
    updateJournalEntry: vi.fn().mockResolvedValue({ ...ENTRY_1, title: 'Updated' }),
    deleteJournalEntry: vi.fn().mockResolvedValue(true),
    searchJournalEntries: vi.fn().mockResolvedValue([ENTRY_1]),
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
    journal.select('e1')
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

  it('selects and deselects entries', async () => {
    await journal.load()
    journal.select('e1')
    expect(journal.activeEntryId.value).toBe('e1')
    expect(journal.activeEntry.value).toEqual(ENTRY_1)

    journal.select(null)
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
})
