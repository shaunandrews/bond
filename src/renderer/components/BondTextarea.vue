<script setup lang="ts">
defineProps<{
  modelValue?: string
  placeholder?: string
  disabled?: boolean
  rows?: number
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <textarea
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :rows="rows ?? 3"
    class="bond-textarea"
    @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>

<style scoped>
.bond-textarea {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  padding: 0.5rem 0.65rem;
  font-family: inherit;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  resize: vertical;
  transition: border-color var(--transition-base), box-shadow var(--transition-base);
}

.bond-textarea::placeholder {
  color: var(--color-muted);
  opacity: 0.7;
}

.bond-textarea:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}

.bond-textarea:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
