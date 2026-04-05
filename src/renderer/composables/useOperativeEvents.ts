import { ref, watch, onMounted, onUnmounted, type Ref } from 'vue'
import type { OperativeEvent } from '../../shared/operative'

export function useOperativeEvents(operativeId: Ref<string | null>) {
  const events = ref<OperativeEvent[]>([])
  const loading = ref(false)

  let unsubEvent: (() => void) | null = null

  async function loadEvents(id: string) {
    loading.value = true
    try {
      events.value = await window.bond.getOperativeEvents(id, undefined, 500)
    } finally {
      loading.value = false
    }
  }

  function setupListener() {
    unsubEvent?.()
    unsubEvent = window.bond.onOperativeEvent((payload) => {
      if (payload.operativeId === operativeId.value) {
        events.value = [...events.value, payload.event]
      }
    })
  }

  watch(operativeId, (id) => {
    if (id) {
      loadEvents(id)
    } else {
      events.value = []
    }
  })

  onMounted(() => {
    setupListener()
    if (operativeId.value) {
      loadEvents(operativeId.value)
    }
  })

  onUnmounted(() => {
    unsubEvent?.()
  })

  return { events, loading }
}
