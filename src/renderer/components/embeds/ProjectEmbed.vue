<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { PhCheck, PhCircle, PhCalendarBlank, PhFolder, PhLink, PhFile } from '@phosphor-icons/vue'
import type { TodoItem, Project } from '../../../shared/session'

const props = defineProps<{
  name?: string        // single name, comma-separated names, or omit for all
  filter?: string      // "active" (default) or "archived"
}>()

const allProjects = ref<Project[]>([])
const todos = ref<TodoItem[]>([])
const loading = ref(true)

const matched = computed(() => {
  const archived = props.filter === 'archived'
  let list = allProjects.value.filter(p => p.archived === archived)

  if (props.name) {
    const names = props.name.split(',').map(s => s.trim().toLowerCase())
    list = list.filter(p => names.includes(p.name.toLowerCase()))
    // Preserve requested order
    list.sort((a, b) => {
      const ai = names.indexOf(a.name.toLowerCase())
      const bi = names.indexOf(b.name.toLowerCase())
      return ai - bi
    })
  }

  return list
})

function todosForProject(project: Project): TodoItem[] {
  return todos.value.filter(t => t.projectId === project.id)
}

function doneCount(project: Project): number {
  return todosForProject(project).filter(t => t.done).length
}

function totalCount(project: Project): number {
  return todosForProject(project).length
}

function progress(project: Project): number {
  const total = totalCount(project)
  return total > 0 ? Math.round((doneCount(project) / total) * 100) : 0
}

async function refresh() {
  const [p, t] = await Promise.all([
    window.bond.listProjects(),
    window.bond.listTodos(),
  ])
  allProjects.value = p
  todos.value = t
}

let unsubProject: (() => void) | null = null
let unsubTodo: (() => void) | null = null

onMounted(async () => {
  try {
    await refresh()
  } finally {
    loading.value = false
  }
  unsubProject = window.bond.onProjectsChanged(() => refresh())
  unsubTodo = window.bond.onTodoChanged(() => refresh())
})

onUnmounted(() => {
  unsubProject?.()
  unsubTodo?.()
})

async function toggleTodo(todo: TodoItem) {
  await window.bond.updateTodo(todo.id, { done: !todo.done })
}

function formatDeadline(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function resourceIcon(kind: string) {
  if (kind === 'link') return PhLink
  if (kind === 'file') return PhFile
  return PhFolder
}

function openResource(kind: string, value: string) {
  if (kind === 'link') window.bond.openExternal(value)
  else if (kind === 'file' && /\.(md|markdown)$/i.test(value)) window.bond.openViewer(value)
  else window.bond.openPath(value)
}
</script>

<template>
  <div class="project-embed">
    <div v-if="loading" class="embed-loading">Loading projects...</div>
    <div v-else-if="matched.length === 0" class="embed-empty">
      {{ name ? `Project "${name}" not found` : 'No projects found' }}
    </div>
    <template v-else>
      <div
        v-for="project in matched"
        :key="project.id"
        class="project-card"
        :class="{ 'project-card--spaced': matched.length > 1 }"
      >
        <!-- Header -->
        <div class="project-header">
          <span class="project-name">{{ project.name }}</span>
          <span class="project-type">{{ project.type }}</span>
        </div>

        <!-- Goal -->
        <p v-if="project.goal" class="project-goal">{{ project.goal }}</p>

        <!-- Meta row -->
        <div class="project-meta">
          <span v-if="project.deadline" class="meta-item">
            <PhCalendarBlank :size="13" />
            {{ formatDeadline(project.deadline) }}
          </span>
          <span v-if="totalCount(project) > 0" class="meta-item">
            {{ doneCount(project) }}/{{ totalCount(project) }} todos done
          </span>
        </div>

        <!-- Progress bar -->
        <div v-if="totalCount(project) > 0" class="progress-bar">
          <div class="progress-fill" :style="{ width: progress(project) + '%' }" />
        </div>

        <!-- Resources -->
        <div v-if="project.resources.length > 0" class="resource-list">
          <a
            v-for="r in project.resources"
            :key="r.id"
            class="resource-item"
            href="#"
            @click.prevent="openResource(r.kind, r.value)"
          >
            <component :is="resourceIcon(r.kind)" :size="13" />
            {{ r.label || r.value.split('/').pop() }}
          </a>
        </div>

        <!-- Todos (compact) -->
        <div v-if="todosForProject(project).length > 0" class="project-todos">
          <div
            v-for="todo in todosForProject(project)"
            :key="todo.id"
            class="todo-row"
            :class="{ 'todo-row--done': todo.done }"
            @click="toggleTodo(todo)"
          >
            <PhCheck v-if="todo.done" :size="14" weight="bold" class="todo-icon todo-icon--done" />
            <PhCircle v-else :size="14" weight="regular" class="todo-icon todo-icon--pending" />
            <span class="todo-text">{{ todo.text }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.project-embed {
  padding: 0.5em 0;
}

.embed-loading, .embed-empty {
  font-size: 0.8em;
  color: var(--color-muted);
  padding: 0.25em 0;
}

.project-card--spaced + .project-card--spaced {
  margin-top: 0.75em;
  padding-top: 0.75em;
  border-top: 1px solid var(--color-border);
}

.project-header {
  display: flex;
  align-items: center;
  gap: 0.5em;
}

.project-name {
  font-weight: 600;
  font-size: 0.95em;
}

.project-type {
  font-size: 0.7em;
  color: var(--color-muted);
  background: var(--color-tint);
  padding: 0.1em 0.5em;
  border-radius: var(--radius-sm);
  text-transform: capitalize;
}

.project-goal {
  font-size: 0.8em;
  color: var(--color-muted);
  margin: 0.3em 0;
  line-height: 1.4;
}

.project-meta {
  display: flex;
  gap: 0.8em;
  font-size: 0.75em;
  color: var(--color-muted);
  margin: 0.3em 0;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 0.3em;
}

.progress-bar {
  height: 3px;
  background: var(--color-border);
  border-radius: 2px;
  margin: 0.4em 0;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--color-accent);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.resource-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3em;
  margin: 0.4em 0;
}

.resource-item {
  display: flex;
  align-items: center;
  gap: 0.3em;
  font-size: 0.75em;
  color: var(--color-accent);
  padding: 0.15em 0.5em;
  border-radius: var(--radius-sm);
  background: var(--color-tint);
  text-decoration: none;
  transition: opacity var(--transition-fast);
}
.resource-item:hover {
  opacity: 0.75;
}

.project-todos {
  margin-top: 0.4em;
  padding-top: 0.4em;
  border-top: 1px solid var(--color-border);
}

.todo-row {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.2em 0;
  cursor: pointer;
  font-size: 0.825em;
  transition: opacity var(--transition-fast);
}
.todo-row:hover { opacity: 0.8; }
.todo-row--done { opacity: 0.5; }
.todo-row--done .todo-text { text-decoration: line-through; }

.todo-icon--pending { color: var(--color-muted); }
.todo-icon--done { color: var(--color-ok); }

.todo-text {
  flex: 1;
  min-width: 0;
}
</style>
