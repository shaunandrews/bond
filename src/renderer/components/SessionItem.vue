<script setup lang="ts">
import { ref, nextTick, onUnmounted } from 'vue'
import { PhStar } from '@phosphor-icons/vue'
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
  favorite: []
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
const mouseX = ref(0)
const mouseY = ref(0)
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function onMouseMove(e: MouseEvent) {
  mouseX.value = e.clientX
  mouseY.value = e.clientY
}

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

/* Context menu */
async function onContextMenu(e: MouseEvent) {
  if (props.archived || props.generating || editing.value) return
  e.preventDefault()
  previewVisible.value = false
  const action = await window.bond.showContextMenu([
    { id: 'favorite', label: props.session.favorited ? 'Unfavorite' : 'Favorite' },
    { id: 'sep', label: '', type: 'separator' },
    { id: 'rename', label: 'Rename' },
    { id: 'archive', label: 'Archive' },
  ])
  if (action === 'favorite') emit('favorite')
  else if (action === 'rename') startEditing()
  else if (action === 'archive') emit('action')
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
    @mousemove="onMouseMove"
    @contextmenu="onContextMenu"
  >
    <input
      v-if="editing"
      ref="inputRef"
      v-model="editValue"
      class="session-title-input"
      @blur="commitEdit"
      @keydown.stop="onInputKeydown"
      @click.stop
      @dblclick.stop
    />
    <span v-else :class="['session-title', { generating }]" @dblclick.stop="startEditing">
      {{ generating ? 'Naming...' : session.title }}
    </span>
    <span class="session-end">
      <span v-if="busy" class="session-busy-dot" />
      <button
        v-if="!archived"
        type="button"
        :class="['session-favorite', { active: session.favorited }]"
        v-tooltip="session.favorited ? 'Unfavorite' : 'Favorite'"
        @click.stop="previewVisible = false; emit('favorite')"
      >
        <PhStar :size="13" :weight="session.favorited ? 'fill' : 'bold'" />
      </button>
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
      :visible="previewVisible"
      :mouseX="mouseX"
      :mouseY="mouseY"
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
  min-height: 38px;
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
  display: flex;
  align-items: center;
  gap: 0;
}

.session-favorite,
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
  transition: background var(--transition-fast), color var(--transition-fast);
}
.session-favorite.active {
  display: flex;
  color: var(--color-accent);
}
.session-item:hover .session-busy-dot {
  display: none;
}
.session-item:hover .session-favorite,
.session-item:hover .session-action {
  display: flex;
}
.session-favorite:hover,
.session-action:hover {
  background: var(--sidebar-hover-bg);
  color: var(--sidebar-text);
}
.session-favorite.active:hover {
  color: var(--color-accent);
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
