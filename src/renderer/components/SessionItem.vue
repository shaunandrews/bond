<script setup lang="ts">
import type { Session } from '../../shared/session'

const props = defineProps<{
  session: Session
  active?: boolean
  archived?: boolean
  generating?: boolean
  actionTitle: string
}>()

const emit = defineEmits<{
  select: []
  action: []
}>()

function formatTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`
  const weeks = Math.floor(diff / 604_800_000)
  if (weeks < 52) return `${weeks}w`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div
    role="button"
    tabindex="0"
    :class="['session-item', { active, archived }]"
    @click="emit('select')"
    @keydown.enter="emit('select')"
    @keydown.space.prevent="emit('select')"
  >
    <span :class="['session-title', { generating }]">
      {{ generating ? 'Naming...' : session.title }}
    </span>
    <span class="session-meta">{{ formatTime(session.updatedAt) }}</span>
    <button
      type="button"
      class="session-action"
      :title="actionTitle"
      @click.stop="emit('action')"
    >
      <slot />
    </button>
  </div>
</template>

<style scoped>
.session-item {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.5rem;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
  position: relative;
}
.session-item:hover {
  background: var(--sidebar-hover-bg);
}
.session-item.active {
  background: var(--sidebar-active-bg);
}

.session-title {
  flex: 1;
  min-width: 0;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--sidebar-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-item.archived .session-title {
  color: var(--sidebar-text-muted);
}
.session-title.generating {
  color: var(--sidebar-text-muted);
  font-style: italic;
}

.session-meta {
  font-size: 0.7rem;
  color: var(--sidebar-text-faint);
  flex-shrink: 0;
  transition: opacity var(--transition-fast);
}

.session-action {
  all: unset;
  cursor: pointer;
  position: absolute;
  right: 0.375rem;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  color: var(--sidebar-text-muted);
  opacity: 0;
  background: var(--sidebar-action-bg);
  transition: opacity var(--transition-fast), background var(--transition-fast);
}
.session-item:hover .session-action {
  opacity: 1;
}
.session-item:hover .session-meta {
  opacity: 0;
}
.session-action:hover {
  background: var(--sidebar-hover-bg);
  color: var(--sidebar-text);
}
</style>
