<script setup lang="ts">
import { computed } from 'vue'
import { PhArrowLeft, PhChatCircle, PhGlobe, PhCode, PhPresentation, PhCube } from '@phosphor-icons/vue'
import type { Project, ProjectType } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import ProjectDetail from './ProjectDetail.vue'

const props = defineProps<{
  projects: Project[]
  activeProjectId: string | null
}>()

const emit = defineEmits<{
  select: [id: string | null]
  startChat: [projectId: string]
  addResource: [projectId: string, kind: 'path' | 'file' | 'link', value: string, label?: string]
  removeResource: [projectId: string, resourceId: string]
}>()

const activeProject = computed(() =>
  props.projects.find(p => p.id === props.activeProjectId) ?? null
)

const TYPE_META: Record<ProjectType, { label: string; icon: typeof PhCube }> = {
  wordpress: { label: 'WordPress', icon: PhGlobe },
  web: { label: 'Web', icon: PhCode },
  presentation: { label: 'Presentation', icon: PhPresentation },
  generic: { label: 'Generic', icon: PhCube },
}
</script>

<template>
  <div class="project-panel">
    <!-- Detail view -->
    <template v-if="activeProject">
      <div class="project-panel-header">
        <BondButton variant="ghost" size="sm" icon @click="emit('select', null)" v-tooltip="'Back to list'" class="panel-back-btn">
          <PhArrowLeft :size="14" weight="bold" />
        </BondButton>
        <BondText size="sm" weight="medium" truncate>{{ activeProject.name }}</BondText>
        <BondButton variant="ghost" size="sm" icon class="panel-chat-btn" @click="emit('startChat', activeProject!.id)" v-tooltip="'Start chat'">
          <PhChatCircle :size="14" weight="bold" />
        </BondButton>
      </div>

      <div class="project-panel-scroll">
        <ProjectDetail
          :project="activeProject"
          compact
          @addResource="(...args: any[]) => emit('addResource', args[0], args[1], args[2], args[3])"
          @removeResource="(...args: any[]) => emit('removeResource', args[0], args[1])"
        />
      </div>
    </template>

    <!-- List view -->
    <template v-else>
      <div class="project-panel-header">
        <BondText size="sm" weight="medium" color="muted">Projects</BondText>
        <span v-if="projects.length" class="project-panel-badge">{{ projects.length }}</span>
      </div>

      <div class="project-panel-scroll project-panel-body">
        <div v-if="projects.length === 0" class="project-panel-empty">
          <BondText size="sm" color="muted">No projects yet.</BondText>
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

.project-panel-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  height: var(--toolbar-height);
  padding-inline: 0.5rem 1rem;
  -webkit-app-region: drag;
}

.project-panel-header > .panel-back-btn {
  -webkit-app-region: no-drag;
}

.project-panel-header > .panel-chat-btn {
  margin-left: auto;
  -webkit-app-region: no-drag;
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

.project-panel-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.project-panel-body {
  padding: 0.75rem 0.5rem 2rem;
}

.project-panel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
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
</style>
