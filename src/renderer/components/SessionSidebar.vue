<script setup lang="ts">
import { ref, computed } from 'vue'
import { PhPlus, PhArchive, PhArrowLineUp, PhGear, PhTrash, PhImages } from '@phosphor-icons/vue'
import type { Session } from '../../shared/session'
import SessionItem from './SessionItem.vue'
import BondToolbar from './BondToolbar.vue'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import BondPanelGroup from './BondPanelGroup.vue'
import BondPanel from './BondPanel.vue'

const props = defineProps<{
  sessions: Session[]
  archivedSessions: Session[]
  activeSessionId: string | null
  activeView: string
  generatingTitleId: string | null
  busySessionIds: Set<string>
  mediaCount: number
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
  removeArchived: []
  media: []
  rename: [id: string, title: string]
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

    <BondPanelGroup direction="vertical" class="flex-1 min-h-0">
      <!-- Chats list -->
      <BondPanel id="chats" :defaultSize="100" :header="`Chats (${chatCount})`">
        <template #header-extra>
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
            <BondText as="div" size="xs" weight="medium" color="muted" class="pt-2 px-3 pb-1 shrink-0">
              Archived ({{ archivedSessions.length }})
            </BondText>
            <nav v-if="archivedSessions.length" class="archive-flyout-list overflow-y-auto flex flex-col gap-0.5 py-1.5 px-2">
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
            <BondText v-else as="p" size="sm" color="muted" class="p-3 text-center">No archived chats</BondText>
            <div v-if="archivedSessions.length" class="archive-flyout-footer">
              <BondButton variant="danger" size="sm" @click="emit('removeArchived'); archiveFlyoutOpen = false">
                <PhTrash :size="14" weight="bold" />
                Delete all
              </BondButton>
            </div>
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
        </template>

        <nav class="chats-list overflow-y-auto h-full flex flex-col gap-0.5 py-1.5 px-2">
          <SessionItem
            v-for="s in sessions"
            :key="s.id"
            :session="s"
            :active="s.id === activeSessionId && activeView === 'chat'"
            :generating="generatingTitleId === s.id"
            :busy="busySessionIds.has(s.id)"
            actionTitle="Archive"
            @select="emit('select', s.id)"
            @action="emit('archive', s.id)"
            @rename="emit('rename', s.id, $event)"
          >
            <PhArchive :size="14" weight="bold" />
          </SessionItem>

          <BondText v-if="sessions.length === 0" as="p" size="sm" color="muted" class="px-3 py-4">
            No chats yet. Start a new one!
          </BondText>
        </nav>
      </BondPanel>
    </BondPanelGroup>

    <nav class="sidebar-nav">
      <button
        :class="['sidebar-nav-item', { active: activeView === 'media' }]"
        @click="emit('media')"
      >
        <PhImages :size="16" weight="bold" />
        <BondText size="sm">Media</BondText>
        <span v-if="mediaCount > 0" class="media-count-badge">{{ mediaCount }}</span>
      </button>
    </nav>

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

.chats-list {
  flex: 1;
  min-height: 0;
}

.archive-flyout-list {
  max-height: 280px;
}

.archive-flyout-footer {
  border-top: 1px solid var(--color-border);
  padding: 0.5rem;
  display: flex;
  justify-content: flex-end;
}

.sidebar-nav {
  border-top: 1px solid var(--sidebar-border);
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.sidebar-nav-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.625rem;
  border-radius: var(--radius-md);
  border: none;
  background: none;
  color: var(--sidebar-text);
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: background var(--transition-fast);
}

.sidebar-nav-item:hover {
  background: var(--sidebar-hover-bg);
}

.sidebar-nav-item.active {
  background: var(--sidebar-hover-bg);
  color: var(--color-text-primary);
}

.media-count-badge {
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
  background: var(--color-accent, var(--color-text-primary));
  color: var(--color-bg, #fff);
  margin-left: auto;
}

</style>
