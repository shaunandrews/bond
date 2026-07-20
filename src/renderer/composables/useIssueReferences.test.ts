import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useIssueReferences, resetIssueReferencesForTest } from './useIssueReferences'
import type { CollectionReference } from '../../shared/rpc-schema'

const REFS: CollectionReference[] = [
  { key: 'BOND-1', title: 'First', collectionId: 'c1', itemId: 'i1', prefix: 'BOND', displayNumber: 1, done: false },
  { key: 'BOND-2', title: 'Second', collectionId: 'c1', itemId: 'i2', prefix: 'BOND', displayNumber: 2, done: true },
  { key: 'WP-9', title: 'Other tracker', collectionId: 'c2', itemId: 'i3', prefix: 'WP', displayNumber: 9 },
]

let listMock: ReturnType<typeof vi.fn>
let changeListeners: Array<() => void>

beforeEach(() => {
  resetIssueReferencesForTest()
  changeListeners = []
  listMock = vi.fn().mockResolvedValue(REFS)
  ;(window as unknown as { bond: unknown }).bond = {
    listCollectionReferences: listMock,
    onCollectionsChanged: (fn: () => void) => {
      changeListeners.push(fn)
      return () => { changeListeners = changeListeners.filter(l => l !== fn) }
    },
  }
})

afterEach(() => {
  resetIssueReferencesForTest()
  delete (window as unknown as { bond?: unknown }).bond
})

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('useIssueReferences', () => {
  it('loads references once and derives byKey and knownPrefixes', async () => {
    const { references, byKey, knownPrefixes } = useIssueReferences()
    await flush()

    expect(references.value).toHaveLength(3)
    expect(byKey.value.get('BOND-2')?.title).toBe('Second')
    expect(knownPrefixes.value).toEqual(new Set(['BOND', 'WP']))
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('is a singleton — repeated consumers share one load and one subscription', async () => {
    useIssueReferences()
    useIssueReferences()
    useIssueReferences()
    await flush()

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(changeListeners).toHaveLength(1)
  })

  it('reloads when collections change', async () => {
    const { byKey } = useIssueReferences()
    await flush()

    listMock.mockResolvedValue([
      { key: 'BOND-3', title: 'Fresh', collectionId: 'c1', itemId: 'i4', prefix: 'BOND', displayNumber: 3 },
    ])
    changeListeners.forEach(fn => fn())
    await flush()

    expect(byKey.value.has('BOND-3')).toBe(true)
    expect(byKey.value.has('BOND-1')).toBe(false)
  })

  it('keeps prior data when a reload fails', async () => {
    const { references } = useIssueReferences()
    await flush()
    expect(references.value).toHaveLength(3)

    listMock.mockRejectedValue(new Error('daemon down'))
    changeListeners.forEach(fn => fn())
    await flush()

    expect(references.value).toHaveLength(3)
  })

  it('coalesces concurrent load calls', async () => {
    const { load } = useIssueReferences()
    await Promise.all([load(), load(), load()])
    expect(listMock).toHaveBeenCalledTimes(1)
  })
})
