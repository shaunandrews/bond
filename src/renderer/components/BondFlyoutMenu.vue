<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'

const props = defineProps<{
  open: boolean
  anchor: HTMLElement | null
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  width?: number
  padding?: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const menuEl = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0 })
const flipped = ref(false)

function updatePosition() {
  if (!props.anchor || !menuEl.value) return
  const anchorRect = props.anchor.getBoundingClientRect()
  const menuRect = menuEl.value.getBoundingClientRect()
  const p = props.placement ?? 'bottom-start'
  const gap = 4
  const vh = window.innerHeight
  const vw = window.innerWidth

  const wantsBottom = p.startsWith('bottom')
  const wantsEnd = p.endsWith('end')

  // Vertical: try preferred side, flip if it overflows
  let top: number
  if (wantsBottom) {
    top = anchorRect.bottom + gap
    if (top + menuRect.height > vh) {
      // Flip to top
      top = anchorRect.top - gap - menuRect.height
      flipped.value = true
    } else {
      flipped.value = false
    }
  } else {
    top = anchorRect.top - gap - menuRect.height
    if (top < 0) {
      // Flip to bottom
      top = anchorRect.bottom + gap
      flipped.value = true
    } else {
      flipped.value = false
    }
  }

  // Horizontal: align to anchor edge, clamp to viewport
  let left: number
  if (wantsEnd) {
    left = anchorRect.right - menuRect.width
  } else {
    left = anchorRect.left
  }
  left = Math.max(4, Math.min(left, vw - menuRect.width - 4))

  pos.value = { top, left }
}

let resizeObserver: ResizeObserver | null = null

function startTracking() {
  document.addEventListener('scroll', updatePosition, { capture: true, passive: true })
  window.addEventListener('resize', updatePosition, { passive: true })
  resizeObserver = new ResizeObserver(updatePosition)
  if (menuEl.value) resizeObserver.observe(menuEl.value)
}

function stopTracking() {
  document.removeEventListener('scroll', updatePosition, { capture: true })
  window.removeEventListener('resize', updatePosition)
  resizeObserver?.disconnect()
  resizeObserver = null
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    nextTick(() => nextTick(() => {
      updatePosition()
      startTracking()
    }))
  } else {
    stopTracking()
  }
})

function handleClickOutside(e: MouseEvent) {
  if (!props.open) return
  const target = e.target as Node
  // Ignore clicks on the anchor (toggle button handles that)
  if (props.anchor?.contains(target)) return
  if (menuEl.value?.contains(target)) return
  emit('close')
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) {
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
  document.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  document.removeEventListener('keydown', handleKeyDown)
  stopTracking()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="bond-flyout">
      <div
        v-if="open"
        ref="menuEl"
        class="bond-flyout-menu"
        :class="[
          (placement?.startsWith('top') !== flipped) ? 'origin-bottom' : 'origin-top',
          { padded: padding },
        ]"
        :style="{
          top: pos.top + 'px',
          left: pos.left + 'px',
          width: width ? width + 'px' : undefined,
        }"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.bond-flyout-menu {
  position: fixed;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: 50;
  outline: none;
  display: flex;
  flex-direction: column;
}

.bond-flyout-menu.padded {
  padding: 4px;
}

.origin-top {
  transform-origin: top left;
}

.origin-bottom {
  transform-origin: bottom left;
}

.bond-flyout-enter-active,
.bond-flyout-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}
.bond-flyout-enter-from,
.bond-flyout-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
</style>
