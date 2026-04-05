<script setup lang="ts">
import { appColor } from '../composables/useSense'
import type { AppSummary } from '../composables/useSense'
import BondText from './BondText.vue'

defineProps<{
  apps: AppSummary[]
  activeFilter: string | null
}>()

const emit = defineEmits<{
  filter: [bundleId: string]
}>()

function isDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
</script>

<template>
  <div class="sense-app-legend">
    <button
      v-for="app in apps.slice(0, 8)"
      :key="app.bundleId"
      :class="['legend-chip', { active: activeFilter === app.bundleId, dimmed: activeFilter && activeFilter !== app.bundleId }]"
      @click="emit('filter', app.bundleId)"
      v-tooltip="app.appName + ' (' + app.captureCount + ')'"
    >
      <span class="legend-dot" :style="{ background: appColor(app.bundleId, isDark()) }" />
      <BondText size="xs" :color="activeFilter === app.bundleId ? 'primary' : 'muted'" truncate>{{ app.appName }}</BondText>
    </button>
  </div>
</template>

<style scoped>
.sense-app-legend {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
  padding: 0.25rem 0;
}

.legend-chip {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem 0.125rem 0.375rem;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background: none;
  cursor: pointer;
  max-width: 120px;
  transition: opacity var(--transition-fast), border-color var(--transition-fast);
}

.legend-chip:hover {
  border-color: var(--color-muted);
}

.legend-chip.active {
  border-color: var(--color-accent, var(--color-text-primary));
  background: var(--color-tint);
}

.legend-chip.dimmed {
  opacity: 0.4;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
