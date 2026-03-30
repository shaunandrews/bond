<script setup lang="ts">
import { ref } from 'vue'
import { PhPlus, PhCaretRight, PhArrowDown, PhArrowUp } from '@phosphor-icons/vue'
import type { Session } from '../../shared/session'
import type { AppView } from '../composables/useAppView'
import SessionItem from './SessionItem.vue'

const archivesOpen = ref(true)

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
</script>

<template>
  <aside class="session-sidebar">
    <!-- Toolbar row — sits beside traffic lights -->
    <div class="sidebar-toolbar drag-region">
      <button
        type="button"
        @click.stop="emit('create')"
        class="sidebar-btn no-drag"
        title="New chat"
      >
        <PhPlus :size="16" weight="bold" />
      </button>
    </div>

    <!-- Chats list -->
    <div class="sidebar-chats">
      <nav class="sidebar-list">
        <SessionItem
          v-for="s in sessions"
          :key="s.id"
          :session="s"
          :active="s.id === activeSessionId && activeView === 'chat'"
          :generating="generatingTitleId === s.id"
          actionTitle="Archive"
          @select="emit('select', s.id)"
          @action="emit('archive', s.id)"
        >
          <PhArrowDown :size="14" weight="bold" />
        </SessionItem>

        <p v-if="sessions.length === 0" class="text-sm text-muted px-3 py-4">
          No chats yet. Start a new one!
        </p>
      </nav>
    </div>

    <!-- Archives (only when there are archived sessions) -->
    <div v-if="archivedSessions.length" class="sidebar-archives">
      <button class="sidebar-section-header" @click="archivesOpen = !archivesOpen">
        <span class="sidebar-section-title">Archives ({{ archivedSessions.length }})</span>
        <PhCaretRight :class="['collapse-chevron', { open: archivesOpen }]" :size="12" weight="bold" />
      </button>

      <nav v-if="archivesOpen" class="sidebar-list">
        <SessionItem
          v-for="s in archivedSessions"
          :key="s.id"
          :session="s"
          archived
          actionTitle="Unarchive"
          @select="emit('select', s.id)"
          @action="emit('unarchive', s.id)"
        >
          <PhArrowUp :size="14" weight="bold" />
        </SessionItem>
      </nav>
    </div>

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
  border-right: 1px solid var(--sidebar-border);
  background: transparent;
  overflow: hidden;
}

.sidebar-toolbar {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 0.75rem 0.5rem 0.25rem;
  /* macOS traffic lights need ~70px horizontal + some vertical space */
  min-height: 2rem;
}

.sidebar-chats {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.sidebar-archives {
  flex-shrink: 0;
  border-top: 1px solid var(--sidebar-border);
  max-height: 40%;
  display: flex;
  flex-direction: column;
}

.sidebar-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  flex-shrink: 0;
}

button.sidebar-section-header {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  flex-shrink: 0;
  width: 100%;
  box-sizing: border-box;
}

.collapse-chevron {
  color: var(--sidebar-text-faint);
  transition: transform var(--transition-fast);
  transform: rotate(0deg);
}
.collapse-chevron.open {
  transform: rotate(90deg);
}

.sidebar-section-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--sidebar-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.sidebar-nav {
  flex-shrink: 0;
  padding: 0.5rem 0.75rem;
  padding-bottom: 1rem;
  border-top: 1px solid var(--sidebar-border);
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
  color: var(--sidebar-text-muted);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.sidebar-nav-item:hover {
  background: var(--sidebar-hover-bg);
  color: var(--sidebar-text);
}
.sidebar-nav-item.active {
  background: var(--sidebar-active-bg);
  color: var(--sidebar-text);
}

.sidebar-btn {
  all: unset;
  -webkit-app-region: no-drag;
  cursor: pointer;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--sidebar-text-muted);
  transition: background var(--transition-base), color var(--transition-base);
}
.sidebar-btn:hover {
  background: var(--sidebar-hover-bg);
  color: var(--sidebar-text);
}

.sidebar-list {
  overflow-y: auto;
  height: 100%;
  padding: 0.375rem 0.5rem;
}
</style>
