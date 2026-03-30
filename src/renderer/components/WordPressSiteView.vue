<script setup lang="ts">
import { PhGlobe, PhFolder, PhPlay, PhStop, PhTrash } from '@phosphor-icons/vue'
import type { WordPressSite } from '../../shared/wordpress'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'

defineProps<{
  site: WordPressSite
  toggling: boolean
}>()

const emit = defineEmits<{
  open: []
  start: []
  stop: []
}>()
</script>

<template>
  <div class="wp-site-view">
    <!-- Site header -->
    <div class="wp-site-header">
      <div class="wp-site-title-row">
        <span :class="['wp-dot', { running: site.running }]" />
        <BondText as="h2" size="xl" weight="semibold">{{ site.name }}</BondText>
      </div>
      <BondText size="sm" color="muted" mono>{{ site.path }}</BondText>
    </div>

    <!-- Quick actions -->
    <div class="wp-site-actions">
      <BondButton variant="primary" size="sm" :disabled="!site.running" @click="emit('open')">
        <PhGlobe :size="16" weight="bold" />
        Open in browser
      </BondButton>
      <BondButton v-if="!site.running" variant="secondary" size="sm" :disabled="toggling" @click="emit('start')">
        <PhPlay :size="14" weight="bold" />
        {{ toggling ? 'Starting...' : 'Start site' }}
      </BondButton>
      <BondButton v-else variant="secondary" size="sm" :disabled="toggling" @click="emit('stop')">
        <PhStop :size="14" weight="bold" />
        {{ toggling ? 'Stopping...' : 'Stop site' }}
      </BondButton>
    </div>

    <!-- Details -->
    <div class="wp-site-details">
      <div class="detail-row">
        <BondText size="sm" color="muted">Status</BondText>
        <BondText v-if="toggling" size="sm" color="accent">{{ site.running ? 'Stopping...' : 'Starting...' }}</BondText>
        <BondText v-else size="sm" :color="site.running ? 'ok' : 'muted'">{{ site.running ? 'Running' : 'Stopped' }}</BondText>
      </div>
      <div class="detail-row">
        <BondText size="sm" color="muted">URL</BondText>
        <BondText size="sm" mono>{{ site.url }}</BondText>
      </div>
      <div class="detail-row">
        <BondText size="sm" color="muted">Port</BondText>
        <BondText size="sm" mono>{{ site.port }}</BondText>
      </div>
      <div class="detail-row">
        <BondText size="sm" color="muted">Path</BondText>
        <BondText size="sm" mono>{{ site.path }}</BondText>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wp-site-view {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 600px;
}

.wp-site-header {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.wp-site-title-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.wp-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-muted);
}
.wp-dot.running {
  background: var(--color-ok);
}

.wp-site-actions {
  display: flex;
  gap: 0.5rem;
}

.wp-site-details {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--color-border);
}
.detail-row:last-child {
  border-bottom: none;
}
</style>
