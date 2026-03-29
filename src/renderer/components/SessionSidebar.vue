<script setup lang="ts">
import type { Session } from '../../shared/session'
import type { AppView } from '../composables/useAppView'
import BondPanelGroup from './BondPanelGroup.vue'
import BondPanel from './BondPanel.vue'
import BondPanelHandle from './BondPanelHandle.vue'

defineProps<{
  sessions: Session[]
  archivedSessions: Session[]
  activeSessionId: string | null
  activeView: AppView
  generatingTitleId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  create: []
  archive: [id: string]
  unarchive: [id: string]
  remove: [id: string]
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
    <!-- Resizable chats + archives area -->
    <BondPanelGroup direction="vertical" autoSaveId="sidebar-panels" class="sidebar-panels">
      <!-- Chats -->
      <BondPanel id="chats" :defaultSize="65" :minSize="20" header="Chats">
        <template #header-extra>
          <button
            type="button"
            @click.stop="emit('create')"
            class="sidebar-btn"
            title="New chat"
          >
            +
          </button>
        </template>

        <nav class="sidebar-list">
          <div
            v-for="s in sessions"
            :key="s.id"
            role="button"
            tabindex="0"
            :class="['session-item', { active: s.id === activeSessionId && activeView === 'chat' }]"
            @click="emit('select', s.id)"
            @keydown.enter="emit('select', s.id)"
            @keydown.space.prevent="emit('select', s.id)"
          >
            <span :class="['session-title', { 'generating': generatingTitleId === s.id }]">
              {{ generatingTitleId === s.id ? 'Naming...' : s.title }}
            </span>
            <span class="session-meta">{{ formatDate(s.updatedAt) }}</span>
            <button
              type="button"
              class="session-action"
              title="Archive"
              @click.stop="emit('archive', s.id)"
            >
              &darr;
            </button>
          </div>

          <p v-if="sessions.length === 0" class="text-sm text-muted px-3 py-4">
            No chats yet. Start a new one!
          </p>
        </nav>
      </BondPanel>

      <!-- Archives (collapsible, only when there are archived sessions) -->
      <template v-if="archivedSessions.length">
        <BondPanelHandle id="handle-0" />

        <BondPanel
          id="archives"
          :defaultSize="35"
          :minSize="10"
          collapsible
          :collapsedSize="0"
          :header="`Archives (${archivedSessions.length})`"
        >
          <nav class="sidebar-list">
            <div
              v-for="s in archivedSessions"
              :key="s.id"
              role="button"
              tabindex="0"
              class="session-item archived"
              @click="emit('select', s.id)"
              @keydown.enter="emit('select', s.id)"
              @keydown.space.prevent="emit('select', s.id)"
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
            </div>
          </nav>
        </BondPanel>
      </template>
    </BondPanelGroup>

    <!-- Nav links — not in a panel, just fits content -->
    <div class="sidebar-nav">
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
  height: 100%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-surface);
  overflow: hidden;
  padding-top: 2rem;
}

.sidebar-panels {
  flex: 1;
  min-height: 0;
}

.sidebar-nav {
  flex-shrink: 0;
  padding: 0.5rem 0.75rem;
  padding-bottom: 1rem;
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
  width: 24px;
  height: 24px;
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
  overflow-y: auto;
  height: 100%;
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
.session-title.generating {
  color: var(--color-muted);
  font-style: italic;
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
</style>
