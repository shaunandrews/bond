import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { Operative, SpawnOperativeOptions } from '../../shared/operative'

export function useOperatives() {
  const operatives = ref<Operative[]>([])
  const activeOperativeId = ref<string | null>(null)
  const loading = ref(false)

  const activeOperative = computed(() =>
    operatives.value.find(o => o.id === activeOperativeId.value) ?? null
  )
  const runningOperatives = computed(() =>
    operatives.value.filter(o => o.status === 'running')
  )
  const queuedOperatives = computed(() =>
    operatives.value.filter(o => o.status === 'queued')
  )
  const runningCount = computed(() =>
    runningOperatives.value.length + queuedOperatives.value.length
  )

  async function load() {
    loading.value = true
    try {
      operatives.value = await window.bond.listOperatives()
    } finally {
      loading.value = false
    }
  }

  async function spawn(opts: SpawnOperativeOptions): Promise<Operative> {
    const op = await window.bond.spawnOperative(opts)
    operatives.value.unshift(op)
    activeOperativeId.value = op.id
    return op
  }

  async function cancel(id: string) {
    await window.bond.cancelOperative(id)
  }

  async function remove(id: string) {
    await window.bond.removeOperative(id)
    operatives.value = operatives.value.filter(o => o.id !== id)
    if (activeOperativeId.value === id) {
      activeOperativeId.value = operatives.value[0]?.id ?? null
    }
  }

  async function clear() {
    await window.bond.clearOperatives()
    await load()
  }

  function select(id: string | null) {
    activeOperativeId.value = id
  }

  let unsub: (() => void) | null = null

  onMounted(() => {
    load()
    unsub = window.bond.onOperativeChanged(() => load())
  })

  onUnmounted(() => unsub?.())

  return {
    operatives,
    activeOperativeId,
    activeOperative,
    runningOperatives,
    queuedOperatives,
    runningCount,
    loading,
    load,
    spawn,
    cancel,
    remove,
    clear,
    select
  }
}
