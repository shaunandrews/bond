<script setup lang="ts">
import { ref, nextTick, onUnmounted } from 'vue'
import type { Session } from '../../shared/session'
import SessionPreview from './SessionPreview.vue'

const props = defineProps<{
  session: Session
  active?: boolean
  archived?: boolean
  generating?: boolean
  busy?: boolean
  actionTitle: string
}>()

const emit = defineEmits<{
  select: []
  action: []
  rename: [title: string]
}>()

const editing = ref(false)
const editValue = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

/* Hover preview — shared across instances */
const SHOW_DELAY = 150
const SKIP_WINDOW = 500
let lastHideTime = 0

const itemEl = ref<HTMLElement | null>(null)
const previewVisible = ref(false)
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function onMouseEnter() {
  if (editing.value) return
  const elapsed = Date.now() - lastHideTime
  if (elapsed < SKIP_WINDOW) {
    previewVisible.value = true
  } else {
    hoverTimer = setTimeout(() => { previewVisible.value = true }, SHOW_DELAY)
  }
}

function onMouseLeave() {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
  if (previewVisible.value) lastHideTime = Date.now()
  previewVisible.value = false
}

onUnmounted(() => {
  if (hoverTimer) clearTimeout(hoverTimer)
})

function startEditing() {
  if (props.generating || props.archived) return
  previewVisible.value = false
  editing.value = true
  editValue.value = props.session.title
  nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}

function commitEdit() {
  if (!editing.value) return
  editing.value = false
  const trimmed = editValue.value.trim()
  if (trimmed && trimmed !== props.session.title) {
    emit('rename', trimmed)
  }
}

function cancelEdit() {
  editing.value = false
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitEdit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  }
}

</script>

<template>
  <div
    ref="itemEl"
    role="button"
    tabindex="0"
    :class="['session-item', { active, archived }]"
    @click="emit('select')"
    @keydown.enter="emit('select')"
    @keydown.space.prevent="emit('select')"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <input
      v-if="editing"
      ref="inputRef"
      v-model="editValue"
      class="session-title-input"
      @blur="commitEdit"
      @keydown="onInputKeydown"
      @click.stop
      @dblclick.stop
    />
    <span v-else :class="['session-title', { generating }]" @dblclick.stop="startEditing">
      {{ generating ? 'Naming...' : session.title }}
    </span>
    <span class="session-end">
      <span v-if="busy" class="session-busy-dot" />
      <button
        type="button"
        class="session-action"
        v-tooltip="actionTitle"
        @click.stop="emit('action')"
      >
        <slot />
      </button>
    </span>

    <SessionPreview
      :session="session"
      :anchor="itemEl"
      :visible="previewVisible"
    />
  </div>
</template>

<style scoped>
.session-item {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.3rem 0.5rem 0.5rem;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}
.session-item:hover {
  background: var(--sidebar-hover-bg);
}
.session-item.active {
  background: var(--sidebar-active-bg);
}

.session-title {
  flex: 1;
  min-width: 0;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--sidebar-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-item.archived .session-title {
  color: var(--sidebar-text-muted);
}
.session-title.generating {
  color: var(--sidebar-text-muted);
  font-style: italic;
}

.session-end {
  flex-shrink: 0;
  width: 24px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.session-action {
  all: unset;
  cursor: pointer;
  width: 22px;
  height: 22px;
  display: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  color: var(--sidebar-text-muted);
  transition: background var(--transition-fast);
}
.session-item:hover .session-busy-dot {
  display: none;
}
.session-item:hover .session-action {
  display: flex;
}
.session-action:hover {
  background: var(--sidebar-hover-bg);
  color: var(--sidebar-text);
}

.session-busy-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
  animation: session-pulse 2s ease-in-out infinite;
}

@keyframes session-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.session-title-input {
  flex: 1;
  min-width: 0;
  font-size: 0.875rem;
  font-weight: 500;
  font-family: inherit;
  color: var(--sidebar-text);
  background: var(--color-surface);
  border: 1px solid var(--color-accent, var(--color-border));
  border-radius: var(--radius-sm);
  padding: 0 0.25rem;
  outline: none;
  height: 1.5rem;
}
</style>
