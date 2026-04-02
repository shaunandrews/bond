<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { PhPlus, PhTrash, PhChatCircle, PhNotePencil, PhTag, PhSpinner } from '@phosphor-icons/vue'
import type { TodoItem } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'

const emit = defineEmits<{
  startChat: [text: string]
}>()

const todos = ref<TodoItem[]>([])
const loading = ref(true)
const newRaw = ref('')
const parsing = ref(false)
const activeGroup = ref<string | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const expandedId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const titleInput = ref('')
const notesInput = ref('')
const groupInput = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)
const notesTextareaRef = ref<HTMLTextAreaElement | null>(null)

const groups = computed(() => {
  const set = new Set<string>()
  for (const t of todos.value) {
    if (t.group) set.add(t.group)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
})

const filteredTodos = computed(() => {
  if (!activeGroup.value) return todos.value
  return todos.value.filter(t => t.group === activeGroup.value)
})

const pending = computed(() => filteredTodos.value.filter(t => !t.done))
const done = computed(() => filteredTodos.value.filter(t => t.done))

async function refreshTodos() {
  todos.value = await window.bond.listTodos()
}

let unsubTodoChanged: (() => void) | null = null

onMounted(async () => {
  try {
    await refreshTodos()
  } finally {
    loading.value = false
  }
  unsubTodoChanged = window.bond.onTodoChanged(() => refreshTodos())
})

onUnmounted(() => {
  unsubTodoChanged?.()
})

async function addTodo() {
  const raw = newRaw.value.trim()
  if (!raw || parsing.value) return
  parsing.value = true
  try {
    const parsed = await window.bond.parseTodo(raw)
    if (!parsed.title) return
    const todo = await window.bond.createTodo(parsed.title, parsed.notes, parsed.group)
    todos.value.push(todo)
    newRaw.value = ''
    nextTick(() => {
      inputRef.value?.focus()
      autoResizeInput()
    })
  } finally {
    parsing.value = false
  }
}

function autoResizeInput() {
  const el = inputRef.value
  if (el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }
}

function setFilter(group: string | null) {
  activeGroup.value = activeGroup.value === group ? null : group
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

function toggleExpand(id: string) {
  if (expandedId.value === id) {
    expandedId.value = null
    editingId.value = null
  } else {
    expandedId.value = id
    editingId.value = null
  }
}

function startEdit(todo: TodoItem) {
  editingId.value = todo.id
  titleInput.value = todo.text
  notesInput.value = todo.notes
  groupInput.value = todo.group
  nextTick(() => {
    titleInputRef.value?.focus()
    autoResizeNotes()
  })
}

function cancelEdit() {
  editingId.value = null
}

function autoResizeNotes() {
  const el = notesTextareaRef.value
  if (el) {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }
}

async function saveEdit(todo: TodoItem) {
  const text = titleInput.value.trim()
  if (!text) return
  const notes = notesInput.value
  const group = groupInput.value.trim()
  const updated = await window.bond.updateTodo(todo.id, { text, notes, group })
  if (updated) {
    const idx = todos.value.findIndex(t => t.id === todo.id)
    if (idx !== -1) todos.value[idx] = updated
  }
  editingId.value = null
}

function onEditKeydown(e: KeyboardEvent, todo: TodoItem) {
  if (e.key === 'Escape') {
    cancelEdit()
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    saveEdit(todo)
  }
}

function onInputKeydown(e: KeyboardEvent) {
  // Enter to submit, Shift+Enter for newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    addTodo()
  }
}
</script>

<template>
  <div class="todo-panel">
    <div class="todo-panel-header">
      <BondText size="sm" weight="medium" color="muted">Todos</BondText>
      <span v-if="pending.length" class="todo-panel-badge">{{ pending.length }}</span>
    </div>
    <div class="todo-view">
      <div v-if="loading" class="todo-empty">
        <BondText size="sm" color="muted">Loading...</BondText>
      </div>

      <template v-else>
        <div class="todo-input-row">
          <textarea
            ref="inputRef"
            v-model="newRaw"
            class="todo-input todo-textarea"
            placeholder="Describe a todo... title, notes, and group will be extracted automatically"
            rows="1"
            @keydown="onInputKeydown"
            @input="autoResizeInput"
          />
          <BondButton variant="ghost" size="sm" icon :disabled="!newRaw.trim() || parsing" @click="addTodo">
            <PhSpinner v-if="parsing" :size="16" weight="bold" class="todo-spinner" />
            <PhPlus v-else :size="16" weight="bold" />
          </BondButton>
        </div>

        <div v-if="groups.length" class="todo-group-filters">
          <button
            class="todo-group-pill"
            :class="{ active: activeGroup === null }"
            @click="setFilter(null)"
          >All</button>
          <button
            v-for="g in groups"
            :key="g"
            class="todo-group-pill"
            :class="{ active: activeGroup === g }"
            @click="setFilter(g)"
          >{{ g }}</button>
        </div>

        <div v-if="pending.length === 0 && done.length === 0" class="todo-empty">
          <BondText size="sm" color="muted">No todos yet.</BondText>
        </div>

        <ul v-if="pending.length" class="todo-list">
          <li v-for="todo in pending" :key="todo.id" class="todo-item-wrapper" :class="{ expanded: expandedId === todo.id }">
            <div class="todo-item">
              <input type="checkbox" class="todo-checkbox" :checked="todo.done" @change="toggle(todo)" />
              <div class="todo-body" @click="toggleExpand(todo.id)">
                <span class="todo-text">{{ todo.text }}</span>
              </div>
              <button class="todo-hover-action" :class="{ 'todo-hover-action--visible': expandedId === todo.id }" @click.stop="emit('startChat', todo.notes ? `${todo.text}\n\n${todo.notes}` : todo.text)" v-tooltip="'Start a chat'">
                <PhChatCircle :size="14" weight="bold" />
              </button>
            </div>
            <div v-if="expandedId === todo.id" class="todo-detail">
              <template v-if="editingId === todo.id">
                <input
                  ref="titleInputRef"
                  v-model="titleInput"
                  class="todo-edit-title"
                  placeholder="Title..."
                  @keydown="onEditKeydown($event, todo)"
                />
                <textarea
                  ref="notesTextareaRef"
                  v-model="notesInput"
                  class="todo-notes-textarea"
                  placeholder="Notes..."
                  @keydown="onEditKeydown($event, todo)"
                  @input="autoResizeNotes"
                />
                <div class="todo-edit-group-row">
                  <PhTag :size="13" weight="bold" class="todo-edit-group-icon" />
                  <input
                    v-model="groupInput"
                    class="todo-edit-group-input"
                    placeholder="Group..."
                    @keydown="onEditKeydown($event, todo)"
                  />
                </div>
                <div class="todo-edit-actions">
                  <BondButton variant="ghost" size="sm" @click="cancelEdit">Cancel</BondButton>
                  <BondButton variant="primary" size="sm" @click="saveEdit(todo)">Save</BondButton>
                </div>
              </template>
              <template v-else>
                <div v-if="todo.notes" class="todo-notes-display">
                  {{ todo.notes }}
                </div>
                <div v-if="todo.group" class="todo-detail-group">
                  <PhTag :size="12" weight="bold" class="todo-detail-group-icon" />
                  <BondText size="xs" color="muted">{{ todo.group }}</BondText>
                </div>
                <div class="todo-detail-actions">
                  <button class="todo-detail-action" @click="startEdit(todo)">
                    <PhNotePencil :size="14" weight="bold" />
                    <span>Edit</span>
                  </button>
                  <button class="todo-detail-action todo-detail-action--delete" @click="remove(todo.id)">
                    <PhTrash :size="14" weight="bold" />
                    <span>Delete</span>
                  </button>
                </div>
              </template>
            </div>
          </li>
        </ul>

        <template v-if="done.length">
          <BondText as="div" size="xs" color="muted" class="todo-section-label">
            Done ({{ done.length }})
          </BondText>
          <ul class="todo-list">
            <li v-for="todo in done" :key="todo.id" class="todo-item-wrapper" :class="{ expanded: expandedId === todo.id }">
              <div class="todo-item done">
                <input type="checkbox" class="todo-checkbox" :checked="todo.done" @change="toggle(todo)" />
                <div class="todo-body" @click="toggleExpand(todo.id)">
                  <span class="todo-text">{{ todo.text }}</span>
                </div>
                <button class="todo-hover-action" :class="{ 'todo-hover-action--visible': expandedId === todo.id }" @click.stop="emit('startChat', todo.notes ? `${todo.text}\n\n${todo.notes}` : todo.text)" v-tooltip="'Start a chat'">
                  <PhChatCircle :size="14" weight="bold" />
                </button>
              </div>
              <div v-if="expandedId === todo.id" class="todo-detail">
                <div v-if="todo.notes" class="todo-notes-display done-notes">
                  {{ todo.notes }}
                </div>
                <div class="todo-detail-actions">
                  <button class="todo-detail-action todo-detail-action--delete" @click="remove(todo.id)">
                    <PhTrash :size="14" weight="bold" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.todo-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.todo-panel-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  height: var(--toolbar-height);
  padding-inline: 1rem;
  -webkit-app-region: drag;
}

