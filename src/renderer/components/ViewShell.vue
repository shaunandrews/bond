<script setup lang="ts">
import { ref } from 'vue'
import BondToolbar from './BondToolbar.vue'

defineProps<{
  title: string
  insetStart?: boolean
}>()

const scrollAreaEl = ref<HTMLElement | null>(null)

defineExpose({ scrollAreaEl })
</script>

<template>
  <div class="view-shell">
    <div ref="scrollAreaEl" class="view-scroll-area">
      <BondToolbar
        label="View navigation"
        drag
        blur
        :insetStart="insetStart"
        class="view-header"
      >
        <template v-if="$slots['header-start']" #start>
          <slot name="header-start" />
          <h1 class="view-title">{{ title }}</h1>
        </template>
        <template #middle>
          <!-- <h1 class="view-title">{{ title }}</h1> -->
        </template>
        <template v-if="$slots['header-end']" #end>
          <slot name="header-end" />
        </template>
      </BondToolbar>

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

.view-title {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-muted);
  margin: 0;
  text-align: center;
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
  backdrop-filter: blur(8px);
  mask-image: linear-gradient(to bottom, transparent, black 100px);
}
</style>
