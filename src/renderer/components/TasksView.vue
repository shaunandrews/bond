<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { PhArrowSquareOut, PhCheckCircle, PhCircleNotch, PhQuestion, PhStop, PhTrash, PhWarning } from '@phosphor-icons/vue'
import { useAgentRuns } from '../composables/useAgentRuns'
import { ACTIVE_AGENT_RUN_STATES, agentEventLabel, agentRunElapsed, agentRunStatusLabel, isRawAgentEvent } from '../lib/agentRuns'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'
import BondToolbar from './BondToolbar.vue'

const props = defineProps<{ focusRunId?: string | null }>()
const store = useAgentRuns()
const selectedId = ref<string | null>(props.focusRunId ?? null)
const selected = computed(() => store.recentRuns.value.find(run => run.id === selectedId.value) ?? store.recentRuns.value[0] ?? null)
const detail = computed(() => selected.value ? store.details.value.get(selected.value.id) : undefined)
const latest = computed(() => detail.value?.events.at(-1))
const pendingQuestion = computed(() => detail.value?.questions.find(question => question.status === 'pending'))

watch(() => props.focusRunId, id => { if (id) selectedId.value = id }, { immediate: true })
watch(() => store.recentRuns.value.map(run => run.id).join(','), () => {
  if (!selectedId.value && store.recentRuns.value[0]) selectedId.value = store.recentRuns.value[0].id
})

