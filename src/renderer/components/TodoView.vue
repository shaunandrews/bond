<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { PhPlus, PhTrash } from '@phosphor-icons/vue'
import type { TodoItem } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import ViewShell from './ViewShell.vue'

defineProps<{
  insetStart?: boolean
}>()

const todos = ref<TodoItem[]>([])
const loading = ref(true)
const newText = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

const pending = computed(() => todos.value.filter(t => !t.done))
const done = computed(() => todos.value.filter(t => t.done))

onMounted(async () => {
  try {
    todos.value = await window.bond.listTodos()
  } finally {
    loading.value = false
  }
})

async function addTodo() {
  const text = newText.value.trim()
  if (!text) return
  const todo = await window.bond.createTodo(text)
  todos.value.push(todo)
  newText.value = ''
  nextTick(() => inputRef.value?.focus())
}

async function toggle(todo: TodoItem) {
  const updated = await window.bond.updateTodo(todo.id, { done: !todo.done })
  if (updated) {
    const idx = todos.value.findIndex(t => t.id === todo.id)
    if (idx !== -1) todos.value[idx] = updated
  }
}

async function remove(id: string) {
  const ok = await window.bond.deleteTodo(id)
  if (ok) todos.value = todos.value.filter(t => t.id !== id)
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    addTodo()
  }
}
</script>

<template>
  <ViewShell title="Todos" :insetStart="insetStart">
    <template #header-start>
      <slot name="header-start" />
    </template>

    <div class="todo-view">
      <div v-if="loading" class="todo-empty">
        <BondText size="sm" color="muted">Loading...</BondText>
      </div>

      <template v-else>
        <div class="todo-input-row">
          <input
            ref="inputRef"
            v-model="newText"
            class="todo-input"
            placeholder="Add a todo..."
            @keydown="onInputKeydown"
          />
          <BondButton variant="ghost" size="sm" icon :disabled="!newText.trim()" @click="addTodo">
            <PhPlus :size="16" weight="bold" />
          </BondButton>
        </div>

        <div v-if="pending.length === 0 && done.length === 0" class="todo-empty">
          <BondText size="sm" color="muted">No todos yet.</BondText>
        </div>

        <ul v-if="pending.length" class="todo-list">
          <li v-for="todo in pending" :key="todo.id" class="todo-item">
            <label class="todo-label">
              <input type="checkbox" :checked="todo.done" @change="toggle(todo)" />
              <span class="todo-text">{{ todo.text }}</span>
            </label>
            <button class="todo-delete" @click="remove(todo.id)">
              <PhTrash :size="14" weight="bold" />
            </button>
          </li>
        </ul>

        <template v-if="done.length">
          <BondText as="div" size="xs" color="muted" class="todo-section-label">
            Done ({{ done.length }})
          </BondText>
          <ul class="todo-list">
            <li v-for="todo in done" :key="todo.id" class="todo-item done">
              <label class="todo-label">
                <input type="checkbox" :checked="todo.done" @change="toggle(todo)" />
                <span class="todo-text">{{ todo.text }}</span>
              </label>
              <button class="todo-delete" @click="remove(todo.id)">
                <PhTrash :size="14" weight="bold" />
              </button>
            </li>
          </ul>
        </template>
      </template>
    </div>
  </ViewShell>
</template>

<style scoped>
.todo-view {
  padding: 1rem 1.25rem 2rem;
}

.todo-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
}

.todo-input-row {
  display: flex;
  gap: 0.375rem;
  align-items: center;
  margin-bottom: 1rem;
}

.todo-input {
  flex: 1;
  font-size: 0.875rem;
  font-family: inherit;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.5rem 0.625rem;
  outline: none;
  transition: border-color var(--transition-fast);
}

.todo-input:focus {
  border-color: var(--color-accent, var(--color-border));
}

.todo-input::placeholder {
  color: var(--color-muted);
}

.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.todo-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.todo-item:hover {
  background: var(--color-surface);
}

.todo-label {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  min-width: 0;
}

.todo-label input[type="checkbox"] {
  accent-color: var(--color-accent, #888);
  flex-shrink: 0;
}

.todo-text {
  font-size: 0.875rem;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.todo-item.done .todo-text {
  text-decoration: line-through;
  color: var(--color-muted);
}

.todo-delete {
  all: unset;
  cursor: pointer;
  display: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  flex-shrink: 0;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.todo-item:hover .todo-delete {
  display: flex;
}

.todo-delete:hover {
  background: var(--color-surface);
  color: var(--color-text-primary);
}

.todo-section-label {
  padding: 0.75rem 0.5rem 0.25rem;
}
</style>
