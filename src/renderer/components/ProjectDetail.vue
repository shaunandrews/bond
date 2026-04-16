<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import {
  PhPlus, PhTrash, PhFolder, PhFile, PhLink,
  PhGlobe, PhCode, PhPresentation, PhCube, PhCalendar,
  PhSpinner, PhArrowUp
} from '@phosphor-icons/vue'
import type { Project, ProjectType, ProjectResource, TodoItem } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondSelect from './BondSelect.vue'
import { useTodoPrompt } from '../composables/useTodoPrompt'

const props = defineProps<{
  project: Project
  compact?: boolean
}>()

const emit = defineEmits<{
  addResource: [projectId: string, kind: 'path' | 'file' | 'link', value: string, label?: string]
  removeResource: [projectId: string, resourceId: string]
  updateDeadline: [projectId: string, deadline: string]
  viewMarkdown: [filePath: string]
}>()

const todos = ref<TodoItem[]>([])
let unsubTodoChanged: (() => void) | null = null

// Todo input
const todoGroups = computed(() => {
  const set = new Set<string>()
  for (const t of todos.value) {
    if (t.group) set.add(t.group)
  }
  return [...set]
})

const { text: newTodoText, parsing: todoParsing, submit: submitTodo } = useTodoPrompt({
  projectId: computed(() => props.project.id),
  existingGroups: todoGroups
})
const todoInputRef = ref<HTMLTextAreaElement | null>(null)

// Resource input
const showResourceForm = ref(false)
const resourceKind = ref<ProjectResource['kind']>('path')
const resourceValue = ref('')
const resourceLabel = ref('')
const resourceValueRef = ref<HTMLInputElement | null>(null)

const RESOURCE_KIND_OPTIONS = [
  { value: 'path', label: 'Folder' },
  { value: 'file', label: 'File' },
  { value: 'link', label: 'Link' },
]

const projectTodos = computed(() =>
  todos.value.filter(t => t.projectId === props.project.id)
)
const pendingTodos = computed(() => projectTodos.value.filter(t => !t.done))
const doneTodos = computed(() => projectTodos.value.filter(t => t.done))

const TYPE_META: Record<ProjectType, { label: string; icon: typeof PhCube }> = {
  wordpress: { label: 'WordPress', icon: PhGlobe },
  web: { label: 'Web', icon: PhCode },
  presentation: { label: 'Presentation', icon: PhPresentation },
  generic: { label: 'Generic', icon: PhCube },
}

