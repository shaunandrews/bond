<script setup lang="ts">
import { ref, onMounted } from 'vue'
import BondText from '../BondText.vue'
import MarkdownMessage from '../MarkdownMessage.vue'
import { PhGhost } from '@phosphor-icons/vue'

const soul = ref('')
const loading = ref(true)

onMounted(async () => {
  try {
    soul.value = await window.bond.getSoul()
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="soul-embed">
    <div v-if="loading" class="soul-embed-empty">
      <BondText size="xs" color="muted">Loading soul...</BondText>
    </div>
    <div v-else-if="!soul" class="soul-embed-card soul-embed-card--empty">
      <div class="soul-embed-header">
        <PhGhost :size="16" weight="duotone" class="soul-icon" />
        <BondText size="sm" weight="medium">Soul</BondText>
      </div>
      <BondText size="xs" color="muted" class="soul-empty-hint">
        No personality set. Use the settings panel or <code>bond soul set "..."</code> to define one.
      </BondText>
    </div>
    <div v-else class="soul-embed-card">
      <div class="soul-embed-header">
        <PhGhost :size="16" weight="duotone" class="soul-icon" />
        <BondText size="sm" weight="medium">Soul</BondText>
      </div>
      <div class="soul-embed-body">
        <MarkdownMessage :text="soul" :streaming="false" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.soul-embed {
  margin: 0.5em 0;
}

.soul-embed-empty {
  padding: 0.75rem;
  text-align: center;
}

.soul-embed-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.soul-embed-card--empty {
  border-style: dashed;
}

.soul-embed-header {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.soul-icon {
  color: var(--color-accent);
  flex-shrink: 0;
}

.soul-embed-body {
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--color-text-primary);
}

.soul-embed-body :deep(p:last-child) {
  margin-bottom: 0;
}

.soul-empty-hint code {
  font-size: 0.75rem;
  background: var(--color-tint);
  padding: 0.0625rem 0.25rem;
  border-radius: var(--radius-sm);
}
</style>
