<script setup lang="ts">
import { PhCopy, PhCheck } from '@phosphor-icons/vue'
import { ref } from 'vue'

const props = defineProps<{
  value: string
}>()

const copied = ref(false)
let timeout: ReturnType<typeof setTimeout> | null = null

function copy() {
  navigator.clipboard.writeText(props.value)
  copied.value = true
  if (timeout) clearTimeout(timeout)
  timeout = setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <button class="copy-btn" :class="{ copied }" @click="copy" v-tooltip="copied ? 'Copied!' : 'Copy to clipboard'">
    <PhCheck v-if="copied" :size="14" weight="bold" />
    <PhCopy v-else :size="14" />
  </button>
</template>

<style scoped>
.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.copy-btn:hover {
  color: var(--color-text-primary);
  background: var(--color-border);
}
.copy-btn.copied {
  color: var(--color-ok);
}
</style>
