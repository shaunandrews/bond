<script setup lang="ts">
import { ref, computed, markRaw, nextTick, onUnmounted, type Component } from 'vue'
import { PhStar, PhRocket, PhLightning, PhCompass, PhTarget, PhShield, PhFlask, PhAtom, PhDiamond, PhCrown, PhBinoculars, PhFingerprint, PhMagicWand, PhPlanet, PhMountains, PhFire, PhSnowflake, PhAnchor, PhGlobe, PhLeaf } from '@phosphor-icons/vue'
import type { Session } from '../../shared/session'
import SessionPreview from './SessionPreview.vue'

const props = defineProps<{
  session: Session
  active?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  select: []
  unfavorite: []
  archive: []
  rename: [title: string]
  newIcon: [seed: number]
}>()

const icons: Component[] = [
  PhRocket, PhLightning, PhCompass, PhTarget, PhShield,
  PhFlask, PhAtom, PhDiamond, PhCrown, PhBinoculars,
  PhFingerprint, PhMagicWand, PhPlanet, PhMountains, PhFire,
  PhSnowflake, PhAnchor, PhGlobe, PhLeaf
].map(markRaw)

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

const iconIndex = computed(() => {
  const seed = props.session.iconSeed ?? hashString(props.session.id)
  return seed % icons.length
})
const icon = computed(() => icons[iconIndex.value])

function pickNewIcon() {
  const offset = 1 + Math.floor(Math.random() * (icons.length - 1))
  const newIdx = (iconIndex.value + offset) % icons.length
  emit('newIcon', newIdx)
}

/* Context menu */
async function onContextMenu(e: MouseEvent) {
  if (editing.value) return
  e.preventDefault()
  previewVisible.value = false
  const action = await window.bond.showContextMenu([
    { id: 'unfavorite', label: 'Unfavorite' },
    { id: 'newIcon', label: 'New Icon' },
    { id: 'sep', label: '', type: 'separator' },
    { id: 'rename', label: 'Rename' },
    { id: 'archive', label: 'Archive' },
  ])
  if (action === 'unfavorite') emit('unfavorite')
  else if (action === 'newIcon') pickNewIcon()
  else if (action === 'rename') startEditing()
  else if (action === 'archive') emit('archive')
}

/* Rename */
const editing = ref(false)
const editValue = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

function startEditing() {
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

/* Hover preview */
const SHOW_DELAY = 150
const SKIP_WINDOW = 500
let lastHideTime = 0

const cardEl = ref<HTMLElement | null>(null)
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
</script>

<template>
  <div
    ref="cardEl"
    role="button"
    tabindex="0"
    :class="['session-card', { active }]"
    @click="emit('select')"
    @keydown.enter="emit('select')"
    @keydown.space.prevent="emit('select')"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
    @mousemove="onMouseMove"
    @contextmenu="onContextMenu"
  >
    <button
      type="button"
      class="card-unfavorite"
      v-tooltip="'Unfavorite'"
      @click.stop="previewVisible = false; emit('unfavorite')"
    >
      <PhStar :size="12" weight="fill" />
    </button>
    <span v-if="busy" class="card-busy-dot" />
    <component :is="icon" :size="22" weight="duotone" class="card-icon" />
    <input
      v-if="editing"
      ref="inputRef"
      v-model="editValue"
      class="card-title-input"
      @blur="commitEdit"
      @keydown.stop="onInputKeydown"
      @click.stop
      @dblclick.stop
    />
    <span v-else class="card-title" @dblclick.stop="startEditing">{{ session.title }}</span>

    <SessionPreview
      :session="session"
      :visible="previewVisible"
      :mouseX="mouseX"
      :mouseY="mouseY"
    />

  </div>
</template>

<style scoped>
.session-card {
  all: unset;
  cursor: pointer;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 0.75rem 0.5rem;
  border-radius: var(--radius-lg);
  background: var(--sidebar-hover-bg);
  position: relative;
  transition: background var(--transition-fast);
  min-width: 0;
  overflow: hidden;
}

.session-card:hover {
  background: var(--sidebar-active-bg);
}

.session-card.active {
  background: var(--sidebar-active-bg);
}

.card-icon {
  color: var(--color-accent);
  flex-shrink: 0;
}

.card-title {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--sidebar-text);
  text-align: center;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.2;
}

.card-unfavorite {
  all: unset;
  cursor: pointer;
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
  width: 18px;
  height: 18px;
  display: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--color-accent);
  transition: background var(--transition-fast);
}

.session-card:hover .card-unfavorite {
  display: flex;
}

.card-unfavorite:hover {
  background: var(--sidebar-hover-bg);
}

.card-title-input {
  width: 100%;
  min-width: 0;
  font-size: 0.75rem;
  font-weight: 500;
  font-family: inherit;
  color: var(--sidebar-text);
  background: var(--color-surface);
  border: 1px solid var(--color-accent, var(--color-border));
  border-radius: var(--radius-sm);
  padding: 0 0.25rem;
  outline: none;
  text-align: center;
  height: 1.25rem;
  box-sizing: border-box;
}

.card-busy-dot {
  position: absolute;
  top: 0.375rem;
  left: 0.375rem;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent);
  animation: card-pulse 2s ease-in-out infinite;
}

@keyframes card-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
</style>
