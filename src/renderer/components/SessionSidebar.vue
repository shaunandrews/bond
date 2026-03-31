<script setup lang="ts">
import { ref, computed } from 'vue'
import { PhPlus, PhArchive, PhArrowLineUp, PhGear, PhTrash } from '@phosphor-icons/vue'
import type { Session } from '../../shared/session'
import type { WordPressSite } from '../../shared/wordpress'
import type { AppView } from '../composables/useAppView'
import SessionItem from './SessionItem.vue'
import BondToolbar from './BondToolbar.vue'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import BondPanelGroup from './BondPanelGroup.vue'
import BondPanel from './BondPanel.vue'
import SiteStatusButton from './SiteStatusButton.vue'

const props = defineProps<{
  sessions: Session[]
  archivedSessions: Session[]
  activeSessionId: string | null
  activeView: AppView
  generatingTitleId: string | null
  projects: WordPressSite[]
  projectsAvailable: boolean | null
  projectsCreating: boolean
  selectedProjectId: string | null
  togglingProjectId: string | null
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
  projectSelect: [site: WordPressSite]
  projectOpen: [site: WordPressSite]
  projectCreate: []
  projectStart: [site: WordPressSite]
  projectStop: [site: WordPressSite]
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
            actionTitle="Archive"
            @select="emit('select', s.id)"
            @action="emit('archive', s.id)"
          >
            <PhArchive :size="14" weight="bold" />
          </SessionItem>

          <BondText v-if="sessions.length === 0" as="p" size="sm" color="muted" class="px-3 py-4">
            No chats yet. Start a new one!
          </BondText>
        </nav>
      </BondPanel>

      <!-- Projects -->
      <BondPanel
        v-if="projectsAvailable"
        id="projects"
        :header="`Projects (${projects.length})`"
        collapsible
        class="sidebar-projects"
      >
        <template #header-extra>
          <BondButton
            variant="ghost"
            size="sm"
            icon
            :disabled="projectsCreating"
            v-tooltip="'Add project'"
            @click.stop="emit('projectCreate')"
          >
            <PhPlus :size="16" weight="bold" />
          </BondButton>
        </template>

        <div class="flex flex-col gap-0.5 px-2 pb-2">
          <div
            v-for="site in projects"
            :key="site.id"
            :class="['project-row', { active: site.id === selectedProjectId && activeView === 'projects' }]"
            @click="emit('projectSelect', site)"
          >
            <BondText size="sm" weight="medium" color="inherit" truncate class="flex-1 min-w-0">{{ site.name }}</BondText>
            <SiteStatusButton
              :running="site.running"
              :toggling="togglingProjectId === site.id"
              @toggle="site.running ? emit('projectStop', site) : emit('projectStart', site)"
            />
          </div>

          <BondText v-if="projects.length === 0" as="p" size="xs" color="inherit" class="project-empty p-2">No projects yet</BondText>
        </div>
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

/* Projects section */
.sidebar-projects {
  border-top: 1px solid var(--sidebar-border);
}

.project-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 0.25rem 0.5rem 0.5rem;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: var(--sidebar-text);
  transition: background var(--transition-fast);
}
.project-row:hover {
  background: var(--sidebar-hover-bg);
}
.project-row.active {
  background: var(--sidebar-active-bg);
}

.project-empty {
  color: var(--sidebar-text-muted);
}
</style>
