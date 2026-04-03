<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { PhCheck, PhCircle, PhPlus } from '@phosphor-icons/vue'
import type { TodoItem, Project } from '../../../shared/session'

const props = defineProps<{
  project?: string
  group?: string
  filter?: string
  ids?: string       // comma-separated todo IDs
  search?: string    // text search across todo titles
  add?: string       // "true" to show the add input
}>()

const todos = ref<TodoItem[]>([])
const projects = ref<Project[]>([])
const loading = ref(true)
const newText = ref('')

const projectId = computed(() => {
  if (!props.project) return null
  const p = projects.value.find(
    pr => pr.name.toLowerCase() === props.project!.toLowerCase()
  )
  return p?.id ?? null
})

const idSet = computed(() => {
  if (!props.ids) return null
  return new Set(props.ids.split(',').map(s => s.trim()).filter(Boolean))
})

const filtered = computed(() => {
  let list = todos.value

  // If specific IDs are given, show only those (in the order specified)
  if (idSet.value) {
    const map = new Map(list.map(t => [t.id, t]))
    return [...idSet.value].map(id => map.get(id)).filter(Boolean) as TodoItem[]
  }

  // Text search
  if (props.search) {
    const q = props.search.toLowerCase()
    list = list.filter(t => t.text.toLowerCase().includes(q))
  }

  if (projectId.value) list = list.filter(t => t.projectId === projectId.value)
  if (props.group) list = list.filter(t => t.group === props.group)
  if (props.filter === 'pending') list = list.filter(t => !t.done)
  else if (props.filter === 'done') list = list.filter(t => t.done)
  return list
})

const pending = computed(() => filtered.value.filter(t => !t.done))
const done = computed(() => filtered.value.filter(t => t.done))

async function refresh() {
  const [t, p] = await Promise.all([
    window.bond.listTodos(),
    window.bond.listProjects(),
  ])
  todos.value = t
  projects.value = p.filter(pr => !pr.archived)
}

let unsubTodo: (() => void) | null = null
let unsubProject: (() => void) | null = null

onMounted(async () => {
  try {
    await refresh()
  } finally {
    loading.value = false
  }
  unsubTodo = window.bond.onTodoChanged(() => refresh())
  unsubProject = window.bond.onProjectsChanged(() => refresh())
})

onUnmounted(() => {
  unsubTodo?.()
  unsubProject?.()
})

async function toggle(todo: TodoItem) {
  await window.bond.updateTodo(todo.id, { done: !todo.done })
}

async function addTodo() {
  const text = newText.value.trim()
  if (!text) return
  await window.bond.createTodo(text, '', '', projectId.value ?? undefined)
  newText.value = ''
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    addTodo()
  }
}
</script>

<template>
  <div class="todo-embed">
    <div v-if="loading" class="embed-loading">Loading todos...</div>
    <template v-else>
      <div v-if="filtered.length === 0 && !loading" class="embed-empty">No todos found</div>

      <!-- Pending -->
      <div v-for="todo in pending" :key="todo.id" class="todo-row" @click="toggle(todo)">
        <PhCircle :size="16" weight="regular" class="todo-check todo-check--pending" />
        <span class="todo-text">{{ todo.text }}</span>
        <span v-if="todo.group" class="todo-group">{{ todo.group }}</span>
      </div>

      <!-- Done -->
      <div v-for="todo in done" :key="todo.id" class="todo-row todo-row--done" @click="toggle(todo)">
        <PhCheck :size="16" weight="bold" class="todo-check todo-check--done" />
        <span class="todo-text">{{ todo.text }}</span>
      </div>

      <!-- Add -->
      <div v-if="add === 'true'" class="todo-add">
        <PhPlus :size="14" class="todo-add-icon" />
        <input
          v-model="newText"
          placeholder="Add a todo..."
          class="todo-add-input"
          @keydown="handleKeydown"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.todo-embed {
  padding: 0.5em 0;
}

.embed-loading, .embed-empty {
  font-size: 0.8em;
  color: var(--color-muted);
  padding: 0.25em 0;
}

.todo-row {
  display: flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.3em 0;
  cursor: pointer;
  font-size: 0.875em;
  transition: opacity var(--transition-fast);
}
.todo-row:hover {
  opacity: 0.8;
}

.todo-row--done {
  opacity: 0.5;
}
.todo-row--done .todo-text {
  text-decoration: line-through;
}

.todo-check {
  flex-shrink: 0;
}
.todo-check--pending {
  color: var(--color-muted);
}
.todo-check--done {
  color: var(--color-ok);
}

.todo-text {
  flex: 1;
  min-width: 0;
}

.todo-group {
  font-size: 0.75em;
  color: var(--color-muted);
  background: var(--color-tint);
  padding: 0.1em 0.5em;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.todo-add {
  display: flex;
  align-items: center;
  gap: 0.4em;
  margin-top: 0.4em;
  padding-top: 0.4em;
  border-top: 1px solid var(--color-border);
}

.todo-add-icon {
  color: var(--color-muted);
  flex-shrink: 0;
}

.todo-add-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font: inherit;
  font-size: 0.875em;
  color: var(--color-text-primary);
  padding: 0.2em 0;
}
.todo-add-input::placeholder {
  color: var(--color-muted);
  opacity: 0.6;
}
</style>
