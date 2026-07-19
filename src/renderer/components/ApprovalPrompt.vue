<script setup lang="ts">
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'
import { formatApprovalInput } from '../lib/format'

const props = defineProps<{
  requestId: string
  toolName: string
  input: Record<string, unknown>
  description?: string
  context?: string
}>()

defineEmits<{
  respond: [requestId: string, approved: boolean]
}>()

function formatInput(): string {
  return formatApprovalInput(props.input)
}
</script>

<template>
  <div class="approval-prompt" role="alert">
    <div class="approval-copy">
      <BondText size="xs" weight="semibold" color="accent">{{ toolName }} needs approval<span v-if="context"> · {{ context }}</span></BondText>
      <BondText v-if="description" size="xs" color="muted">{{ description }}</BondText>
      <pre v-if="formatInput()" class="approval-input">{{ formatInput() }}</pre>
    </div>
    <div class="approval-actions">
      <BondButton size="sm" @click="$emit('respond', requestId, true)">Allow</BondButton>
      <BondButton variant="secondary" size="sm" @click="$emit('respond', requestId, false)">Deny</BondButton>
    </div>
  </div>
</template>

<style scoped>
.approval-prompt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
  box-shadow: var(--shadow-sm);
}
.approval-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.approval-input {
  max-height: 72px;
  margin: 3px 0 0;
  overflow: auto;
  color: var(--color-muted);
  font: 10px/1.4 var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.approval-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
