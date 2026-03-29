<script setup lang="ts">
import type { Session } from '../../shared/session'

defineProps<{
  sessions: Session[]
  archivedSessions: Session[]
  activeSessionId: string | null
  showArchived: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  create: []
  archive: [id: string]
  unarchive: [id: string]
  remove: [id: string]
  toggleArchived: []
}>()

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
</script>

<template>
  <aside class="session-sidebar">
    <div class="sidebar-header">
      <span class="text-sm font-semibold text-muted uppercase tracking-wide">Chats</span>
      <button
        type="button"
        @click="emit('create')"
        class="sidebar-btn"
        title="New chat"
      >
        +
      </button>
    </div>

    <nav class="sidebar-list">
      <button
        v-for="s in sessions"
        :key="s.id"
        type="button"
        :class="['session-item', { active: s.id === activeSessionId }]"
        @click="emit('select', s.id)"
      >
        <span class="session-title">{{ s.title }}</span>
        <span class="session-meta">{{ formatDate(s.updatedAt) }}</span>
        <button
          type="button"
          class="session-action"
          title="Archive"
          @click.stop="emit('archive', s.id)"
        >
          &darr;
        </button>
      </button>

      <p v-if="sessions.length === 0" class="text-sm text-muted px-3 py-4">
        No chats yet. Start a new one!
      </p>
    </nav>

    <div class="sidebar-footer">
      <button
        type="button"
        class="sidebar-toggle"
        @click="emit('toggleArchived')"
      >
        {{ showArchived ? 'Hide' : 'Show' }} archived ({{ archivedSessions.length }})
      </button>

      <nav v-if="showArchived && archivedSessions.length" class="sidebar-list">
        <button
          v-for="s in archivedSessions"
          :key="s.id"
          type="button"
          class="session-item archived"
          @click="emit('select', s.id)"
        >
          <span class="session-title">{{ s.title }}</span>
          <span class="session-meta">{{ formatDate(s.updatedAt) }}</span>
          <button
            type="button"
            class="session-action"
            title="Unarchive"
            @click.stop="emit('unarchive', s.id)"
          >
            &uarr;
          </button>
        </button>
      </nav>
    </div>
  </aside>
</template>

<style scoped>
.session-sidebar {
  width: 260px;
  min-width: 260px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-surface);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 0.75rem 0.5rem;
}

.sidebar-btn {
  all: unset;
  cursor: pointer;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--color-muted);
  transition: background 0.15s, color 0.15s;
}
.sidebar-btn:hover {
  background: color-mix(in srgb, var(--color-border) 60%, transparent);
  color: var(--color-text-primary);
}

.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem 0.5rem;
}

.session-item {
  all: unset;
  cursor: pointer;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.5rem;
  border-radius: 6px;
  transition: background 0.12s;
  position: relative;
}
.session-item:hover {
  background: color-mix(in srgb, var(--color-border) 40%, transparent);
}
.session-item.active {
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
}

.session-title {
  flex: 1;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-item.archived .session-title {
  color: var(--color-muted);
}

.session-meta {
  font-size: 0.7rem;
  color: var(--color-muted);
  flex-shrink: 0;
}

.session-action {
  all: unset;
  cursor: pointer;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 0.75rem;
  color: var(--color-muted);
  opacity: 0;
  transition: opacity 0.12s, background 0.12s;
}
.session-item:hover .session-action {
  opacity: 1;
}
.session-action:hover {
  background: color-mix(in srgb, var(--color-border) 60%, transparent);
  color: var(--color-text-primary);
}

.sidebar-footer {
  border-top: 1px solid var(--color-border);
  padding: 0.5rem;
}

.sidebar-toggle {
  all: unset;
  cursor: pointer;
  display: block;
  width: 100%;
  text-align: center;
  font-size: 0.75rem;
  color: var(--color-muted);
  padding: 0.35rem 0;
  border-radius: 4px;
  transition: color 0.15s;
}
.sidebar-toggle:hover {
  color: var(--color-text-primary);
}
</style>
