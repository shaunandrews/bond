<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'

const props = defineProps<{
  tabs: { id: string; label: string }[]
  modelValue?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const active = ref(props.modelValue ?? props.tabs[0]?.id)
const containerRef = ref<HTMLElement | null>(null)
const indicatorStyle = ref<Record<string, string>>({})

function updateIndicator() {
  if (!containerRef.value) return
  const activeId = props.modelValue ?? active.value
  const btn = containerRef.value.querySelector(`[data-tab-id="${activeId}"]`) as HTMLElement | null
  if (!btn) return
  const containerRect = containerRef.value.getBoundingClientRect()
  const btnRect = btn.getBoundingClientRect()
  indicatorStyle.value = {
    width: `${btnRect.width}px`,
    transform: `translateX(${btnRect.left - containerRect.left}px)`,
  }
}

function select(id: string) {
  active.value = id
  emit('update:modelValue', id)
  nextTick(updateIndicator)
}

watch(() => props.modelValue, () => {
  nextTick(updateIndicator)
})

onMounted(updateIndicator)
</script>

<template>
  <div ref="containerRef" class="bond-tabs">
    <div class="bond-tab-indicator" :style="indicatorStyle" />
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      :data-tab-id="tab.id"
      :class="['bond-tab', { active: (modelValue ?? active) === tab.id }]"
      @click="select(tab.id)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
.bond-tabs {
  display: inline-flex;
  position: relative;
  gap: 0.125rem;
  padding: 0.1875rem;
  background: color-mix(in srgb, var(--color-border) 40%, transparent);
  border-radius: var(--radius-lg);
}

.bond-tab-indicator {
  position: absolute;
  top: 0.1875rem;
  left: 0;
  height: calc(100% - 0.375rem);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.1, 1),
              width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}

.bond-tab {
  all: unset;
  cursor: pointer;
  position: relative;
  z-index: 1;
  padding: 0.3rem 0.75rem;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-muted);
  border-radius: var(--radius-md);
  transition: color 0.2s ease;
}

.bond-tab:hover:not(.active) {
  color: var(--color-text-primary);
}

.bond-tab.active {
  color: var(--color-text-primary);
}
</style>
