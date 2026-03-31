<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { PhPlus, PhCaretRight, PhArchive, PhArrowLineUp, PhGear } from '@phosphor-icons/vue'
import type { Session } from '../../shared/session'
import type { WordPressSite } from '../../shared/wordpress'
import type { AppView } from '../composables/useAppView'
import SessionItem from './SessionItem.vue'
import BondToolbar from './BondToolbar.vue'
import BondButton from './BondButton.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import SiteStatusButton from './SiteStatusButton.vue'

const WP_KEY = 'bond:wordpress-open'
const wpOpen = ref(localStorage.getItem(WP_KEY) !== 'false')
watch(wpOpen, (v) => localStorage.setItem(WP_KEY, String(v)))

const props = defineProps<{
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

const chatCount = computed(() => props.sessions.length)

/* Archive flyout */
const archiveFlyoutOpen = ref(false)
const archiveBtnRef = ref<HTMLElement | null>(null)

function toggleArchiveFlyout() {
  archiveFlyoutOpen.value = !archiveFlyoutOpen.value
}

function openSettings() {
  window.bond.openSettings()
}

function handleArchiveSelect(id: string) {
  emit('select', id)
  archiveFlyoutOpen.value = false
}

const emit = defineEmits<{
  select: [id: string]
  create: []
  archive: [id: string]
  unarchive: [id: string]
  remove: [id: string]
  wpSelect: [site: WordPressSite]
  wpOpen: [site: WordPressSite]
  wpCreate: []
  wpStart: [site: WordPressSite]
  wpStop: [site: WordPressSite]
}>()
</script>

<template>
  <aside class="session-sidebar">
    <!-- Toolbar row — sits beside traffic lights -->
    <BondToolbar label="Sidebar" drag class="sidebar-toolbar">
      <template #end>
        <BondButton
          variant="ghost"
          size="sm"
          icon
          v-tooltip="'Settings ⌘,'"
          @click.stop="openSettings"
        >
          <PhGear :size="16" weight="bold" />
        </BondButton>
      </template>
    </BondToolbar>

    <!-- Chats list -->
    <div class="sidebar-chats">
      <div class="sidebar-section-header">
        <span class="sidebar-section-title">Chats ({{ chatCount }})</span>
        <div class="chats-header-actions">
          <BondButton
            ref="archiveBtnRef"
            variant="ghost"
            size="sm"
            icon
            v-tooltip="'Archived chats'"
            @click.stop="toggleArchiveFlyout"
          >
            <PhArchive :size="14" weight="bold" />
          </BondButton>
          <BondFlyoutMenu
            :open="archiveFlyoutOpen"
            :anchor="archiveBtnRef?.$el"
            :width="260"
            @close="archiveFlyoutOpen = false"
          >
            <div class="archive-flyout-header">Archived ({{ archivedSessions.length }})</div>
            <nav v-if="archivedSessions.length" class="archive-flyout-list sidebar-list">
              <SessionItem
                v-for="s in archivedSessions"
                :key="s.id"
                :session="s"
                archived
                actionTitle="Unarchive"
                @select="handleArchiveSelect(s.id)"
                @action="emit('unarchive', s.id)"
              >
                <PhArrowLineUp :size="14" weight="bold" />
              </SessionItem>
            </nav>
            <p v-else class="archive-flyout-empty">No archived chats</p>
          </BondFlyoutMenu>
          <BondButton
            variant="ghost"
            size="sm"
            icon
            v-tooltip="'New chat ⌘N'"
            @click.stop="emit('create')"
          >
            <PhPlus :size="16" weight="bold" />
          </BondButton>
        </div>
      </div>

      <nav class="sidebar-list chats-list">
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

    <!-- WordPress sites -->
    <div v-if="wordPressAvailable" class="sidebar-wordpress">
      <div class="sidebar-section-header">
        <span class="sidebar-section-title">WordPress ({{ wordPressSites.length }})</span>
        <div class="wp-header-actions">
          <BondButton
            variant="ghost"
            size="sm"
            :disabled="wordPressCreating"
            @click.stop="emit('wpCreate')"
          >
            {{ wordPressCreating ? 'Adding...' : 'Add' }}
          </BondButton>
          <BondButton
            variant="ghost"
            size="sm"
            icon
            v-tooltip="wpOpen ? 'Collapse' : 'Expand'"
            @click.stop="wpOpen = !wpOpen"
          >
            <PhCaretRight :class="['collapse-chevron', { open: wpOpen }]" :size="12" weight="bold" />
          </BondButton>
        </div>
      </div>

      <div :class="['wp-collapsible', { open: wpOpen }]">
        <div class="wp-collapsible-inner">
          <div class="wp-site-list">
            <div
              v-for="site in wordPressSites"
              :key="site.id"
              :class="['wp-site-row', { active: site.id === selectedWpSiteId && activeView === 'wordpress' }]"
              @click="emit('wpSelect', site)"
            >
              <span class="wp-site-name">{{ site.name }}</span>
              <SiteStatusButton
                :running="site.running"
                :toggling="togglingSiteId === site.id"
                @toggle="site.running ? emit('wpStop', site) : emit('wpStart', site)"
              />
            </div>

            <p v-if="wordPressSites.length === 0" class="wp-empty">No sites yet</p>
          </div>
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
  /* macOS traffic lights need the toolbar height for vertical clearance */
}

.sidebar-chats {
  flex: 1;
  min-height: 0;
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

.collapse-chevron {
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

.chats-header-actions {
  display: flex;
  align-items: center;
  gap: 0.125rem;
}

.archive-flyout-header {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-muted);
  padding: 0.5rem 0.75rem 0.25rem;
  flex-shrink: 0;
}

.archive-flyout-list {
  max-height: 280px;
  overflow-y: auto;
}

.archive-flyout-empty {
  font-size: 0.8125rem;
  color: var(--color-muted);
  padding: 0.75rem;
  text-align: center;
}

.sidebar-list {
  overflow-y: auto;
  height: 100%;
  padding: 0.375rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.chats-list {
  flex: 1;
  min-height: 0;
}

/* WordPress section */
.sidebar-wordpress {
  flex-shrink: 0;
  border-top: 1px solid var(--sidebar-border);
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
  padding: 0 0.5rem 0.375rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.wp-header-actions {
  display: flex;
  align-items: center;
}

.wp-site-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 0.25rem 0.5rem 0.5rem;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast);
}
.wp-site-row:hover {
  background: var(--sidebar-hover-bg);
}
.wp-site-row.active {
  background: var(--sidebar-active-bg);
}

.wp-site-name {
  flex: 1;
  min-width: 0;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--sidebar-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wp-empty {
  font-size: 0.75rem;
  color: var(--sidebar-text-muted);
  padding: 0.5rem;
}

</style>

