<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  PhArrowLeft, PhChatCircle, PhGlobe, PhCode, PhPresentation, PhCube,
  PhPlus, PhArchive, PhArrowLineUp, PhTrash, PhDotsThree
} from '@phosphor-icons/vue'
import type { Project, ProjectType } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondToolbar from './BondToolbar.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import ProjectDetail from './ProjectDetail.vue'
import ProjectWizard from './ProjectWizard.vue'
import MarkdownViewer from './MarkdownViewer.vue'

const props = defineProps<{
  projects: Project[]
  archivedProjects: Project[]
  activeProjectId: string | null
}>()

const emit = defineEmits<{
  select: [id: string | null]
  create: [name: string, goal: string, type: ProjectType, deadline: string]
  archive: [id: string]
  unarchive: [id: string]
  remove: [id: string]
  startChat: [projectId: string]
  addResource: [projectId: string, kind: 'path' | 'file' | 'link', value: string, label?: string]
  removeResource: [projectId: string, resourceId: string]
  updateDeadline: [projectId: string, deadline: string]
}>()

const activeProject = computed(() =>
  props.projects.find(p => p.id === props.activeProjectId) ?? null
)

// Wizard
const showWizard = ref(false)

function handleWizardSubmit(name: string, goal: string, type: ProjectType, deadline: string) {
  emit('create', name, goal, type, deadline)
  showWizard.value = false
}

// Archive flyout
const archiveFlyoutOpen = ref(false)
const archiveBtnRef = ref<InstanceType<typeof BondButton> | null>(null)

function handleArchiveSelect(id: string) {
  emit('select', id)
  archiveFlyoutOpen.value = false
}

// Project context menu
const menuOpen = ref(false)
const menuBtnRef = ref<InstanceType<typeof BondButton> | null>(null)

// Inline markdown viewer state
const viewingFile = ref<string | null>(null)
const viewingFileName = computed(() =>
  viewingFile.value ? viewingFile.value.split('/').pop() ?? 'File' : ''
)

function openMarkdown(filePath: string) {
  viewingFile.value = filePath
}

function closeMarkdown() {
  viewingFile.value = null
}

const TYPE_META: Record<ProjectType, { label: string; icon: typeof PhCube }> = {
  wordpress: { label: 'WordPress', icon: PhGlobe },
  web: { label: 'Web', icon: PhCode },
  presentation: { label: 'Presentation', icon: PhPresentation },
  generic: { label: 'Generic', icon: PhCube },
}
</script>

