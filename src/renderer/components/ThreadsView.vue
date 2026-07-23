<script setup lang="ts">
import { onMounted } from 'vue'
import { useThreads } from '../composables/useThreads'
import BondText from './BondText.vue'
import BondToolbar from './BondToolbar.vue'
import { PhChatCircleText } from '@phosphor-icons/vue'

/**
 * Right-panel Threads view — every recent thread in one list, opened from
 * the same panel-icon row as Sense/Library/Memory (plans/chat-threads.md).
 * Selecting a thread opens it in the thread panel via the `open` emit; the
 * window-fit decision stays in App.vue.
 */

const threads = useThreads()

const emit = defineEmits<{
  open: [threadId: string]
}>()

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const mins = Math.round((Date.now() - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function replyLabel(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'}`
}

onMounted(() => {
  void threads.loadRecent(50)
})
</script>

<template>
  <div class="threads-panel">
    <BondToolbar label="Threads" drag blur class="threads-panel-toolbar">
      <template #start>
        <BondText size="sm" weight="medium" color="muted">Threads</BondText>
        <span v-if="threads.recentThreads.value.length" class="threads-panel-badge">{{ threads.recentThreads.value.length }}</span>
      </template>
    </BondToolbar>

    <div class="threads-panel-list">
      <div v-if="!threads.recentThreads.value.length" class="threads-panel-empty">
        <PhChatCircleText :size="24" />
        <BondText size="sm" color="muted" align="center">No threads yet</BondText>
        <BondText size="xs" color="muted" align="center">Use “Discuss” under any Bond response to start one.</BondText>
      </div>
      <button
        v-for="t in threads.recentThreads.value"
        :key="t.id"
        type="button"
        class="threads-panel-row"
        :class="{ 'threads-panel-row--active': t.id === threads.activeThreadId.value }"
        @click="emit('open', t.id)"
      >
        <BondText size="sm" truncate class="threads-panel-row-title">{{ t.title || 'Thread' }}</BondText>
        <span class="threads-panel-row-meta">
          <BondText size="xs" color="muted">{{ replyLabel(t.replyCount) }}</BondText>
          <BondText size="xs" color="muted">·</BondText>
          <BondText size="xs" color="muted">{{ formatWhen(t.updatedAt) }}</BondText>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.threads-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.threads-panel-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  flex-shrink: 0;
}

.threads-panel-badge {
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  min-width: 1.125rem;
  height: 1.125rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.3125rem;
  border-radius: 999px;
  background: var(--color-border);
  color: var(--color-muted);
}

.threads-panel-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0.375rem 0.5rem 0.75rem;
}

.threads-panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  padding: 2.5rem 1rem;
  color: var(--color-muted);
  opacity: 0.8;
}

.threads-panel-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.125rem;
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background var(--transition-fast);
}

.threads-panel-row:hover {
  background: var(--color-tint);
}

.threads-panel-row--active {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
}

.threads-panel-row-title {
  max-width: 100%;
}

.threads-panel-row-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
</style>
