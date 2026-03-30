<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { PhPlus, PhCaretRight, PhArchive, PhArrowLineUp, PhGear } from '@phosphor-icons/vue'
import type { Session } from '../../shared/session'
import type { AppView } from '../composables/useAppView'
import SessionItem from './SessionItem.vue'

const ARCHIVES_KEY = 'bond:archives-open'
const archivesOpen = ref(localStorage.getItem(ARCHIVES_KEY) !== 'false')
watch(archivesOpen, (v) => localStorage.setItem(ARCHIVES_KEY, String(v)))

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

const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)
const menuBtnRef = ref<HTMLElement | null>(null)
const menuPos = ref({ top: '0px', left: '0px' })

async function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value && menuBtnRef.value) {
    const rect = (menuBtnRef.value as HTMLElement).getBoundingClientRect()
    menuPos.value = {
      top: `${rect.bottom + 4}px`,
      left: `${rect.left}px`,
    }
  }
}

function handleClickOutside(e: MouseEvent) {
  if (
    menuOpen.value &&
    menuRef.value &&
    !menuRef.value.contains(e.target as Node) &&
    menuBtnRef.value &&
    !menuBtnRef.value.contains(e.target as Node)
  ) {
    menuOpen.value = false
  }
}

onMounted(() => document.addEventListener('pointerdown', handleClickOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleClickOutside))

function selectView(view: AppView) {
  menuOpen.value = false
  emit('switchView', view)
}
</script>

<template>
  <aside class="session-sidebar">
    <!-- Toolbar row — sits beside traffic lights -->
    <div class="sidebar-toolbar drag-region">
      <button
        ref="menuBtnRef"
        type="button"
        :class="['sidebar-btn no-drag', { active: menuOpen }]"
        title="Menu"
        @click.stop="toggleMenu"
      >
        <PhGear :size="16" weight="bold" />
      </button>

      <Teleport to="body">
        <div
          v-if="menuOpen"
          ref="menuRef"
          class="sidebar-flyout"
          :style="{ top: menuPos.top, left: menuPos.left }"
        >
          <button
            v-for="item in ([
              { id: 'about', label: 'About Bond' },
              { id: 'design-system', label: 'Design System' },
              { id: 'components', label: 'Components' },
              { id: 'settings', label: 'Settings' },
            ] as const)"
            :key="item.id"
            :class="['flyout-item', { active: activeView === item.id }]"
            @click="selectView(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
      </Teleport>
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
          <PhArchive :size="14" weight="bold" />
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
        <span class="collapse-icon">
          <PhCaretRight :class="['collapse-chevron', { open: archivesOpen }]" :size="12" weight="bold" />
        </span>
      </button>

      <div :class="['archives-collapsible', { open: archivesOpen }]">
        <nav class="sidebar-list">
          <SessionItem
            v-for="s in archivedSessions"
            :key="s.id"
            :session="s"
            archived
            actionTitle="Unarchive"
            @select="emit('select', s.id)"
            @action="emit('unarchive', s.id)"
          >
            <PhArrowLineUp :size="14" weight="bold" />
          </SessionItem>
        </nav>
      </div>
    </div>

  </aside>
</template>

<style scoped>
.session-sidebar {
  height: 100%;
  min-width: 220px; /* prevent content reflow during sidebar collapse animation */
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
  padding: 0.75rem 0.75rem 0.25rem;
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
  margin-top: auto;
  border-top: 1px solid var(--sidebar-border);
  max-height: 40%;
  display: flex;
  flex-direction: column;
}

.sidebar-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 0.75rem 0.625rem 1rem;
  flex-shrink: 0;
}

button.sidebar-section-header {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 0.75rem 0.625rem 1rem;
  flex-shrink: 0;
  width: 100%;
  box-sizing: border-box;
  transition: background var(--transition-fast);
}
button.sidebar-section-header:hover {
  background: var(--sidebar-hover-bg);
}

.collapse-icon {
  flex-shrink: 0;
  width: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
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
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--sidebar-text-muted);
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
.sidebar-btn:hover,
.sidebar-btn.active {
  background: var(--sidebar-hover-bg);
  color: var(--sidebar-text);
}

.archives-collapsible {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--transition-base);
  min-height: 0;
}
.archives-collapsible.open {
  grid-template-rows: 1fr;
}
.archives-collapsible > .sidebar-list {
  overflow: hidden;
  min-height: 0;
}

.sidebar-list {
  overflow-y: auto;
  height: 100%;
  padding: 0.375rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

</style>

<style>
.sidebar-flyout {
  position: fixed;
  min-width: 10rem;
  padding: 0.25rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  z-index: 100;
}

.flyout-item {
  all: unset;
  cursor: pointer;
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 0.4rem 0.625rem;
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text-primary);
  transition: background var(--transition-fast);
}
.flyout-item:hover {
  background: var(--sidebar-hover-bg);
}
.flyout-item.active {
  color: var(--color-accent);
}
</style>
