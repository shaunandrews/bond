<script setup lang="ts">
defineProps<{
  modelValue?: string
  placeholder?: string
  disabled?: boolean
  type?: string
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <input
    :type="type ?? 'text'"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    class="bond-input"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.bond-input {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  padding: 0.45rem 0.65rem;
  font-family: inherit;
  font-size: 0.875rem;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color var(--transition-base), box-shadow var(--transition-base);
}

.bond-input::placeholder {
  color: var(--color-muted);
  opacity: 0.7;
}

.bond-input:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}

.bond-input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
