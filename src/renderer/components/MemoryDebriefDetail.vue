<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SessionDebrief } from '../../shared/sense'
import BondText from './BondText.vue'
import { PhArrowLeft, PhPushPin, PhTrash } from '@phosphor-icons/vue'

const props = defineProps<{
  debrief: SessionDebrief
}>()

const emit = defineEmits<{
  back: []
  pinFact: [fact: string]
  delete: [id: string]
}>()

const pinnedFacts = ref(new Set<string>())

function handlePinFact(fact: string) {
  if (pinnedFacts.value.has(fact)) return
  pinnedFacts.value.add(fact)
  emit('pinFact', fact)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.round(seconds / 60)
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

const hasSections = computed(() =>
  props.debrief.decisions.length > 0 ||
  props.debrief.openThreads.length > 0 ||
  props.debrief.keyFacts.length > 0
)
</script>

<template>
  <div class="debrief-detail">
    <div class="debrief-detail-header">
      <button class="back-btn" @click="emit('back')">
        <PhArrowLeft :size="16" />
      </button>
      <BondText size="sm" weight="medium" truncate class="detail-title">{{ debrief.sessionTitle }}</BondText>
      <button class="delete-btn" @click="emit('delete', debrief.id)" v-tooltip="'Delete debrief'">
        <PhTrash :size="14" />
      </button>
    </div>

    <div class="debrief-detail-body">
      <section class="detail-section">
        <BondText size="xs" weight="semibold" color="muted" as="h4" class="section-label">Summary</BondText>
        <BondText size="sm" class="detail-text">{{ debrief.summary }}</BondText>
      </section>

      <section v-if="debrief.decisions.length > 0" class="detail-section">
        <BondText size="xs" weight="semibold" color="muted" as="h4" class="section-label">Decisions</BondText>
        <ul class="detail-list">
          <li v-for="(d, i) in debrief.decisions" :key="i">
            <BondText size="sm">{{ d }}</BondText>
          </li>
        </ul>
      </section>

      <section v-if="debrief.openThreads.length > 0" class="detail-section">
        <BondText size="xs" weight="semibold" color="muted" as="h4" class="section-label">Open Threads</BondText>
        <ul class="detail-list">
          <li v-for="(t, i) in debrief.openThreads" :key="i">
            <BondText size="sm">{{ t }}</BondText>
          </li>
        </ul>
      </section>

      <section v-if="debrief.keyFacts.length > 0" class="detail-section">
        <BondText size="xs" weight="semibold" color="muted" as="h4" class="section-label">Key Facts</BondText>
        <ul class="detail-list facts-list">
          <li v-for="(f, i) in debrief.keyFacts" :key="i" class="fact-row">
            <BondText size="sm" class="fact-row-text">{{ f }}</BondText>
            <button
              class="pin-btn"
              :class="{ pinned: pinnedFacts.has(f) }"
              @click.stop="handlePinFact(f)"
              v-tooltip="pinnedFacts.has(f) ? 'Pinned' : 'Pin to memory'"
            >
              <PhPushPin :size="12" :weight="pinnedFacts.has(f) ? 'fill' : 'regular'" />
            </button>
          </li>
        </ul>
      </section>

      <div v-if="hasSections" class="detail-divider" />

      <div class="detail-meta">
        <BondText size="xs" color="muted">
          {{ debrief.messageCount }} messages &middot;
          {{ formatDuration(debrief.durationSeconds) }} &middot;
          {{ formatDate(debrief.createdAt) }}
        </BondText>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debrief-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.debrief-detail-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  background: none;
  color: var(--color-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast);
}

.back-btn:hover {
  color: var(--color-text-primary);
}

.detail-title {
  flex: 1;
  min-width: 0;
}

.delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  background: none;
  color: var(--color-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  transition: color var(--transition-fast);
}

.delete-btn:hover {
  color: var(--color-err);
}

.debrief-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.section-label {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.detail-text {
  line-height: 1.5;
  white-space: pre-wrap;
}

.detail-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.detail-list li {
  position: relative;
  padding-left: 0.875rem;
  line-height: 1.4;
}

.detail-list li::before {
  content: '\2022';
  position: absolute;
  left: 0;
  color: var(--color-muted);
}

.fact-row {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
}

.fact-row-text {
  flex: 1;
  min-width: 0;
}

.pin-btn {
  display: none;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  background: none;
  color: var(--color-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  margin-top: 2px;
  transition: color var(--transition-fast);
}

.pin-btn:hover {
  color: var(--color-accent);
}

.pin-btn.pinned {
  display: flex;
  color: var(--color-accent);
}

.facts-list .fact-row:hover .pin-btn {
  display: flex;
}

.detail-divider {
  border-top: 1px solid var(--color-border);
}

.detail-meta {
  padding-top: 0.25rem;
}
</style>
