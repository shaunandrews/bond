<script setup lang="ts">
import type { SessionDebrief } from '../../shared/sense'
import BondText from './BondText.vue'

defineProps<{
  debrief: SessionDebrief
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function summaryPreview(summary: string): string {
  const firstLine = summary.split('\n')[0] ?? ''
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '...' : firstLine
}
</script>

<template>
  <div class="debrief-card" @click="emit('select', debrief.id)">
    <div class="debrief-header">
      <BondText size="sm" weight="medium" class="debrief-title" truncate>{{ debrief.sessionTitle }}</BondText>
      <BondText size="xs" color="muted" class="debrief-date">{{ formatDate(debrief.createdAt) }}</BondText>
    </div>
    <BondText size="xs" color="muted" class="debrief-summary">{{ summaryPreview(debrief.summary) }}</BondText>
    <div class="debrief-tags" v-if="debrief.topics.length > 0">
      <span v-for="topic in debrief.topics.slice(0, 4)" :key="topic" class="debrief-tag">{{ topic }}</span>
    </div>
  </div>
</template>

<style scoped>
.debrief-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.625rem 0.75rem;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  transition: border-color var(--transition-fast);
}

.debrief-card:hover {
  border-color: var(--color-accent);
}

.debrief-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.debrief-title {
  flex: 1;
  min-width: 0;
}

.debrief-date {
  flex-shrink: 0;
}

.debrief-summary {
  line-height: 1.4;
}

.debrief-tags {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
  margin-top: 0.125rem;
}

.debrief-tag {
  display: inline-block;
  padding: 0.0625rem 0.375rem;
  background: var(--color-tint);
  color: var(--color-muted);
  border-radius: var(--radius-sm);
  font-size: 0.6875rem;
  line-height: 1.4;
}
</style>
