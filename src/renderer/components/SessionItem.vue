<script setup lang="ts">
import { ref, nextTick } from 'vue'
import type { Session } from '../../shared/session'

const props = defineProps<{
  session: Session
  active?: boolean
  archived?: boolean
  generating?: boolean
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

function startEditing() {
  if (props.generating || props.archived) return
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

function formatTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`
  const weeks = Math.floor(diff / 604_800_000)
  if (weeks < 52) return `${weeks}w`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div
    role="button"
    tabindex="0"
    :class="['session-item', { active, archived }]"
    @click="emit('select')"
    @keydown.enter="emit('select')"
    @keydown.space.prevent="emit('select')"
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
      <span class="session-meta">{{ formatTime(session.updatedAt) }}</span>
      <button
        type="button"
        class="session-action"
        v-tooltip="actionTitle"
        @click.stop="emit('action')"
      >
        <slot />
      </button>
    </span>
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

.session-meta {
  font-size: 0.7rem;
  color: var(--sidebar-text-faint);
  transition: opacity var(--transition-fast);
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
.session-item:hover .session-action {
  display: flex;
}
.session-item:hover .session-meta {
  display: none;
}
.session-action:hover {
  background: var(--sidebar-hover-bg);
  color: var(--sidebar-text);
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
