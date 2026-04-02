<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  PhPlus, PhArchive, PhArrowLineUp, PhTrash,
  PhChatCircle, PhDotsThree, PhArrowLeft,
  PhGlobe, PhCode, PhPresentation, PhCube
} from '@phosphor-icons/vue'
import type { Project, ProjectType } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import ViewShell from './ViewShell.vue'
import ProjectWizard from './ProjectWizard.vue'
import ProjectDetail from './ProjectDetail.vue'

const props = defineProps<{
  projects: Project[]
  archivedProjects: Project[]
  activeProjectId: string | null
  insetStart?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  create: [name: string, goal: string, type: ProjectType, deadline: string]
  archive: [id: string]
  unarchive: [id: string]
  remove: [id: string]
  addResource: [projectId: string, kind: 'path' | 'file' | 'link', value: string, label?: string]
  removeResource: [projectId: string, resourceId: string]
  updateDeadline: [projectId: string, deadline: string]
  startChat: [projectId: string]
  back: []
}>()

const showWizard = ref(false)

// Archive flyout
const archiveFlyoutOpen = ref(false)
const archiveBtnRef = ref<InstanceType<typeof BondButton> | null>(null)

// Project menu flyout
const menuOpen = ref(false)
const menuBtnRef = ref<InstanceType<typeof BondButton> | null>(null)

const activeProject = computed(() =>
  props.projects.find(p => p.id === props.activeProjectId) ?? null
)

const TYPE_META: Record<ProjectType, { label: string; icon: typeof PhCube }> = {
  wordpress: { label: 'WordPress', icon: PhGlobe },
  web: { label: 'Web', icon: PhCode },
  presentation: { label: 'Presentation', icon: PhPresentation },
  generic: { label: 'Generic', icon: PhCube },
}

function handleWizardSubmit(name: string, goal: string, type: ProjectType, deadline: string) {
  emit('create', name, goal, type, deadline)
  showWizard.value = false
}

function handleArchiveSelect(id: string) {
  emit('select', id)
  archiveFlyoutOpen.value = false
}
</script>

<template>
  <!-- Wizard overlay -->
  <ProjectWizard v-if="showWizard" @submit="handleWizardSubmit" @cancel="showWizard = false" />

  <!-- Project detail -->
  <ViewShell
    v-else-if="activeProject"
    :title="activeProject.name"
    :insetStart="insetStart"
  >
    <template #header-start>
      <BondButton variant="ghost" size="sm" icon @click="emit('back')" v-tooltip="'Back to projects'">
        <PhArrowLeft :size="16" weight="bold" />
      </BondButton>
    </template>
    <template #header-end>
      <BondButton variant="ghost" size="sm" icon @click="emit('startChat', activeProject!.id)" v-tooltip="'Start chat'">
        <PhChatCircle :size="16" weight="bold" />
      </BondButton>
      <BondButton ref="menuBtnRef" variant="ghost" size="sm" icon @click="menuOpen = !menuOpen" v-tooltip="'More'">
        <PhDotsThree :size="16" weight="bold" />
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

    <ProjectDetail
      :project="activeProject"
      @addResource="(...args: any[]) => emit('addResource', args[0], args[1], args[2], args[3])"
      @removeResource="(...args: any[]) => emit('removeResource', args[0], args[1])"
      @updateDeadline="(...args: any[]) => emit('updateDeadline', args[0], args[1])"
    />
  </ViewShell>

  <!-- Project list -->
  <ViewShell
    v-else
    title="Projects"
    :insetStart="insetStart"
  >
    <template #header-start>
      <slot name="header-start" />
    </template>
    <template #header-end>
      <BondButton ref="archiveBtnRef" variant="ghost" size="sm" icon @click="archiveFlyoutOpen = !archiveFlyoutOpen" v-tooltip="'Archived projects'">
        <PhArchive :size="16" weight="bold" />
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
        <PhPlus :size="16" weight="bold" />
      </BondButton>
      <slot name="header-end" />
    </template>

    <div class="project-list-wrap">
      <div v-if="projects.length === 0" class="project-list-empty">
        <BondText size="sm" color="muted">No projects yet.</BondText>
        <BondButton variant="primary" size="sm" @click="showWizard = true">
          <PhPlus :size="14" weight="bold" />
          Create a project
        </BondButton>
      </div>

      <div v-else class="project-grid">
        <button
          v-for="p in projects"
          :key="p.id"
          class="project-card"
          @click="emit('select', p.id)"
        >
          <div class="project-card-icon">
            <component :is="TYPE_META[p.type].icon" :size="20" weight="bold" />
          </div>
          <div class="project-card-body">
            <BondText size="sm" weight="medium">{{ p.name }}</BondText>
            <BondText v-if="p.goal" size="xs" color="muted" truncate>{{ p.goal }}</BondText>
          </div>
          <div class="project-card-meta">
            <BondText size="xs" color="muted">{{ p.resources.length }} resource{{ p.resources.length !== 1 ? 's' : '' }}</BondText>
          </div>
        </button>
      </div>
    </div>
  </ViewShell>
</template>

<style scoped>
/* --- Project list --- */

.project-list-wrap {
  padding: 1rem 1.5rem 2rem;
}

.project-list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 4rem 1rem;
}

.project-grid {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.project-card {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.project-card:hover {
  background: var(--color-surface);
}

.project-card-icon {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-muted);
}

.project-card:hover .project-card-icon {
  color: var(--color-accent, var(--color-text-primary));
}

.project-card-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.project-card-meta {
  flex-shrink: 0;
}

/* --- Project menu --- */

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
