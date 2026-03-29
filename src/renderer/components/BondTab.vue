<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  tabs: { id: string; label: string }[]
  modelValue?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const active = ref(props.modelValue ?? props.tabs[0]?.id)

function select(id: string) {
  active.value = id
  emit('update:modelValue', id)
}
</script>

<template>
  <div class="bond-tabs">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
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
  gap: 0.125rem;
  padding: 0.1875rem;
  background: color-mix(in srgb, var(--color-border) 40%, transparent);
  border-radius: var(--radius-lg);
}

.bond-tab {
  all: unset;
  cursor: pointer;
  padding: 0.3rem 0.75rem;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-muted);
  border-radius: var(--radius-md);
  transition: background var(--transition-base), color var(--transition-base);
}

.bond-tab:hover:not(.active) {
  color: var(--color-text-primary);
}

.bond-tab.active {
  background: var(--color-surface);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-sm);
}
</style>
