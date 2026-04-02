<script setup lang="ts">
import { ref, watch, onUnmounted, nextTick } from 'vue'
import type { Session } from '../../shared/session'
import BondText from './BondText.vue'

const props = defineProps<{
  session: Session
  anchor: HTMLElement | null
  visible: boolean
}>()

const panelEl = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0 })

function updatePosition() {
  if (!props.anchor || !panelEl.value) return
  const anchorRect = props.anchor.getBoundingClientRect()
  const panelRect = panelEl.value.getBoundingClientRect()
  const vh = window.innerHeight
  const gap = 6

  // Position to the right of the sidebar item
  const left = anchorRect.right + gap

  // Vertically align to the anchor, clamped to viewport
  let top = anchorRect.top
  if (top + panelRect.height > vh - 8) {
    top = vh - panelRect.height - 8
  }
  top = Math.max(8, top)

  pos.value = { top, left }
}

watch(() => props.visible, (show) => {
  if (show) {
    nextTick(() => nextTick(updatePosition))
  }
})

// Reposition on scroll/resize while visible
function onScroll() { if (props.visible) updatePosition() }
function onResize() { if (props.visible) updatePosition() }

document.addEventListener('scroll', onScroll, { capture: true, passive: true })
window.addEventListener('resize', onResize, { passive: true })

onUnmounted(() => {
  document.removeEventListener('scroll', onScroll, { capture: true })
  window.removeEventListener('resize', onResize)
})

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return formatDate(iso)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="session-preview">
      <div
        v-if="visible"
        ref="panelEl"
        class="session-preview"
        :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
      >
        <div class="preview-header">
          <BondText as="div" size="sm" weight="semibold" color="primary" class="preview-title">
            {{ session.title }}
          </BondText>
        </div>

        <div class="preview-meta">
          <span class="meta-item">
            <span class="meta-label">Updated</span>
            <span class="meta-value">{{ formatRelative(session.updatedAt) }}</span>
          </span>
          <span class="meta-item">
            <span class="meta-label">Created</span>
            <span class="meta-value">{{ formatDate(session.createdAt) }}, {{ formatTime(session.createdAt) }}</span>
          </span>
        </div>

        <div v-if="session.summary" class="preview-summary">
          <BondText as="p" size="xs" color="muted">{{ session.summary }}</BondText>
        </div>

        <div v-if="session.projectId" class="preview-badge">
          <span class="badge">Project</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.session-preview {
  position: fixed;
  width: 260px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: 45;
  padding: 0.625rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  pointer-events: none;
}

.preview-header {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
}

.preview-title {
  line-height: 1.3;
  /* Allow wrapping — sidebar truncates, but preview shows full title */
}

.preview-meta {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.meta-item {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  font-size: 0.6875rem;
  line-height: 1.4;
}

.meta-label {
  color: var(--color-text-muted, var(--sidebar-text-muted));
  flex-shrink: 0;
  min-width: 3rem;
}

.meta-value {
  color: var(--color-text-secondary, var(--sidebar-text));
}

.preview-summary {
  border-top: 1px solid var(--color-border);
  padding-top: 0.375rem;
  line-height: 1.45;
}

.preview-summary p {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.preview-badge {
  display: flex;
  gap: 0.25rem;
}

.badge {
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-sm);
  background: var(--color-accent, var(--color-text-primary));
  color: var(--color-bg, #fff);
  opacity: 0.85;
}

/* Transition */
.session-preview-enter-active {
  transition: opacity 120ms ease-out, transform 120ms ease-out;
}
.session-preview-leave-active {
  transition: opacity 80ms ease-in, transform 80ms ease-in;
}
.session-preview-enter-from,
.session-preview-leave-to {
  opacity: 0;
  transform: translateX(-4px);
}
</style>
