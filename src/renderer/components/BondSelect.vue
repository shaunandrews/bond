<script setup lang="ts">
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
  <select
    :value="modelValue"
    :disabled="disabled"
    class="bond-select"
    @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
  </select>
</template>

<style scoped>
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
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%235c6570' d='M3 4.5l3 3 3-3'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.5em center;
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
</style>
