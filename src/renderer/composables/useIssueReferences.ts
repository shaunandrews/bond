import { ref, computed } from 'vue'
import type { CollectionReference } from '../../shared/rpc-schema'

/**
 * Singleton issue-reference index — one `collection.listReferences` RPC feeds
 * composer autocomplete, message chips, and hover cards. Previously ChatInput
 * and every MessageBubble instance each re-scanned all collections and items.
 *
 * Consumers MUST gate key decoration on `knownPrefixes`/`byKey`: the bare
 * PREFIX-n pattern also matches prose like "UTF-8" and "HTTP-2".
 */

const references = ref<CollectionReference[]>([])

const byKey = computed(() => new Map(references.value.map(r => [r.key, r])))
const knownPrefixes = computed(() => new Set(references.value.map(r => r.prefix)))

let started = false
let unsubscribe: (() => void) | undefined
let pending: Promise<void> | null = null

async function load(): Promise<void> {
  if (pending) return pending
  pending = (async () => {
    try {
      references.value = await window.bond.listCollectionReferences()
    } catch {
      /* references stay stale/empty when the daemon is unavailable */
    } finally {
      pending = null
    }
  })()
  return pending
}

function start(): void {
  if (started) return
  started = true
  void load()
  try {
    unsubscribe = window.bond.onCollectionsChanged(() => { void load() })
  } catch { /* compatibility test surfaces may not expose events */ }
}

/** Test-only: drop singleton state so each test starts cold. */
export function resetIssueReferencesForTest(): void {
  started = false
  pending = null
  references.value = []
  unsubscribe?.()
  unsubscribe = undefined
}

export function useIssueReferences() {
  start()
  return { references, byKey, knownPrefixes, load }
}
