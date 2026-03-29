<script setup lang="ts">
import { ref, inject, computed, onMounted, onUnmounted } from 'vue'
import { PANEL_GROUP_KEY } from './panelTypes'

const props = withDefaults(defineProps<{
  id: string
  disabled?: boolean
  hitArea?: number
}>(), {
  disabled: false,
  hitArea: 8,
})

const group = inject(PANEL_GROUP_KEY)
if (!group) {
  throw new Error('BondPanelHandle must be used inside BondPanelGroup')
}

const state = ref<'inactive' | 'hover' | 'drag'>('inactive')
const handleEl = ref<HTMLElement | null>(null)

const isHorizontal = computed(() => group.direction.value === 'horizontal')

// Track the group element's pixel size so we can convert px deltas to percentages
let groupPixelSize = 0
let startPointerPos = 0
let accumulatedDelta = 0

function getGroupPixelSize(): number {
  const groupEl = handleEl.value?.parentElement
  if (!groupEl) return 1
  return isHorizontal.value ? groupEl.offsetWidth : groupEl.offsetHeight
}

function onPointerDown(e: PointerEvent) {
  if (props.disabled) return
  e.preventDefault()

  state.value = 'drag'
  groupPixelSize = getGroupPixelSize()
  startPointerPos = isHorizontal.value ? e.clientX : e.clientY
  accumulatedDelta = 0

  group.startResize(props.id)

  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)
  document.body.style.cursor = isHorizontal.value ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
}

function onPointerMove(e: PointerEvent) {
  const currentPos = isHorizontal.value ? e.clientX : e.clientY
  const pxDelta = currentPos - startPointerPos
  const percentDelta = (pxDelta / groupPixelSize) * 100

  // Move resize uses absolute delta from start, so we compute the incremental change
  const incrementalDelta = percentDelta - accumulatedDelta
  accumulatedDelta = percentDelta

  group.moveResize(incrementalDelta)
}

function onPointerUp() {
  state.value = 'inactive'
  group.endResize()

  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', onPointerUp)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

function onKeyDown(e: KeyboardEvent) {
  if (props.disabled) return

  const step = 5 // percentage
  let delta = 0

  if (isHorizontal.value) {
    if (e.key === 'ArrowLeft') delta = -step
    else if (e.key === 'ArrowRight') delta = step
  } else {
    if (e.key === 'ArrowUp') delta = -step
    else if (e.key === 'ArrowDown') delta = step
  }

  if (e.key === 'Home') delta = -100
  if (e.key === 'End') delta = 100

  if (delta !== 0) {
    e.preventDefault()
    group.keyboardResize(props.id, delta)
  }
}

function onMouseEnter() {
  if (state.value !== 'drag') state.value = 'hover'
}

function onMouseLeave() {
  if (state.value !== 'drag') state.value = 'inactive'
}

// Clean up on unmount in case drag is interrupted
onUnmounted(() => {
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', onPointerUp)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})
</script>

<template>
  <div
    ref="handleEl"
    class="bond-panel-handle"
    :class="[
      `bond-panel-handle--${group.direction.value}`,
      { 'bond-panel-handle--disabled': disabled }
    ]"
    :data-handle-id="id"
    :data-state="state"
    :data-direction="group.direction.value"
    role="separator"
    :tabindex="disabled ? -1 : 0"
    :aria-orientation="isHorizontal ? 'vertical' : 'horizontal'"
    :aria-disabled="disabled || undefined"
    @pointerdown="onPointerDown"
    @keydown="onKeyDown"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <div class="bond-panel-handle__bar" />
  </div>
</template>

<style scoped>
.bond-panel-handle {
  flex-shrink: 0;
  flex-grow: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 1;
  outline: none;
}

.bond-panel-handle--horizontal {
  width: 8px;
  cursor: col-resize;
  padding: 0 2px;
}

.bond-panel-handle--vertical {
  height: 8px;
  cursor: row-resize;
  padding: 2px 0;
}

.bond-panel-handle--disabled {
  cursor: default;
  pointer-events: none;
}

.bond-panel-handle__bar {
  border-radius: 2px;
  transition: background var(--transition-fast), opacity var(--transition-fast);
  background: var(--color-border);
  opacity: 0;
}

.bond-panel-handle--horizontal .bond-panel-handle__bar {
  width: 2px;
  height: 24px;
}

.bond-panel-handle--vertical .bond-panel-handle__bar {
  height: 2px;
  width: 24px;
}

.bond-panel-handle[data-state='hover'] .bond-panel-handle__bar,
.bond-panel-handle:focus-visible .bond-panel-handle__bar {
  opacity: 1;
  background: var(--color-muted);
}

.bond-panel-handle[data-state='drag'] .bond-panel-handle__bar {
  opacity: 1;
  background: var(--color-accent);
}

.bond-panel-handle:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
  border-radius: 2px;
}
</style>
