<script setup lang="ts">
import { ref, computed } from 'vue'
import { PhPlus, PhArchive, PhArrowLineUp, PhGear, PhTrash } from '@phosphor-icons/vue'
import type { Session } from '../../shared/session'
import SessionItem from './SessionItem.vue'
import SessionCard from './SessionCard.vue'
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
  generatingTitleId: string | null
  busySessionIds: Set<string>
}>()

const chatCount = computed(() => props.sessions.length)
const favoritedSessions = computed(() => props.sessions.filter(s => s.favorited))
const regularSessions = computed(() => props.sessions.filter(s => !s.favorited))

/* Archive flyout */
const archiveFlyoutOpen = ref(false)
const archiveBtnRef = ref<InstanceType<typeof BondButton> | null>(null)

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
  favorite: [id: string]
  unfavorite: [id: string]
  rename: [id: string, title: string]
  setIconSeed: [id: string, seed: number]
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
      <BondPanel id="chats" :defaultSize="100" header="Chats">
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

        <nav class="chats-list overflow-y-auto h-full py-1.5 px-2">
          <div v-if="favoritedSessions.length" class="favorites-grid">
            <SessionCard
              v-for="s in favoritedSessions"
              :key="s.id"
              :session="s"
              :active="s.id === activeSessionId"
              :busy="busySessionIds.has(s.id)"
              @select="emit('select', s.id)"
              @unfavorite="emit('unfavorite', s.id)"
              @archive="emit('archive', s.id)"
              @rename="emit('rename', s.id, $event)"
              @newIcon="emit('setIconSeed', s.id, $event)"
            />
          </div>

          <div class="regular-list">
            <SessionItem
              v-for="s in regularSessions"
              :key="s.id"
              :session="s"
              :active="s.id === activeSessionId"
              :generating="generatingTitleId === s.id"
              :busy="busySessionIds.has(s.id)"
              actionTitle="Archive"
              @select="emit('select', s.id)"
              @action="emit('archive', s.id)"
              @rename="emit('rename', s.id, $event)"
              @favorite="emit('favorite', s.id)"
            >
              <PhArchive :size="14" weight="bold" />
            </SessionItem>
          </div>

          <BondText v-if="sessions.length === 0" as="p" size="sm" color="muted" class="px-3 py-4">
            No chats yet. Start a new one!
          </BondText>
        </nav>
      </BondPanel>
    </BondPanelGroup>
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
  min-width: 0;
  overflow-x: hidden;
}

.favorites-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.375rem;
  margin-bottom: 0.375rem;
  min-width: 0;
}

.regular-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
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
</style>
