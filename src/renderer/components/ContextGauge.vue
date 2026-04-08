<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  used: number
  limit: number
  cost?: number
}>()

const hovered = ref(false)
const gaugeEl = ref<HTMLElement | null>(null)

const pct = computed(() => {
  if (!props.limit) return 0
  return Math.min(1, props.used / props.limit)
})

const strokeColor = computed(() => {
  const p = pct.value
  if (p >= 0.8) return 'var(--color-err)'
  if (p >= 0.6) return 'var(--color-accent)'
  return 'var(--color-muted)'
})

const trackColor = 'color-mix(in srgb, var(--color-border) 50%, transparent)'

// SVG arc math — 24px viewBox, 3px stroke, radius = 9
const R = 9
const C = 2 * Math.PI * R
const arcLength = computed(() => C * pct.value)
const gapLength = computed(() => C - arcLength.value)

function fmtTokens(n: number): string {
  return Math.round(n / 1000) + 'k'
}

const tooltipText = computed(() => {
  const pctStr = Math.round(pct.value * 100)
  let text = `${fmtTokens(props.used)} / ${fmtTokens(props.limit)} tokens (${pctStr}%)`
  if (props.cost != null && props.cost > 0) {
    text += ` \u00B7 $${props.cost.toFixed(2)}`
  }
  return text
})
</script>

<template>
  <div
    v-if="limit > 0"
    ref="gaugeEl"
    class="context-gauge"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      class="gauge-svg"
    >
      <!-- Track -->
      <circle
        cx="12"
        cy="12"
        :r="R"
        fill="none"
        :stroke="trackColor"
        stroke-width="3"
      />
      <!-- Fill arc -->
      <circle
        cx="12"
        cy="12"
        :r="R"
        fill="none"
        :stroke="strokeColor"
        stroke-width="3"
        stroke-linecap="round"
        :stroke-dasharray="`${arcLength} ${gapLength}`"
        :stroke-dashoffset="C * 0.25"
        class="gauge-arc"
      />
    </svg>
    <!-- Tooltip above -->
    <div v-if="hovered" class="gauge-tooltip">
      {{ tooltipText }}
    </div>
  </div>
</template>

<style scoped>
.context-gauge {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  cursor: default;
}

.gauge-svg {
  transform: rotate(-90deg);
}

.gauge-arc {
  transition: stroke-dasharray var(--transition-normal), stroke var(--transition-normal);
}

.gauge-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 11px;
  line-height: 1.4;
  padding: 4px 8px;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-lg);
  pointer-events: none;
  z-index: 100;
}
</style>