function moveSelection(delta: number) {
  const list = store.recentRuns.value
  if (!list.length) return
  const current = Math.max(0, list.findIndex(run => run.id === selected.value?.id))
  selectedId.value = list[(current + delta + list.length) % list.length].id
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-agent-run-id="${selectedId.value}"]`)?.focus())
}

function openPr(url: string) { void window.bond.openExternal(url) }

onMounted(() => void store.reconcile())
</script>

<template>
  <section class="tasks-panel" aria-label="Background agent tasks">
    <BondToolbar label="Tasks" drag blur class="tasks-toolbar">
      <template #start>
        <BondText size="sm" weight="medium" color="muted">Tasks</BondText>
        <span v-if="store.activeRuns.value.length" class="tasks-badge" :aria-label="`${store.activeRuns.value.length} active tasks`">{{ store.activeRuns.value.length }}</span>
      </template>
    </BondToolbar>

    <div v-if="!store.recentRuns.value.length && !store.loading.value" class="tasks-empty">
      <PhCheckCircle :size="26" />
      <BondText size="sm" color="muted">No background tasks yet</BondText>
    </div>

    <div v-else class="tasks-layout">
      <div class="tasks-list" role="listbox" aria-label="Agent runs">
        <button
          v-for="run in store.recentRuns.value"
          :key="run.id"
          type="button"
          role="option"
          :aria-selected="run.id === selected?.id"
          :tabindex="run.id === selected?.id ? 0 : -1"
          :data-agent-run-id="run.id"
          class="tasks-row"
          :class="{ 'tasks-row--selected': run.id === selected?.id }"
          @click="selectedId = run.id"
          @keydown.down.prevent="moveSelection(1)"
          @keydown.up.prevent="moveSelection(-1)"
        >
          <PhCircleNotch v-if="ACTIVE_AGENT_RUN_STATES.has(run.status) && run.status !== 'needs-input'" :size="15" class="tasks-spin" />
          <PhQuestion v-else-if="run.status === 'needs-input'" :size="15" />
          <PhCheckCircle v-else-if="run.status === 'succeeded'" :size="15" />
          <PhStop v-else-if="run.status === 'cancelled'" :size="15" />
          <PhWarning v-else :size="15" />
          <span class="tasks-row-copy">
            <BondText size="sm" weight="medium" truncate>{{ run.agentLabel }} · {{ run.verb }}</BondText>
            <BondText size="xs" color="muted" truncate>{{ agentRunStatusLabel(run.status) }} · {{ agentRunElapsed(run) }}</BondText>
          </span>
        </button>
      </div>

      <article v-if="selected" class="tasks-detail" aria-live="polite">
        <div class="tasks-detail-heading">
          <div>
            <BondText as="h2" size="base" weight="semibold">{{ selected.agentLabel }} · {{ selected.verb }}</BondText>
            <BondText size="xs" color="muted">{{ agentRunStatusLabel(selected.status) }} · {{ agentRunElapsed(selected) }}</BondText>
          </div>
          <span class="tasks-state">{{ selected.status }}</span>
        </div>

        <dl class="tasks-facts">
          <div><dt>Latest</dt><dd>{{ agentEventLabel(latest) }}</dd></div>
          <div><dt>Workspace</dt><dd>{{ selected.workspace.isolation === 'worktree' ? selected.workspace.branch : 'Read-only in place' }}</dd></div>
          <div v-if="selected.baseSha"><dt>Base</dt><dd class="mono">{{ selected.baseSha.slice(0, 10) }}</dd></div>
          <div><dt>Budget</dt><dd>{{ selected.resourceCaps.budgetPreset ?? selected.settings.budgetPreset }}</dd></div>
          <div v-if="detail?.publication"><dt>PR</dt><dd>{{ detail.publication.status }}<template v-if="detail.publication.prNumber"> · #{{ detail.publication.prNumber }}</template></dd></div>
        </dl>

        <BondText size="sm" class="tasks-brief">{{ selected.brief }}</BondText>
        <BondText v-if="selected.errorMessage" size="xs" color="err">{{ selected.errorMessage }}</BondText>

        <div v-if="pendingQuestion" class="tasks-question">
          <BondText size="xs" weight="medium">Approval needed</BondText>
          <BondText size="xs">{{ pendingQuestion.proposedAllowlistAddition }}</BondText>
          <BondText size="xs" color="muted">{{ pendingQuestion.reason }}</BondText>
          <div class="tasks-actions">
            <BondButton size="sm" variant="primary" @click="store.answer(selected.id, pendingQuestion.id, true)">Allow once</BondButton>
            <BondButton size="sm" variant="danger" @click="store.answer(selected.id, pendingQuestion.id, false)">Deny</BondButton>
          </div>
        </div>

        <div class="tasks-actions">
          <BondButton v-if="ACTIVE_AGENT_RUN_STATES.has(selected.status)" size="sm" variant="danger" @click="store.cancel(selected.id)"><PhStop :size="13" /> Cancel</BondButton>
          <BondButton v-if="detail?.publication?.prUrl" size="sm" variant="secondary" @click="openPr(detail.publication.prUrl)"><PhArrowSquareOut :size="13" /> Open draft PR</BondButton>
          <BondButton v-if="selected.workspace.isolation === 'worktree' && selected.workspaceState.status === 'retained' && !ACTIVE_AGENT_RUN_STATES.has(selected.status)" size="sm" variant="ghost" @click="store.discard(selected.id)"><PhTrash :size="13" /> Discard worktree</BondButton>
        </div>
        <BondText v-if="store.errors.value.get(selected.id)" size="xs" color="err">{{ store.errors.value.get(selected.id) }}</BondText>

        <section class="tasks-events" aria-label="Run event log">
          <BondText size="xs" weight="semibold" color="muted">Event log</BondText>
          <template v-for="event in [...(detail?.events ?? [])].reverse()" :key="event.id">
            <details v-if="isRawAgentEvent(event)" class="tasks-event tasks-event--raw">
              <summary><span>{{ agentEventLabel(event) }}</span><time>{{ new Date(event.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }}</time></summary>
              <pre>{{ event.rawPayloadAvailable === false ? 'Raw log expired.' : JSON.stringify(event.data, null, 2) }}</pre>
            </details>
            <div v-else class="tasks-event">
              <span>{{ agentEventLabel(event) }}</span>
              <time>{{ new Date(event.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }}</time>
            </div>
          </template>
        </section>
      </article>
    </div>
  </section>
</template>

<style scoped>
.tasks-panel { height: 100%; display: flex; flex-direction: column; overflow: hidden; border-left: 1px solid var(--color-border); background: var(--color-bg); container-type: inline-size; }
.tasks-toolbar { flex: none; }
.tasks-badge { min-width: 1.125rem; height: 1.125rem; padding: 0 .3rem; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; font-size: .6875rem; font-weight: 600; color: var(--color-on-accent); background: var(--color-accent); }
.tasks-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .5rem; color: var(--color-muted); }
.tasks-layout { flex: 1; min-height: 0; overflow: hidden; display: grid; grid-template-rows: minmax(7rem, 35%) 1fr; }
.tasks-list { overflow-y: auto; padding: .4rem; border-bottom: 1px solid var(--color-border); }
.tasks-row { width: 100%; display: flex; gap: .5rem; align-items: center; padding: .5rem; border: 0; border-radius: var(--radius-md); color: var(--color-muted); background: transparent; text-align: left; cursor: pointer; }
.tasks-row:hover, .tasks-row--selected { color: var(--color-text-primary); background: var(--color-tint); }
.tasks-row:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
.tasks-row-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: .1rem; }
.tasks-detail { overflow-y: auto; padding: .75rem; display: flex; flex-direction: column; gap: .75rem; }
.tasks-detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: .5rem; }
.tasks-state { padding: .15rem .4rem; border-radius: 999px; background: var(--color-tint); color: var(--color-muted); font-size: .6875rem; }
.tasks-facts { display: grid; gap: .35rem; margin: 0; }
.tasks-facts div { display: grid; grid-template-columns: 4.25rem 1fr; gap: .5rem; font-size: .75rem; }
.tasks-facts dt { color: var(--color-muted); }.tasks-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }.mono { font-family: var(--font-mono); }
.tasks-brief { padding: .55rem; border-radius: var(--radius-md); background: var(--color-tint); }
.tasks-question { display: flex; flex-direction: column; gap: .35rem; padding: .6rem; border: 1px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-border)); border-radius: var(--radius-md); }
.tasks-actions { display: flex; flex-wrap: wrap; gap: .3rem; }
.tasks-events { display: flex; flex-direction: column; gap: .2rem; }
.tasks-event { display: flex; justify-content: space-between; gap: .5rem; padding: .35rem .1rem; border-bottom: 1px solid var(--color-border); font-size: .72rem; color: var(--color-muted); }
.tasks-event time { flex: none; }.tasks-event summary { width: 100%; display: flex; justify-content: space-between; cursor: pointer; }.tasks-event pre { max-height: 12rem; overflow: auto; white-space: pre-wrap; font-size: .6875rem; }
.tasks-event--raw { display: block; }
.tasks-spin { animation: tasks-spin 1.1s linear infinite; } @keyframes tasks-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .tasks-spin { animation: none; } }
@container (max-width: 300px) { .tasks-layout { display: block; overflow-y: auto; }.tasks-list { max-height: 11rem; }.tasks-detail { overflow: visible; }.tasks-facts div { grid-template-columns: 3.5rem 1fr; } }
</style>
