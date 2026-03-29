<script setup lang="ts">
import type { Session } from '../../shared/session'
import type { AppView } from '../composables/useAppView'

defineProps<{
  sessions: Session[]
  archivedSessions: Session[]
  activeSessionId: string | null
  showArchived: boolean
  activeView: AppView
}>()

const emit = defineEmits<{
  select: [id: string]
  create: []
  archive: [id: string]
  unarchive: [id: string]
  remove: [id: string]
  toggleArchived: []
  switchView: [view: AppView]
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
    <!-- Chats section -->
    <div class="sidebar-section-header">
      <span class="sidebar-section-label">Chats</span>
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
        :class="['session-item', { active: s.id === activeSessionId && activeView === 'chat' }]"
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

    <!-- Archives section -->
    <div v-if="archivedSessions.length" class="sidebar-section-divider">
      <button
        type="button"
        class="sidebar-section-label clickable"
        @click="emit('toggleArchived')"
      >
        Archives
        <span class="sidebar-section-count">{{ archivedSessions.length }}</span>
      </button>
    </div>

    <nav v-if="showArchived && archivedSessions.length" class="sidebar-list sidebar-list-archived">
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

    <!-- Dev screens -->
    <div class="sidebar-section-divider">
      <button
        :class="['sidebar-nav-item', { active: activeView === 'design-system' }]"
        @click="emit('switchView', 'design-system')"
      >
        Design System
      </button>
      <button
        :class="['sidebar-nav-item', { active: activeView === 'components' }]"
        @click="emit('switchView', 'components')"
      >
        Components
      </button>
      <button
        :class="['sidebar-nav-item', { active: activeView === 'settings' }]"
        @click="emit('switchView', 'settings')"
      >
        Settings
      </button>
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

.sidebar-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2.75rem 0.75rem 0.5rem;
  -webkit-app-region: drag;
}
.sidebar-header * {
  -webkit-app-region: no-drag;
}

.sidebar-section-label {
  all: unset;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-muted);
}
.sidebar-section-label.clickable {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  transition: color var(--transition-base);
}
.sidebar-section-label.clickable:hover {
  color: var(--color-text-primary);
}
.sidebar-section-count {
  font-size: 0.65rem;
  font-weight: 500;
  opacity: 0.7;
}

.sidebar-section-divider {
  padding: 0.5rem 0.75rem 0.25rem;
  border-top: 1px solid var(--color-border);
}

.sidebar-nav-item {
  all: unset;
  cursor: pointer;
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 0.45rem 0.5rem;
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-muted);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.sidebar-nav-item:hover {
  background: color-mix(in srgb, var(--color-border) 40%, transparent);
  color: var(--color-text-primary);
}
.sidebar-nav-item.active {
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  color: var(--color-text-primary);
}

.sidebar-btn {
  all: unset;
  cursor: pointer;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--color-muted);
  transition: background var(--transition-base), color var(--transition-base);
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
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
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
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  color: var(--color-muted);
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast);
}
.session-item:hover .session-action {
  opacity: 1;
}
.session-action:hover {
  background: color-mix(in srgb, var(--color-border) 60%, transparent);
  color: var(--color-text-primary);
}

.sidebar-list-archived {
  flex: 0;
  padding-bottom: 1rem;
}
</style>