const RESOURCE_ICONS = { path: PhFolder, file: PhFile, link: PhLink }

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDeadline(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

async function refreshTodos() {
  try { todos.value = await window.bond.listTodos() } catch { /* ignore */ }
}

onMounted(() => {
  refreshTodos()
  unsubTodoChanged = window.bond.onTodoChanged(() => refreshTodos())
})

onUnmounted(() => {
  unsubTodoChanged?.()
})

// --- Todo actions ---

async function addTodo(literal = false) {
  const result = await submitTodo({ literal })
  if (result.todos.length) {
    await refreshTodos()
    nextTick(() => todoInputRef.value?.focus())
  }
}

function autoResizeInput() {
  const el = todoInputRef.value
  if (el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }
}

async function toggleTodo(todo: TodoItem) {
  const updated = await window.bond.updateTodo(todo.id, { done: !todo.done })
  if (updated) {
    const idx = todos.value.findIndex(t => t.id === todo.id)
    if (idx !== -1) todos.value[idx] = updated
  }
}

async function removeTodo(id: string) {
  const ok = await window.bond.deleteTodo(id)
  if (ok) todos.value = todos.value.filter(t => t.id !== id)
}

// --- Resource actions ---

function openResourceForm() {
  showResourceForm.value = true
  resourceKind.value = 'path'
  resourceValue.value = ''
  resourceLabel.value = ''
  nextTick(() => resourceValueRef.value?.focus())
}

function cancelResourceForm() {
  showResourceForm.value = false
}

function submitResource() {
  const value = resourceValue.value.trim()
  if (!value) return
  const label = resourceLabel.value.trim() || undefined
  emit('addResource', props.project.id, resourceKind.value, value, label)
  showResourceForm.value = false
}

function openResource(kind: string, value: string) {
  if (kind === 'link') {
    window.dispatchEvent(new CustomEvent('bond:openInBrowser', { detail: value }))
  } else if (value.endsWith('.md') || value.endsWith('.markdown')) {
    emit('viewMarkdown', value)
  } else {
    window.bond.openPath(value)
  }
}
</script>

<template>
  <div :class="['project-detail', { compact }]">
    <!-- Meta: type badge + date -->
    <div class="pd-meta">
      <span class="pd-badge">
        <component :is="TYPE_META[project.type].icon" :size="12" weight="bold" />
        {{ TYPE_META[project.type].label }}
      </span>
      <span v-if="project.deadline" class="pd-badge">
        <PhCalendar :size="11" weight="bold" />
        {{ formatDeadline(project.deadline) }}
      </span>
      <BondText v-if="!compact" size="xs" color="muted">Created {{ formatDate(project.createdAt) }}</BondText>
    </div>

    <!-- Deadline (editable, full view only) -->
    <div v-if="!compact" class="pd-deadline-row">
      <PhCalendar :size="14" weight="bold" class="pd-deadline-icon" />
      <BondText size="xs" color="muted">Deadline</BondText>
      <input
        type="date"
        class="pd-deadline-input"
        :value="project.deadline ?? ''"
        @input="emit('updateDeadline', project.id, ($event.target as HTMLInputElement).value)"
        @change="emit('updateDeadline', project.id, ($event.target as HTMLInputElement).value)"
      />
      <button
        v-if="project.deadline"
        class="pd-deadline-clear"
        @click="emit('updateDeadline', project.id, '')"
        v-tooltip="'Clear deadline'"
      >
        <PhTrash :size="12" weight="bold" />
      </button>
    </div>

    <!-- Goal -->
    <div v-if="project.goal" class="pd-goal">
      <BondText size="sm">{{ project.goal }}</BondText>
    </div>

    <!-- Resources -->
    <div class="pd-section">
      <div class="pd-section-header">
        <BondText size="xs" weight="medium" color="muted">Resources</BondText>
        <BondButton variant="ghost" size="sm" icon @click="openResourceForm" v-tooltip="'Add resource'" class="pd-section-add">
          <PhPlus :size="14" weight="bold" />
        </BondButton>
      </div>

      <!-- Add resource form -->
      <div v-if="showResourceForm" class="pd-resource-form">
        <div class="pd-resource-form-row">
          <BondSelect :modelValue="resourceKind" @update:modelValue="resourceKind = $event as any" :options="RESOURCE_KIND_OPTIONS" size="sm" />
          <input
            ref="resourceValueRef"
            v-model="resourceValue"
            class="pd-form-input"
            :placeholder="resourceKind === 'link' ? 'https://...' : '/path/to/...'"
            @keydown.enter="submitResource"
            @keydown.escape="cancelResourceForm"
          />
        </div>
        <div class="pd-resource-form-row">
          <input
            v-model="resourceLabel"
            class="pd-form-input"
            placeholder="Label (optional)"
            @keydown.enter="submitResource"
            @keydown.escape="cancelResourceForm"
          />
        </div>
        <div class="pd-resource-form-actions">
          <BondButton variant="ghost" size="sm" @click="cancelResourceForm">Cancel</BondButton>
          <BondButton variant="primary" size="sm" :disabled="!resourceValue.trim()" @click="submitResource">Add</BondButton>
        </div>
      </div>

      <div v-if="project.resources.length === 0 && !showResourceForm" class="pd-empty">
        <BondText size="sm" color="muted">No resources yet.</BondText>
      </div>
      <ul v-if="project.resources.length" class="pd-resource-list">
        <li v-for="r in project.resources" :key="r.id" class="pd-resource-item" @click="openResource(r.kind, r.value)" v-tooltip="r.value">
          <component :is="RESOURCE_ICONS[r.kind]" :size="14" weight="bold" class="pd-resource-icon" />
          <span class="pd-resource-value">{{ r.label || r.value }}</span>
          <button class="pd-resource-remove" @click.stop="emit('removeResource', project.id, r.id)" v-tooltip="'Remove'">
            <PhTrash :size="12" weight="bold" />
          </button>
        </li>
      </ul>
    </div>

    <!-- Todos -->
    <div class="pd-section">
      <div class="pd-section-header">
        <BondText size="xs" weight="medium" color="muted">Todos</BondText>
        <span v-if="pendingTodos.length" class="pd-todo-count">{{ pendingTodos.length }}</span>
      </div>

      <div v-if="projectTodos.length === 0" class="pd-empty">
        <BondText size="sm" color="muted">No todos yet.</BondText>
      </div>
      <ul v-if="pendingTodos.length" class="pd-todo-list">
        <li v-for="t in pendingTodos" :key="t.id" class="pd-todo-item">
          <input type="checkbox" class="pd-todo-checkbox" @change="toggleTodo(t)" />
          <BondText size="sm" class="pd-todo-text">{{ t.text }}</BondText>
          <button class="pd-todo-remove" @click="removeTodo(t.id)" v-tooltip="'Delete'">
            <PhTrash :size="12" weight="bold" />
          </button>
        </li>
      </ul>
      <template v-if="doneTodos.length">
        <BondText as="div" size="xs" color="muted" class="pd-done-label">Done ({{ doneTodos.length }})</BondText>
        <ul class="pd-todo-list">
          <li v-for="t in doneTodos" :key="t.id" class="pd-todo-item done">
            <input type="checkbox" class="pd-todo-checkbox" checked @change="toggleTodo(t)" />
            <BondText size="sm" color="muted" class="pd-todo-text line-through">{{ t.text }}</BondText>
            <button class="pd-todo-remove" @click="removeTodo(t.id)" v-tooltip="'Delete'">
              <PhTrash :size="12" weight="bold" />
            </button>
          </li>
        </ul>
      </template>
    </div>

    <!-- Sticky todo input -->
    <div class="pd-input-footer">
      <div class="pd-chat-box">
        <textarea
          ref="todoInputRef"
          v-model="newTodoText"
          class="pd-chat-textarea"
          placeholder="What do you need to do?"
          rows="1"
          @keydown.enter.shift.prevent="addTodo(true)"
          @keydown.enter.exact.prevent="addTodo(false)"
          @input="autoResizeInput"
        />
        <div class="pd-chat-toolbar">
          <button
            type="button"
            class="pd-send-btn"
            :disabled="!newTodoText.trim() || todoParsing"
            @click="addTodo()"
          >
            <PhSpinner v-if="todoParsing" :size="14" weight="bold" class="pd-todo-spinner" />
            <PhArrowUp v-else :size="14" weight="bold" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.project-detail {
  padding: 1rem 1.5rem 0;
  max-width: 640px;
  margin-inline: auto;
}

.project-detail.compact {
  padding: 0.75rem 0.75rem 0;
  max-width: none;
}

/* --- Meta --- */

.pd-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.pd-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 0.125rem 0.4375rem;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  color: var(--color-muted);
}

