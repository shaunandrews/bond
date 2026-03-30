<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  title: string
}>()

const scrollAreaEl = ref<HTMLElement | null>(null)

defineExpose({ scrollAreaEl })
</script>

<template>
  <div class="view-shell">
    <div ref="scrollAreaEl" class="view-scroll-area">
      <header class="view-header drag-region">
        <div v-if="$slots['header-left']" class="view-header-left no-drag">
          <slot name="header-left" />
        </div>
        <h1 class="view-title">{{ title }}</h1>
        <div v-if="$slots['header-right']" class="view-header-right no-drag">
          <slot name="header-right" />
        </div>
      </header>

      <div class="view-content">
        <slot />
      </div>

      <div v-if="$slots.footer" class="view-footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.view-shell {
  position: relative;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

.view-scroll-area {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.view-header {
  position: sticky;
  top: 0;
  z-index: 10;
}

.view-header::before {
  content: '';
  position: absolute;
  top: 0;
  left: 4px;
  right: 0;
  bottom: -24px;
  z-index: -1;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  mask-image: linear-gradient(to bottom, black 40%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, black 40%, transparent);
}

.view-header-left {
  position: absolute;
  left: 0.75rem;
  top: 0.8rem;
  display: flex;
  align-items: center;
  z-index: 1;
}

.view-header-right {
  position: absolute;
  right: 0.75rem;
  top: 0.8rem;
  display: flex;
  align-items: center;
  z-index: 1;
}

.view-title {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-muted);
  margin: 0;
  text-align: center;
  user-select: none;
  padding: 1rem 1.25rem 0.5rem;
}

.view-content {
  flex: 1;
}

.view-footer {
  position: sticky;
  bottom: 0;
  z-index: 10;
  pointer-events: none;
}

.view-footer > :deep(*) {
  pointer-events: auto;
}

.view-footer::before {
  content: '';
  position: absolute;
  top: -12px;
  left: 4px;
  right: 0;
  bottom: 0;
  z-index: -1;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  mask-image: linear-gradient(to bottom, transparent, black 48px);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 48px);
}
</style>
