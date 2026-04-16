<script setup lang="ts">
import type { DecisionWithContext } from '../../shared/sense'
import BondText from './BondText.vue'
import { PhX } from '@phosphor-icons/vue'

defineProps<{
  decision: DecisionWithContext
}>()

const emit = defineEmits<{
  remove: [debriefId: string, decision: string]
}>()

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="decision-item">
    <BondText size="sm" class="decision-text">{{ decision.decision }}</BondText>
    <div class="decision-meta">
      <BondText size="xs" color="muted">({{ decision.sessionTitle }})</BondText>
      <BondText size="xs" color="muted">{{ formatDate(decision.createdAt) }}</BondText>
      <button class="decision-remove" @click.stop="emit('remove', decision.debriefId, decision.decision)" v-tooltip="'Remove'">
        <PhX :size="11" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.decision-item {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.25rem 0;
  line-height: 1.4;
}

.decision-text {
  flex: 1;
  min-width: 0;
}

.decision-meta {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  flex-shrink: 0;
}

.decision-remove {
  display: none;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  background: none;
  color: var(--color-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast);
}

.decision-remove:hover {
  color: var(--color-err);
}

.decision-item:hover .decision-remove {
  display: flex;
}
</style>
