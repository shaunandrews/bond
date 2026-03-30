<script setup lang="ts">
import { PhCaretDown } from '@phosphor-icons/vue'

defineProps<{
  modelValue?: string
  disabled?: boolean
  options: { value: string; label: string }[]
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div class="bond-select-wrap">
    <select
      :value="modelValue"
      :disabled="disabled"
      class="bond-select"
      @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
    </select>
    <PhCaretDown class="bond-select-icon" :size="12" weight="bold" />
  </div>
</template>

<style scoped>
.bond-select-wrap {
  position: relative;
  display: inline-block;
}

.bond-select {
  appearance: none;
  box-sizing: border-box;
  padding: 0.375rem 2rem 0.375rem 0.65rem;
  font-family: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color var(--transition-base);
}

.bond-select:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}

.bond-select:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.bond-select-icon {
  position: absolute;
  right: 0.5em;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-muted);
  pointer-events: none;
}
</style>
