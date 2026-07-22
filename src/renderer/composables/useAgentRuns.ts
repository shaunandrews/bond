import { computed, ref } from 'vue'
import type { AgentRun, AgentRunDetail } from '../../shared/agent-runs'
import type { TaggedChunk } from '../../shared/stream'

export interface AgentRunSurface {
  listAgentRuns(): Promise<{ runs: AgentRun[] }>
  getAgentRun(runId: string): Promise<AgentRunDetail | null>
  cancelAgentRun(runId: string): Promise<AgentRun | null>
  answerAgentRunQuestion(runId: string, questionId: string, approved: boolean, response?: string): Promise<{ run: AgentRun }>
  discardAgentRunWorkspace(runId: string): Promise<AgentRun>
  applyAgentRunUpdate?(runId: string, confirmed?: boolean): Promise<unknown>
  onChunk(fn: (chunk: TaggedChunk) => void): () => void
}

const runs = ref<AgentRun[]>([])
const details = ref<Map<string, AgentRunDetail>>(new Map())
const loading = ref(false)
const errors = ref<Map<string, string>>(new Map())
let started = false
let unsubscribe: (() => void) | undefined

const terminal = new Set(['succeeded', 'failed', 'cancelled'])
const activeRuns = computed(() => runs.value.filter(run => !terminal.has(run.status)))
const recentRuns = computed(() => [...runs.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))

function replaceRun(run: AgentRun): void {
  const next = runs.value.filter(item => item.id !== run.id)
  next.push(run)
  runs.value = next
}

async function refreshDetail(surface: AgentRunSurface, runId: string): Promise<void> {
  try {
    const detail = await surface.getAgentRun(runId)
    if (!detail) return
    replaceRun(detail.run)
    details.value = new Map(details.value).set(runId, detail)
  } catch { /* keep the last durable snapshot */ }
}

async function reconcile(surface: AgentRunSurface): Promise<void> {
  loading.value = true
  try {
    const result = await surface.listAgentRuns()
    runs.value = result.runs
    await Promise.all(result.runs.map(run => refreshDetail(surface, run.id)))
  } finally {
    loading.value = false
  }
}

async function action(surface: AgentRunSurface, runId: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    errors.value = new Map(errors.value).set(runId, '')
    await operation()
    await refreshDetail(surface, runId)
  } catch (error) {
    errors.value = new Map(errors.value).set(runId, error instanceof Error ? error.message : String(error))
  }
}

function start(surface: AgentRunSurface): void {
  if (started) return
  started = true
  void reconcile(surface)
  unsubscribe = surface.onChunk(chunk => {
    if (chunk.kind !== 'agent_run_changed') return
    replaceRun(chunk.run)
    void refreshDetail(surface, chunk.run.id)
  })
}

export function resetAgentRunsForTest(): void {
  unsubscribe?.()
  unsubscribe = undefined
  started = false
  runs.value = []
  details.value = new Map()
  errors.value = new Map()
  loading.value = false
}

export function useAgentRuns(surface?: AgentRunSurface) {
  const resolved = surface ?? (typeof window !== 'undefined' ? window.bond : undefined)
  if (resolved) start(resolved)
  return {
    runs,
    details,
    errors,
    loading,
    activeRuns,
    recentRuns,
    reconcile: () => resolved ? reconcile(resolved) : Promise.resolve(),
    refresh: (runId: string) => resolved ? refreshDetail(resolved, runId) : Promise.resolve(),
    cancel: (runId: string) => resolved
      ? action(resolved, runId, () => resolved.cancelAgentRun(runId))
      : Promise.resolve(),
    answer: (runId: string, questionId: string, approved: boolean, response = '') => resolved
      ? action(resolved, runId, () => resolved.answerAgentRunQuestion(runId, questionId, approved, response))
      : Promise.resolve(),
    discard: (runId: string) => resolved
      ? action(resolved, runId, () => resolved.discardAgentRunWorkspace(runId))
      : Promise.resolve(),
    applyUpdate: (runId: string, confirmed = false) => resolved?.applyAgentRunUpdate
      ? action(resolved, runId, () => resolved.applyAgentRunUpdate!(runId, confirmed))
      : Promise.resolve(),
  }
}