/* --- Deadline --- */

.pd-deadline-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.pd-deadline-icon {
  color: var(--color-muted);
}

.pd-deadline-input {
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 0.1875rem 0.375rem;
  outline: none;
  transition: border-color var(--transition-fast);
  color-scheme: light dark;
}

.pd-deadline-input:focus {
  border-color: var(--color-accent, var(--color-border));
}

.pd-deadline-clear {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  transition: color var(--transition-fast);
}

.pd-deadline-clear:hover {
  color: var(--color-err);
}

/* --- Goal --- */

.pd-goal {
  padding: 0.625rem 0.75rem;
  background: var(--color-surface);
  border-radius: var(--radius-md);
  line-height: 1.5;
  margin-bottom: 1.25rem;
}

.compact .pd-goal {
  padding: 0.5rem 0.625rem;
  margin-bottom: 1rem;
}

/* --- Sections --- */

.pd-section {
  margin-bottom: 1.25rem;
}

.compact .pd-section {
  margin-bottom: 1rem;
}

.pd-section-header {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding-bottom: 0.375rem;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 0.5rem;
}

.pd-section-add {
  margin-left: auto;
}

.pd-empty {
  padding: 0.75rem 0;
  text-align: center;
}

/* --- Resources --- */

.pd-resource-form {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-bottom: 0.75rem;
  padding: 0.625rem;
  background: var(--color-surface);
  border-radius: var(--radius-md);
}

