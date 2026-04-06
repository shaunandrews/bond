<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SenseCapture } from '../../shared/sense'
import { PhGhost, PhCaretDown, PhCaretRight, PhAppWindow, PhClipboardText, PhTimer, PhWarning } from '@phosphor-icons/vue'
import BondText from './BondText.vue'

const props = defineProps<{
  capture: SenseCapture | null
  image: string | null
  loadingImage: boolean
}>()

const textExpanded = ref(false)

const formattedTime = computed(() => {
  if (!props.capture) return ''
  const d = new Date(props.capture.capturedAt)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
})

const triggerLabel = computed(() => {
  switch (props.capture?.captureTrigger) {
    case 'app_switch': return 'App switch'
    case 'interval': return 'Interval'
    case 'clipboard': return 'Clipboard'
    default: return null
  }
})

const imagePurged = computed(() => {
  return props.capture && !props.capture.imagePath && !props.image
})

const hasText = computed(() => {
  return props.capture?.textContent && props.capture.textContent.trim().length > 0
})

function openInPreview() {
  if (props.capture?.imagePath) {
    window.bond.openPath(props.capture.imagePath)
  }
}
</script>

<template>
  <div class="sense-detail">
    <!-- No selection -->
    <div v-if="!capture" class="empty-state">
      <PhAppWindow :size="32" weight="light" />
      <BondText color="muted">Select a point on the timeline</BondText>
    </div>

    <!-- With capture -->
    <template v-else>
      <!-- Screenshot area -->
      <div class="screenshot-area">
        <!-- Loading -->
        <div v-if="loadingImage" class="screenshot-placeholder">
          <div class="loading-pulse" />
        </div>
        <!-- Purged -->
        <div v-else-if="imagePurged" class="screenshot-placeholder purged">
          <PhGhost :size="32" weight="light" />
          <BondText size="sm" color="muted">Screenshot purged</BondText>
          <BondText size="xs" color="muted">Text content preserved below</BondText>
        </div>
        <!-- Image -->
        <img
          v-else-if="image"
          :src="'data:image/jpeg;base64,' + image"
          class="screenshot-img"
          :class="{ 'clickable': capture?.imagePath }"
          alt="Screen capture"
          :title="capture?.imagePath ? 'Click to open in Preview' : undefined"
          @click="openInPreview"
        />
        <!-- No image yet -->
        <div v-else class="screenshot-placeholder">
          <BondText size="sm" color="muted">No screenshot available</BondText>
        </div>
      </div>

      <!-- Metadata bar -->
      <div class="meta-bar">
        <div class="meta-left">
          <BondText size="sm" weight="medium">{{ capture.appName || 'Unknown App' }}</BondText>
          <BondText v-if="capture.windowTitle" size="xs" color="muted" truncate class="max-w-[300px]">{{ capture.windowTitle }}</BondText>
        </div>
        <div class="meta-right">
          <BondText size="xs" color="muted">{{ formattedTime }}</BondText>
          <span v-if="triggerLabel" class="trigger-badge">
            <PhTimer v-if="capture.captureTrigger === 'interval'" :size="12" />
            <PhAppWindow v-else-if="capture.captureTrigger === 'app_switch'" :size="12" />
            <PhClipboardText v-else-if="capture.captureTrigger === 'clipboard'" :size="12" />
            <BondText size="xs" color="muted">{{ triggerLabel }}</BondText>
          </span>
          <span v-if="capture.ambiguous" class="ambiguous-badge" v-tooltip="'Active window changed during capture'">
            <PhWarning :size="12" />
          </span>
        </div>
      </div>

      <!-- Extracted text (collapsible) -->
      <div v-if="hasText" class="text-section">
        <button class="text-toggle" @click="textExpanded = !textExpanded">
          <component :is="textExpanded ? PhCaretDown : PhCaretRight" :size="12" weight="bold" />
          <BondText size="xs" weight="medium" color="muted">Extracted text</BondText>
        </button>
        <div v-if="textExpanded" class="text-content">
          <pre class="text-pre">{{ capture.textContent }}</pre>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sense-detail {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: var(--color-muted);
  opacity: 0.6;
}

.screenshot-area {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-surface);
  overflow: hidden;
  position: relative;
}

.screenshot-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.screenshot-img.clickable {
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.screenshot-img.clickable:hover {
  opacity: 0.85;
}

.screenshot-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: var(--color-muted);
  width: 100%;
  height: 100%;
}

.screenshot-placeholder.purged {
  opacity: 0.6;
}

.loading-pulse {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--color-border);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.95); }
  50% { opacity: 0.6; transform: scale(1); }
}

.meta-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.5rem 1rem;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.meta-left {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}

.meta-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.trigger-badge {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--color-muted);
}

.ambiguous-badge {
  color: var(--color-err);
  display: flex;
  align-items: center;
}

.text-section {
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
  max-height: 200px;
  overflow-y: auto;
}

.text-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 1rem;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-muted);
  transition: background var(--transition-fast);
}

.text-toggle:hover {
  background: var(--color-tint);
}

.text-content {
  padding: 0 1rem 0.5rem;
}

.text-pre {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
</style>
