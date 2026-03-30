<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { PhPlus, PhCaretRight, PhArchive, PhArrowLineUp, PhGear, PhArrowSquareOut, PhGlobe } from '@phosphor-icons/vue'
import type { Session } from '../../shared/session'
import type { WordPressSite } from '../../shared/wordpress'
import type { AppView } from '../composables/useAppView'
import SessionItem from './SessionItem.vue'
import BondButton from './BondButton.vue'

const ARCHIVES_KEY = 'bond:archives-open'
const archivesOpen = ref(localStorage.getItem(ARCHIVES_KEY) !== 'false')
watch(archivesOpen, (v) => localStorage.setItem(ARCHIVES_KEY, String(v)))

const WP_KEY = 'bond:wordpress-open'
const wpOpen = ref(localStorage.getItem(WP_KEY) !== 'false')
watch(wpOpen, (v) => localStorage.setItem(WP_KEY, String(v)))

defineProps<{
  sessions: Session[]
  archivedSessions: Session[]
  activeSessionId: string | null
  activeView: AppView
  generatingTitleId: string | null
  wordPressSites: WordPressSite[]
  wordPressAvailable: boolean | null
  wordPressCreating: boolean
  selectedWpSiteId: string | null
  togglingSiteId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  create: []
  archive: [id: string]
  unarchive: [id: string]
  remove: [id: string]
  switchView: [view: AppView]
  wpSelect: [site: WordPressSite]
  wpOpen: [site: WordPressSite]
  wpCreate: []
}>()

const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)
const menuBtnRef = ref<HTMLElement | null>(null)
const menuPos = ref({ top: '0px', left: '0px' })

async function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value && menuBtnRef.value) {
    const el = (menuBtnRef.value as any).$el as HTMLElement
    const rect = el.getBoundingClientRect()
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
    !(menuBtnRef.value as any).$el.contains(e.target as Node)
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
      <BondButton
        ref="menuBtnRef"
        variant="ghost"
        size="sm"
        icon
        title="Menu"
        @click.stop="toggleMenu"
      >
        <PhGear :size="16" weight="bold" />
      </BondButton>

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
      <BondButton
        variant="ghost"
        size="sm"
        icon
        title="New chat"
        @click.stop="emit('create')"
      >
        <PhPlus :size="16" weight="bold" />
      </BondButton>
    </div>

    <!-- WordPress sites -->
    <div v-if="wordPressAvailable" class="sidebar-wordpress">
      <button class="sidebar-section-header" @click="wpOpen = !wpOpen">
        <span class="sidebar-section-title">WordPress ({{ wordPressSites.length }})</span>
        <span class="collapse-icon">
          <PhCaretRight :class="['collapse-chevron', { open: wpOpen }]" :size="12" weight="bold" />
        </span>
      </button>

      <div :class="['wp-collapsible', { open: wpOpen }]">
        <div class="wp-collapsible-inner">
          <div class="wp-site-list">
            <div
              v-for="site in wordPressSites"
              :key="site.id"
              :class="['wp-site-row', { active: site.id === selectedWpSiteId && activeView === 'wordpress' }]"
              @click="emit('wpSelect', site)"
            >
              <span :class="['wp-status-dot', { running: site.running, toggling: togglingSiteId === site.id }]" />
              <span class="wp-site-name">{{ site.name }}</span>
              <BondButton
                class="wp-open-btn"
                variant="ghost"
                size="sm"
                icon
                title="Open in browser"
                @click.stop="emit('wpOpen', site)"
              >
                <PhArrowSquareOut :size="12" weight="bold" />
              </BondButton>
            </div>

            <p v-if="wordPressSites.length === 0" class="wp-empty">No sites yet</p>
          </div>

          <div class="wp-actions">
            <BondButton
              variant="ghost"
              size="sm"
              :disabled="wordPressCreating"
              @click.stop="emit('wpCreate')"
            >
              <PhPlus :size="14" weight="bold" />
              {{ wordPressCreating ? 'Creating...' : 'New site' }}
            </BondButton>
          </div>
        </div>
      </div>
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
        <div class="archives-collapsible-inner">
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


.archives-collapsible {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--transition-base);
  min-height: 0;
}
.archives-collapsible.open {
  grid-template-rows: 1fr;
}
.archives-collapsible-inner {
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

/* WordPress section */
.sidebar-wordpress {
  flex-shrink: 0;
  border-bottom: 1px solid var(--sidebar-border);
}

.wp-collapsible {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--transition-base);
}
.wp-collapsible.open {
  grid-template-rows: 1fr;
}
.wp-collapsible-inner {
  overflow: hidden;
  min-height: 0;
}

.wp-site-list {
  padding: 0 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.wp-site-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast);
}
.wp-site-row:hover {
  background: var(--sidebar-hover-bg);
}
.wp-site-row.active {
  background: var(--sidebar-active-bg);
}

.wp-status-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sidebar-text-faint);
}
.wp-status-dot.running {
  background: var(--color-ok);
}
.wp-status-dot.toggling {
  background: var(--color-accent);
  animation: dot-pulse 1s ease-in-out infinite;
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.wp-site-name {
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
  color: var(--sidebar-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wp-open-btn {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.wp-site-row:hover .wp-open-btn {
  opacity: 1;
}

.wp-empty {
  font-size: 0.75rem;
  color: var(--sidebar-text-muted);
  padding: 0.5rem;
}

.wp-actions {
  padding: 0.25rem 0.5rem 0.5rem;
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
