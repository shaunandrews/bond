<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { PhPlus, PhTrash, PhChatCircle, PhNotePencil, PhTag, PhSpinner, PhFolder } from '@phosphor-icons/vue'
import type { TodoItem, Project } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'

const emit = defineEmits<{
  startChat: [text: string]
}>()

const todos = ref<TodoItem[]>([])
const projects = ref<Project[]>([])
const loading = ref(true)
const newRaw = ref('')
const parsing = ref(false)
const activeGroup = ref<string | null>(null)
const activeProjectId = ref<string | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const expandedId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const titleInput = ref('')
const notesInput = ref('')
const groupInput = ref('')
const projectInput = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)
const notesTextareaRef = ref<HTMLTextAreaElement | null>(null)

const groups = computed(() => {
  const set = new Set<string>()
  for (const t of todos.value) {
    if (t.group) set.add(t.group)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
})

const UNASSIGNED = '__unassigned__'

const projectsWithTodos = computed(() => {
  const ids = new Set<string>()
  for (const t of todos.value) {
    if (t.projectId) ids.add(t.projectId)
  }
  return projects.value.filter(p => ids.has(p.id))
})

const hasUnassigned = computed(() => todos.value.some(t => !t.projectId))

const filteredTodos = computed(() => {
  let list = todos.value
  if (activeGroup.value) list = list.filter(t => t.group === activeGroup.value)
  if (activeProjectId.value === UNASSIGNED) {
    list = list.filter(t => !t.projectId)
  } else if (activeProjectId.value) {
    list = list.filter(t => t.projectId === activeProjectId.value)
  }
  return list
})

const projectMap = computed(() => {
  const map = new Map<string, string>()
  for (const p of projects.value) map.set(p.id, p.name)
  return map
})

const pending = computed(() => filteredTodos.value.filter(t => !t.done))
const done = computed(() => filteredTodos.value.filter(t => t.done))

async function refreshTodos() {
  todos.value = await window.bond.listTodos()
}

async function refreshProjects() {
  projects.value = (await window.bond.listProjects()).filter(p => !p.archived)
}

let unsubTodoChanged: (() => void) | null = null
let unsubProjectsChanged: (() => void) | null = null

onMounted(async () => {
  try {
    await Promise.all([refreshTodos(), refreshProjects()])
  } finally {
    loading.value = false
  }
  unsubTodoChanged = window.bond.onTodoChanged(() => refreshTodos())
  unsubProjectsChanged = window.bond.onProjectsChanged(() => refreshProjects())
})

onUnmounted(() => {
  unsubTodoChanged?.()
  unsubProjectsChanged?.()
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

function setProjectFilter(projectId: string | null) {
  activeProjectId.value = activeProjectId.value === projectId ? null : projectId
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
  projectInput.value = todo.projectId ?? ''
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
  const projectId = projectInput.value || undefined
  const updated = await window.bond.updateTodo(todo.id, { text, notes, group, projectId })
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

// --- Drag and drop ---
const dragId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)
const dropPosition = ref<'before' | 'after'>('before')

function onDragStart(e: DragEvent, todo: TodoItem) {
  dragId.value = todo.id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', todo.id)
  }
}

function onDragOver(e: DragEvent, todo: TodoItem) {
  if (!dragId.value || dragId.value === todo.id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const midY = rect.top + rect.height / 2
  dropPosition.value = e.clientY < midY ? 'before' : 'after'
  dropTargetId.value = todo.id
}

function onDragLeave(e: DragEvent, todo: TodoItem) {
  // Only clear if actually leaving this element (not entering a child)
  const related = e.relatedTarget as HTMLElement | null
  const current = e.currentTarget as HTMLElement
  if (!related || !current.contains(related)) {
    if (dropTargetId.value === todo.id) dropTargetId.value = null
  }
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  if (!dragId.value || !dropTargetId.value || dragId.value === dropTargetId.value) {
    dragId.value = null
    dropTargetId.value = null
    return
  }

  // Reorder within the pending list (we only drag pending items)
  const ids = pending.value.map(t => t.id)
  const fromIdx = ids.indexOf(dragId.value)
  const toIdx = ids.indexOf(dropTargetId.value)
  if (fromIdx === -1 || toIdx === -1) return

  // Remove the dragged item and insert at the target position
  ids.splice(fromIdx, 1)
  const insertIdx = dropPosition.value === 'before' ? ids.indexOf(dropTargetId.value) : ids.indexOf(dropTargetId.value) + 1
  ids.splice(insertIdx, 0, dragId.value)

  // Append done items to maintain full order
  const doneIds = done.value.map(t => t.id)
  const allIds = [...ids, ...doneIds]

  dragId.value = null
  dropTargetId.value = null

  await window.bond.reorderTodos(allIds)
  await refreshTodos()
}

function onDragEnd() {
  dragId.value = null
  dropTargetId.value = null
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

        <div v-if="groups.length || projectsWithTodos.length" class="todo-filters">
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
          <div v-if="projectsWithTodos.length" class="todo-group-filters">
            <button
              v-for="p in projectsWithTodos"
              :key="p.id"
              class="todo-group-pill todo-project-pill"
              :class="{ active: activeProjectId === p.id }"
              @click="setProjectFilter(p.id)"
            ><PhFolder :size="11" weight="fill" /> {{ p.name }}</button>
            <button
              v-if="hasUnassigned"
              class="todo-group-pill todo-project-pill"
              :class="{ active: activeProjectId === UNASSIGNED }"
              @click="setProjectFilter(UNASSIGNED)"
            >Unassigned</button>
          </div>
        </div>

        <div v-if="pending.length === 0 && done.length === 0" class="todo-empty">
          <BondText size="sm" color="muted">No todos yet.</BondText>
        </div>

        <ul v-if="pending.length" class="list-none m-0 p-0 flex flex-col" @drop="onDrop">
          <li
            v-for="todo in pending"
            :key="todo.id"
            class="rounded-md transition-opacity"
            :class="{
              'bg-[var(--color-surface)]': expandedId === todo.id,
              'shadow-[inset_0_2px_0_0_var(--color-accent)]': dropTargetId === todo.id && dropPosition === 'before',
              'shadow-[inset_0_-2px_0_0_var(--color-accent)]': dropTargetId === todo.id && dropPosition === 'after',
              'opacity-30': dragId === todo.id
            }"
            draggable="true"
            @dragstart="onDragStart($event, todo)"
            @dragover="onDragOver($event, todo)"
            @dragleave="onDragLeave($event, todo)"
            @dragend="onDragEnd"
          >
            <div
              class="group flex items-start gap-2 py-1 px-2 rounded-md transition-colors"
              :class="{ 'hover:bg-[var(--color-surface)]': expandedId !== todo.id }"
            >
              <input
                type="checkbox"
                class="mt-[3px] size-3.5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                :checked="todo.done"
                @change="toggle(todo)"
              />
              <div class="flex-1 min-w-0 cursor-pointer" @click="toggleExpand(todo.id)">
                <span class="text-[13px] leading-5 text-[var(--color-text-primary)]">{{ todo.text }}</span>
              </div>
              <button
                class="shrink-0 size-5 flex items-center justify-center rounded-sm text-[var(--color-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-text-primary)]"
                :class="{ 'opacity-100': expandedId === todo.id, 'group-hover:opacity-100': true }"
                @click.stop="emit('startChat', todo.notes ? `${todo.text}\n\n${todo.notes}` : todo.text)"
                v-tooltip="'Start a chat'"
              >
                <PhChatCircle :size="13" weight="bold" />
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
                <div class="todo-edit-group-row">
                  <PhFolder :size="13" weight="fill" class="todo-edit-group-icon" />
                  <select
                    v-model="projectInput"
                    class="todo-edit-select"
                  >
                    <option value="">No project</option>
                    <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
                  </select>
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
                <div class="todo-detail-meta">
                  <div v-if="todo.group" class="todo-detail-group">
                    <PhTag :size="12" weight="bold" class="todo-detail-group-icon" />
                    <BondText size="xs" color="muted">{{ todo.group }}</BondText>
                  </div>
                  <div v-if="todo.projectId && projectMap.get(todo.projectId)" class="todo-detail-group">
                    <PhFolder :size="12" weight="fill" class="todo-detail-group-icon" />
                    <BondText size="xs" color="muted">{{ projectMap.get(todo.projectId) }}</BondText>
                  </div>
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
          <ul class="list-none m-0 p-0 flex flex-col">
            <li v-for="todo in done" :key="todo.id" class="rounded-md" :class="{ 'bg-[var(--color-surface)]': expandedId === todo.id }">
              <div
                class="group flex items-start gap-2 py-1 px-2 rounded-md transition-colors"
                :class="{ 'hover:bg-[var(--color-surface)]': expandedId !== todo.id }"
              >
                <input
                  type="checkbox"
                  class="mt-[3px] size-3.5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                  :checked="todo.done"
                  @change="toggle(todo)"
                />
                <div class="flex-1 min-w-0 cursor-pointer" @click="toggleExpand(todo.id)">
                  <span class="text-[13px] leading-5 text-[var(--color-muted)] line-through">{{ todo.text }}</span>
                </div>
                <button
                  class="shrink-0 size-5 flex items-center justify-center rounded-sm text-[var(--color-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg)] hover:text-[var(--color-text-primary)]"
                  :class="{ 'opacity-100': expandedId === todo.id, 'group-hover:opacity-100': true }"
                  @click.stop="emit('startChat', todo.notes ? `${todo.text}\n\n${todo.notes}` : todo.text)"
                  v-tooltip="'Start a chat'"
                >
                  <PhChatCircle :size="13" weight="bold" />
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

.todo-detail-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
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

.todo-edit-select {
  flex: 1;
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--color-text-primary);
  background: var(--color-bg, #fff);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.25rem 0.5rem;
  outline: none;
  cursor: pointer;
  transition: border-color var(--transition-fast);
  box-sizing: border-box;
  -webkit-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.5rem center;
  padding-right: 1.5rem;
}

.todo-edit-select:focus {
  border-color: var(--color-accent, var(--color-border));
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

/* --- Filters --- */

.todo-filters {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-bottom: 0.75rem;
}

.todo-group-filters {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
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

.todo-project-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}


</style>
