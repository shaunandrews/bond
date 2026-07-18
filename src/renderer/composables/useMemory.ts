import { ref, computed } from 'vue'
import type { SessionDebrief } from '../../shared/sense'

const debriefs = ref<SessionDebrief[]>([])
const loading = ref(false)

async function loadMemory() {
  loading.value = true
  try {
    const data = await window.bond.senseMemory()
    debriefs.value = data.debriefs
  } catch (err) {
    console.error('Failed to load memory:', err)
  } finally {
    loading.value = false
  }
}

async function deleteDebrief(id: string) {
  const backup = [...debriefs.value]
  debriefs.value = debriefs.value.filter(d => d.id !== id)
  try {
    await window.bond.senseDeleteDebrief(id)
  } catch {
    debriefs.value = backup
  }
}

const isEmpty = computed(() => debriefs.value.length === 0)

export function useMemory() {
  return {
    debriefs,
    loading,
    isEmpty,
    loadMemory,
    deleteDebrief,
  }
}
