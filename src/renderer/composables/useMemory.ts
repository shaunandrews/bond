import { ref, computed } from 'vue'
import type { SessionDebrief, SenseFact, OpenThread, DecisionWithContext } from '../../shared/sense'

// Singleton state
const facts = ref<SenseFact[]>([])
const threads = ref<OpenThread[]>([])
const decisions = ref<DecisionWithContext[]>([])
const debriefs = ref<SessionDebrief[]>([])
const loading = ref(false)

async function loadMemory() {
  loading.value = true
  try {
    const [memData, threadData, decisionData] = await Promise.all([
      window.bond.senseMemory(),
      window.bond.senseThreads(),
      window.bond.senseDecisions(),
    ])
    facts.value = memData.facts
    debriefs.value = memData.debriefs
    threads.value = threadData
    decisions.value = decisionData
  } catch (err) {
    console.error('Failed to load memory:', err)
  } finally {
    loading.value = false
  }
}

async function forgetFact(id: string) {
  const backup = [...facts.value]
  facts.value = facts.value.filter(f => f.id !== id)
  try {
    await window.bond.senseForget(id)
  } catch {
    facts.value = backup
  }
}

async function updateFact(id: string, text: string) {
  try {
    const updated = await window.bond.senseUpdateFact(id, text)
    const idx = facts.value.findIndex(f => f.id === id)
    if (idx >= 0) facts.value[idx] = updated
  } catch (err) {
    console.error('Failed to update fact:', err)
  }
}

async function pinFact(factText: string, projectId?: string) {
  try {
    const created = await window.bond.senseRemember(factText, projectId)
    facts.value.unshift(created)
  } catch (err) {
    console.error('Failed to pin fact:', err)
  }
}

async function dismissThread(debriefId: string, thread: string) {
  const backup = [...threads.value]
  threads.value = threads.value.filter(t => !(t.debriefId === debriefId && t.thread === thread))
  try {
    await window.bond.senseDismissThread(debriefId, thread)
  } catch {
    threads.value = backup
  }
}

async function removeDecision(debriefId: string, decision: string) {
  const backup = [...decisions.value]
  decisions.value = decisions.value.filter(d => !(d.debriefId === debriefId && d.decision === decision))
  try {
    await window.bond.senseRemoveDecision(debriefId, decision)
  } catch {
    decisions.value = backup
  }
}

async function deleteDebrief(id: string) {
  const backup = [...debriefs.value]
  debriefs.value = debriefs.value.filter(d => d.id !== id)
  // Also remove any threads/decisions sourced from this debrief
  threads.value = threads.value.filter(t => t.debriefId !== id)
  decisions.value = decisions.value.filter(d => d.debriefId !== id)
  try {
    await window.bond.senseDeleteDebrief(id)
  } catch {
    debriefs.value = backup
    // Reload to get consistent state
    await loadMemory()
  }
}

const isEmpty = computed(() =>
  facts.value.length === 0 &&
  threads.value.length === 0 &&
  decisions.value.length === 0 &&
  debriefs.value.length === 0
)

export function useMemory() {
  return {
    facts,
    threads,
    decisions,
    debriefs,
    loading,
    isEmpty,
    loadMemory,
    forgetFact,
    updateFact,
    pinFact,
    dismissThread,
    removeDecision,
    deleteDebrief,
  }
}
