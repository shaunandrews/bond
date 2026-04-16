<script setup lang="ts">
import type { OpenThread } from '../../shared/sense'
import BondText from './BondText.vue'
import { PhArrowRight, PhX } from '@phosphor-icons/vue'

defineProps<{
  thread: OpenThread
}>()

const emit = defineEmits<{
  resume: [sessionId: string]
  dismiss: [debriefId: string, thread: string]
}>()

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="thread-card">
    <div class="thread-top">
      <BondText size="sm" class="thread-text">{{ thread.thread }}</BondText>
      <button class="thread-dismiss" @click.stop="emit('dismiss', thread.debriefId, thread.thread)" v-tooltip="'Dismiss'">
        <PhX :size="12" />
      </button>
    </div>
    <div class="thread-footer">
      <BondText size="xs" color="muted">
        From "{{ thread.sessionTitle }}" &middot; {{ formatDate(thread.createdAt) }}
      </BondText>
      <button class="thread-resume" @click.stop="emit('resume', thread.sessionId)">
        <BondText size="xs" color="accent">Resume</BondText>
        <PhArrowRight :size="12" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.thread-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.625rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.thread-top {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.thread-text {
  flex: 1;
  min-width: 0;
  line-height: 1.4;
}

.thread-dismiss {
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
  transition: color var(--transition-fast);
}

.thread-dismiss:hover {
  color: var(--color-err);
}

.thread-card:hover .thread-dismiss {
  display: flex;
}

.thread-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.thread-resume {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent);
  cursor: pointer;
  white-space: nowrap;
  transition: opacity var(--transition-fast);
}

.thread-resume:hover {
  opacity: 0.8;
}
</style>