.pd-resource-form-row {
  display: flex;
  gap: 0.375rem;
  align-items: center;
}

.pd-form-input {
  flex: 1;
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--color-text-primary);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 0.3125rem 0.5rem;
  outline: none;
  transition: border-color var(--transition-fast);
  box-sizing: border-box;
}

.compact .pd-form-input {
  font-size: 0.75rem;
  padding: 0.25rem 0.4375rem;
}

.pd-form-input:focus {
  border-color: var(--color-accent, var(--color-border));
}

.pd-form-input::placeholder {
  color: var(--color-muted);
}

.pd-resource-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.25rem;
}

.pd-resource-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.pd-resource-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.compact .pd-resource-item {
  gap: 0.375rem;
  padding: 0.25rem 0.375rem;
}

.pd-resource-item:hover {
  background: var(--color-surface);
}

.pd-resource-icon {
  flex-shrink: 0;
  color: var(--color-muted);
}

.pd-resource-value {
  flex: 1;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact .pd-resource-value {
  font-size: 0.75rem;
}

.pd-resource-remove {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast);
}

.pd-resource-item:hover .pd-resource-remove {
  opacity: 1;
}

.pd-resource-remove:hover {
  color: var(--color-err);
}

/* --- Todos --- */

.pd-todo-count {
  font-size: 0.625rem;
  font-weight: 600;
  line-height: 1;
  min-width: 1rem;
  height: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.25rem;
  border-radius: 999px;
  background: var(--color-accent, var(--color-text-primary));
  color: var(--color-bg, #fff);
}

/* --- Sticky chat-style input footer --- */

.pd-input-footer {
  position: sticky;
  bottom: 0;
  z-index: 10;
  padding: 0.5rem 0 1rem;
  pointer-events: none;
}

.pd-input-footer > * {
  pointer-events: auto;
}

.pd-input-footer::before {
  content: '';
  position: absolute;
  top: -12px;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: -1;
  backdrop-filter: blur(8px);
  mask-image: linear-gradient(to bottom, transparent, black 24px);
}

.pd-chat-box {
  border-radius: 18px 18px 22px 12px;
  padding: 6px;
  background: var(--color-tint);
  backdrop-filter: blur(24px);
  transition: all var(--transition-fast);
}

.pd-chat-box:focus-within {
  box-shadow: 0 0 0 2px var(--color-accent);
  background: var(--color-surface);
}

.pd-chat-textarea {
  display: block;
  width: 100%;
  resize: none;
  max-height: 8rem;
  overflow-y: auto;
  padding: 0.5rem 0.625rem 0.25rem;
  border-radius: var(--radius-xl);
  color: var(--color-text-primary);
  font: inherit;
  font-size: 0.8125rem;
  line-height: 1.5;
  outline: none;
  background: transparent;
  border: none;
  box-sizing: border-box;
}

.pd-chat-textarea::placeholder {
  color: var(--color-muted);
}

.pd-chat-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-top: 2px;
}

.pd-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 9999px;
  border: none;
  cursor: pointer;
  background: var(--color-accent);
  color: #fff;
  transition: opacity var(--transition-fast);
}

.pd-send-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.pd-send-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

@keyframes pd-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.pd-todo-spinner {
  animation: pd-spin 0.8s linear infinite;
}

.pd-todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.pd-todo-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3125rem 0.5rem;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.compact .pd-todo-item {
  gap: 0.375rem;
  padding: 0.1875rem 0.375rem;
}

.pd-todo-item:hover {
  background: var(--color-surface);
}

.pd-todo-checkbox {
  accent-color: var(--color-accent, #888);
  flex-shrink: 0;
  cursor: pointer;
}

.pd-todo-text {
  flex: 1;
  min-width: 0;
}

.pd-todo-remove {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast);
}

.pd-todo-item:hover .pd-todo-remove {
  opacity: 1;
}

.pd-todo-remove:hover {
  color: var(--color-err);
}

.pd-done-label {
  padding: 0.5rem 0.5rem 0.25rem;
}

.line-through {
  text-decoration: line-through;
}
</style>