<template>
  <!-- Wizard overlay -->
  <ProjectWizard v-if="showWizard" @submit="handleWizardSubmit" @cancel="showWizard = false" />

  <div v-else class="project-panel">
    <!-- Markdown viewer -->
    <template v-if="viewingFile">
      <BondToolbar label="Markdown viewer" drag blur class="project-panel-toolbar">
        <template #start>
          <BondButton variant="ghost" size="sm" icon @click="closeMarkdown" v-tooltip="'Back to project'">
            <PhArrowLeft :size="14" weight="bold" />
          </BondButton>
          <BondText size="sm" weight="medium" truncate>{{ viewingFileName }}</BondText>
        </template>
      </BondToolbar>
      <div class="project-panel-scroll">
        <MarkdownViewer :filePath="viewingFile" />
      </div>
    </template>

    <!-- Detail view -->
    <template v-else-if="activeProject">
      <BondToolbar label="Project detail" drag blur class="project-panel-toolbar">
        <template #start>
          <BondButton variant="ghost" size="sm" icon @click="emit('select', null)" v-tooltip="'Back to list'">
            <PhArrowLeft :size="14" weight="bold" />
          </BondButton>
          <BondText size="sm" weight="medium" truncate>{{ activeProject.name }}</BondText>
        </template>
        <template #end>
          <BondButton variant="ghost" size="sm" icon @click="emit('startChat', activeProject!.id)" v-tooltip="'Start chat'">
            <PhChatCircle :size="14" weight="bold" />
          </BondButton>
          <BondButton ref="menuBtnRef" variant="ghost" size="sm" icon @click="menuOpen = !menuOpen" v-tooltip="'More'">
            <PhDotsThree :size="14" weight="bold" />
          </BondButton>
          <BondFlyoutMenu :open="menuOpen" :anchor="menuBtnRef?.$el" :width="160" @close="menuOpen = false">
            <nav class="project-menu">
              <button class="project-menu-item" @click="emit('archive', activeProject!.id); menuOpen = false">
                <PhArchive :size="14" weight="bold" />
                <span>Archive</span>
              </button>
              <button class="project-menu-item project-menu-item--danger" @click="emit('remove', activeProject!.id); menuOpen = false">
                <PhTrash :size="14" weight="bold" />
                <span>Delete</span>
              </button>
            </nav>
          </BondFlyoutMenu>
        </template>
      </BondToolbar>
      <div class="project-panel-scroll">
        <ProjectDetail
          :project="activeProject"
          compact
          @addResource="(...args: any[]) => emit('addResource', args[0], args[1], args[2], args[3])"
          @removeResource="(...args: any[]) => emit('removeResource', args[0], args[1])"
          @updateDeadline="(...args: any[]) => emit('updateDeadline', args[0], args[1])"
          @viewMarkdown="openMarkdown"
        />
      </div>
    </template>

    <!-- List view -->
    <template v-else>
      <BondToolbar label="Projects" drag blur class="project-panel-toolbar">
        <template #start>
          <BondText size="sm" weight="medium" color="muted">Projects</BondText>
          <span v-if="projects.length" class="project-panel-badge">{{ projects.length }}</span>
        </template>
        <template #end>
          <BondButton ref="archiveBtnRef" variant="ghost" size="sm" icon @click="archiveFlyoutOpen = !archiveFlyoutOpen" v-tooltip="'Archived projects'">
            <PhArchive :size="14" weight="bold" />
          </BondButton>
          <BondFlyoutMenu :open="archiveFlyoutOpen" :anchor="archiveBtnRef?.$el" :width="260" @close="archiveFlyoutOpen = false">
            <BondText as="div" size="xs" weight="medium" color="muted" class="pt-2 px-3 pb-1 shrink-0">
              Archived ({{ archivedProjects.length }})
            </BondText>
            <nav v-if="archivedProjects.length" class="archive-list">
              <button v-for="p in archivedProjects" :key="p.id" class="archive-item" @click="handleArchiveSelect(p.id)">
                <component :is="TYPE_META[p.type].icon" :size="14" weight="bold" />
                <span class="archive-item-name">{{ p.name }}</span>
                <BondButton variant="ghost" size="sm" icon @click.stop="emit('unarchive', p.id)" v-tooltip="'Unarchive'">
                  <PhArrowLineUp :size="14" weight="bold" />
                </BondButton>
              </button>
            </nav>
            <BondText v-else as="p" size="sm" color="muted" class="p-3 text-center">No archived projects</BondText>
          </BondFlyoutMenu>
          <BondButton variant="ghost" size="sm" icon @click="showWizard = true" v-tooltip="'New project'">
            <PhPlus :size="14" weight="bold" />
          </BondButton>
        </template>
      </BondToolbar>

      <div class="project-panel-scroll">
        <div class="project-panel-body">
          <div v-if="projects.length === 0" class="project-panel-empty">
            <BondText size="sm" color="muted">No projects yet.</BondText>
            <BondButton variant="primary" size="sm" @click="showWizard = true">
              <PhPlus :size="14" weight="bold" />
              Create a project
            </BondButton>
          </div>

          <nav v-else class="project-panel-list">
            <button
              v-for="p in projects"
              :key="p.id"
              class="project-panel-item"
              @click="emit('select', p.id)"
            >
              <component :is="TYPE_META[p.type].icon" :size="14" weight="bold" class="project-panel-item-icon" />
              <div class="project-panel-item-body">
                <BondText size="sm">{{ p.name }}</BondText>
                <BondText v-if="p.goal" size="xs" color="muted" truncate>{{ p.goal }}</BondText>
              </div>
            </button>
          </nav>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.project-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.project-panel-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.project-panel-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  flex-shrink: 0;
}

.project-panel-badge {
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
}

.project-panel-body {
  padding: 0.75rem 0.5rem 2rem;
}

.project-panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 3rem 1rem;
}

/* --- List view --- */

.project-panel-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.project-panel-item {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.project-panel-item:hover {
  background: var(--color-surface);
}

.project-panel-item-icon {
  flex-shrink: 0;
  color: var(--color-muted);
}

.project-panel-item:hover .project-panel-item-icon {
  color: var(--color-accent, var(--color-text-primary));
}

.project-panel-item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
}

/* --- Project context menu --- */

.project-menu {
  padding: 0.375rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.project-menu-item {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--color-text-primary);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.project-menu-item:hover {
  background: var(--color-surface);
}

.project-menu-item--danger:hover {
  color: var(--color-err);
}

/* --- Archive flyout --- */

.archive-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.375rem;
  max-height: 280px;
  overflow-y: auto;
}

.archive-item {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--color-text-primary);
  transition: background var(--transition-fast);
}

.archive-item:hover {
  background: var(--color-surface);
}

.archive-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