.todo-panel-badge {
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

.todo-view {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem 1rem 2rem;
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
  align-items: flex-end;
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

.todo-textarea {
  resize: none;
  min-height: 2.25rem;
  max-height: 10rem;
  line-height: 1.5;
  overflow-y: auto;
  box-sizing: border-box;
}

.todo-input:focus {
  border-color: var(--color-accent, var(--color-border));
}

.todo-input::placeholder {
  color: var(--color-muted);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.todo-spinner {
  animation: spin 0.8s linear infinite;
}

.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.todo-item-wrapper {
  border-radius: var(--radius-md);
}

.todo-item-wrapper.expanded {
  background: var(--color-surface);
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 0.5rem;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.todo-item-wrapper:not(.expanded) .todo-item:hover {
  background: var(--color-surface);
}

.todo-checkbox {
  accent-color: var(--color-accent, #888);
  flex-shrink: 0;
  cursor: pointer;
  margin-top: 0.1875rem;
}

.todo-body {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
}

.todo-text {
  font-size: 0.875rem;
  color: var(--color-text-primary);
}

.todo-item.done .todo-text {
  text-decoration: line-through;
  color: var(--color-muted);
}

.todo-hover-action {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
}

.todo-item:hover .todo-hover-action,
.todo-hover-action--visible {
  opacity: 1;
}

.todo-hover-action:hover {
  background: var(--color-bg, rgba(0,0,0,0.05));
  color: var(--color-text-primary);
}

.todo-section-label {
  padding: 0.75rem 0.5rem 0.25rem;
}

/* --- Detail panel (expanded) --- */

.todo-detail {
  padding: 0.25rem 0.5rem 0.5rem 2rem;
}

.todo-edit-title {
  width: 100%;
  font-size: 0.875rem;
  font-family: inherit;
  font-weight: 500;
  color: var(--color-text-primary);
  background: var(--color-bg, #fff);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.375rem 0.625rem;
  outline: none;
  margin-bottom: 0.375rem;
  transition: border-color var(--transition-fast);
  box-sizing: border-box;
}

.todo-edit-title:focus {
  border-color: var(--color-accent, var(--color-border));
}

.todo-edit-title::placeholder {
  color: var(--color-muted);
  font-weight: 400;
}

.todo-notes-textarea {
  width: 100%;
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--color-text-primary);
  background: var(--color-bg, #fff);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.5rem 0.625rem;
  outline: none;
  resize: none;
  min-height: 3.5rem;
  line-height: 1.5;
  transition: border-color var(--transition-fast);
  box-sizing: border-box;
}

.todo-notes-textarea:focus {
  border-color: var(--color-accent, var(--color-border));
}

.todo-notes-textarea::placeholder {
  color: var(--color-muted);
}

.todo-notes-display {
  font-size: 0.8125rem;
  color: var(--color-text-secondary, var(--color-muted));
  line-height: 1.5;
  white-space: pre-wrap;
  padding: 0.25rem 0;
  border-radius: var(--radius-sm);
}

.todo-notes-display.done-notes {
  text-decoration: line-through;
  opacity: 0.6;
}

.todo-detail-group {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0;
}

.todo-detail-group-icon {
  color: var(--color-muted);
  opacity: 0.6;
}

/* --- Detail actions --- */

.todo-detail-actions {
  display: flex;
  gap: 0.125rem;
  margin-top: 0.375rem;
  padding-top: 0.375rem;
  border-top: 1px solid var(--color-border);
}

.todo-edit-group-row {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-top: 0.375rem;
}

.todo-edit-group-icon {
  color: var(--color-muted);
  flex-shrink: 0;
}

.todo-edit-group-input {
  flex: 1;
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--color-text-primary);
  background: var(--color-bg, #fff);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.25rem 0.5rem;
  outline: none;
  transition: border-color var(--transition-fast);
  box-sizing: border-box;
}

.todo-edit-group-input:focus {
  border-color: var(--color-accent, var(--color-border));
}

.todo-edit-group-input::placeholder {
  color: var(--color-muted);
}

.todo-edit-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.25rem;
  margin-top: 0.5rem;
}

.todo-detail-action {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--color-muted);
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.todo-detail-action:hover {
  background: var(--color-bg, rgba(0,0,0,0.03));
  color: var(--color-text-primary);
}

.todo-detail-action--delete:hover {
  color: var(--color-danger, #e55);
}

/* --- Groups --- */

.todo-group-filters {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.todo-group-pill {
  all: unset;
  font-size: 0.6875rem;
  font-family: inherit;
  padding: 0.1875rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  color: var(--color-muted);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.todo-group-pill:hover {
  background: var(--color-surface);
  color: var(--color-text-primary);
}

.todo-group-pill.active {
  background: var(--color-accent, var(--color-text-primary));
  color: var(--color-bg, #fff);
  border-color: var(--color-accent, var(--color-text-primary));
}


</style>
