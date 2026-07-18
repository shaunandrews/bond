<script setup lang="ts">
import type { SessionDebrief } from '../../shared/sense'
import BondText from './BondText.vue'
import { PhArrowLeft, PhTrash } from '@phosphor-icons/vue'

defineProps<{
  debrief: SessionDebrief
}>()

const emit = defineEmits<{
  back: []
  delete: [id: string]
  openSession: [sessionId: string]
}>()

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

      <section v-if="debrief.topics.length > 0" class="detail-section">
        <BondText size="xs" weight="semibold" color="muted" as="h4" class="section-label">Topics</BondText>
        <div class="topic-list">
          <span v-for="topic in debrief.topics" :key="topic" class="topic-chip">{{ topic }}</span>
        </div>
      </section>

      <section class="detail-section">
        <BondText size="xs" weight="semibold" color="muted" as="h4" class="section-label">Session</BondText>
        <button class="session-link" @click="emit('openSession', debrief.sessionId)">
          <BondText size="sm" color="accent">Open “{{ debrief.sessionTitle }}”</BondText>
        </button>
      </section>

      <div class="detail-divider" />

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

.back-btn,
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
  transition: color var(--transition-fast);
}

.back-btn:hover {
  color: var(--color-text-primary);
}

.delete-btn:hover {
  color: var(--color-err);
}

.detail-title {
  flex: 1;
  min-width: 0;
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

.topic-list {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}

.topic-chip {
  display: inline-block;
  padding: 0.125rem 0.375rem;
  background: var(--color-tint);
  color: var(--color-muted);
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
}

.session-link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}

.session-link:hover {
  opacity: 0.8;
}

.detail-divider {
  border-top: 1px solid var(--color-border);
}

.detail-meta {
  padding-top: 0.25rem;
}
</style>
