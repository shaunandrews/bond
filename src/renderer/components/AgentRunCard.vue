<script setup lang="ts">
import { computed } from 'vue'
import { PhArrowSquareOut, PhCheckCircle, PhCircleNotch, PhListBullets, PhQuestion, PhStop, PhWarning } from '@phosphor-icons/vue'
import type { AgentRunCardData } from '../../shared/agent-runs'
import { useAgentRuns } from '../composables/useAgentRuns'
import { agentEventLabel, agentRunElapsed, agentRunStatusLabel, ACTIVE_AGENT_RUN_STATES } from '../lib/agentRuns'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'

const props = defineProps<{ data: AgentRunCardData; fallbackText: string }>()
const store = useAgentRuns()
const run = computed(() => store.runs.value.find(item => item.id === props.data.runId))
const detail = computed(() => store.details.value.get(props.data.runId))
const status = computed(() => run.value?.status ?? props.data.status)
const latest = computed(() => detail.value?.events.at(-1))
const pendingQuestion = computed(() => detail.value?.questions.find(question => question.status === 'pending'))
const publication = computed(() => detail.value?.publication)
const isActive = computed(() => ACTIVE_AGENT_RUN_STATES.has(status.value))

function openTasks() {
  window.dispatchEvent(new CustomEvent('bond:show-agent-run', { detail: props.data.runId }))
}

function openPr(url: string) { void window.bond.openExternal(url) }
</script>

<template>
  <article class="agent-run-card" :class="`agent-run-card--${status}`" :aria-label="`${data.agentLabel} ${agentRunStatusLabel(status)}`">
    <div class="agent-run-card-icon" aria-hidden="true">
      <PhCircleNotch v-if="isActive && status !== 'needs-input'" :size="18" class="agent-run-spin" />
      <PhQuestion v-else-if="status === 'needs-input'" :size="18" />
      <PhCheckCircle v-else-if="status === 'succeeded'" :size="18" />
      <PhStop v-else-if="status === 'cancelled'" :size="18" />
      <PhWarning v-else :size="18" />
    </div>
    <div class="agent-run-card-body">
      <div class="agent-run-card-heading">
        <BondText size="sm" weight="medium">{{ run?.agentLabel ?? data.agentLabel }} · {{ run?.verb ?? data.verb }}</BondText>
        <span class="agent-run-card-status">{{ agentRunStatusLabel(status) }}</span>
      </div>
      <BondText size="xs" color="muted" class="agent-run-card-progress">
        {{ latest ? agentEventLabel(latest) : fallbackText }}<template v-if="run"> · {{ agentRunElapsed(run) }}</template>
      </BondText>
      <div v-if="pendingQuestion" class="agent-run-card-question">
        <BondText size="xs">{{ pendingQuestion.reason }}</BondText>
        <div class="agent-run-card-actions">
          <BondButton size="sm" variant="primary" @click="store.answer(data.runId, pendingQuestion.id, true)">Allow once</BondButton>
          <BondButton size="sm" variant="ghost" @click="store.answer(data.runId, pendingQuestion.id, false)">Deny</BondButton>
        </div>
      </div>
      <BondText v-if="store.errors.value.get(data.runId)" size="xs" color="err">{{ store.errors.value.get(data.runId) }}</BondText>
      <div class="agent-run-card-actions">
        <BondButton size="sm" variant="ghost" @click="openTasks"><PhListBullets :size="13" /> Details</BondButton>
        <BondButton v-if="isActive" size="sm" variant="ghost" @click="store.cancel(data.runId)"><PhStop :size="13" /> Cancel</BondButton>
        <BondButton v-if="publication?.prUrl ?? data.prUrl" size="sm" variant="ghost" @click="openPr((publication?.prUrl ?? data.prUrl)!)"><PhArrowSquareOut :size="13" /> Draft PR</BondButton>
      </div>
    </div>
  </article>
</template>

<style scoped>
.agent-run-card { align-self: stretch; display: flex; gap: .625rem; margin: .25rem .875rem; padding: .75rem; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--color-surface) 86%, transparent); }
.agent-run-card--needs-input { border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border)); }
.agent-run-card--failed { border-color: color-mix(in srgb, var(--color-err) 45%, var(--color-border)); }
.agent-run-card-icon { color: var(--color-muted); padding-top: .1rem; }
.agent-run-card--succeeded .agent-run-card-icon { color: var(--color-ok); }
.agent-run-card--failed .agent-run-card-icon { color: var(--color-err); }
.agent-run-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .35rem; }
.agent-run-card-heading { display: flex; justify-content: space-between; gap: .5rem; align-items: center; }
.agent-run-card-status { flex: none; font-size: .6875rem; color: var(--color-muted); }
.agent-run-card-progress { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-run-card-question { display: flex; flex-direction: column; gap: .4rem; padding: .5rem; border-radius: var(--radius-md); background: var(--color-tint); }
.agent-run-card-actions { display: flex; flex-wrap: wrap; gap: .25rem; }
.agent-run-spin { animation: agent-run-spin 1.1s linear infinite; }
@keyframes agent-run-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .agent-run-spin { animation: none; } }
@container (max-width: 420px) { .agent-run-card { margin-inline: .25rem; } .agent-run-card-heading { align-items: flex-start; flex-direction: column; gap: .125rem; } }
</style>
