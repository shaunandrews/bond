<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Operative } from '../../shared/operative'
import { PhRobot, PhPlay, PhCheck, PhX, PhCircle, PhMinus, PhTrash, PhStop, PhArrowLeft } from '@phosphor-icons/vue'
import ViewShell from './ViewShell.vue'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondTab from './BondTab.vue'

const props = defineProps<{
  operatives: Operative[]
  activeOperativeId: string | null
  insetStart?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  cancel: [id: string]
  remove: [id: string]
  clear: []
  back: []
}>()

const filterTabs = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Active' },
  { id: 'completed', label: 'Done' },
]

const activeFilter = ref('all')

const filteredOperatives = computed(() => {
  if (activeFilter.value === 'running') {
    return props.operatives.filter(o => o.status === 'running' || o.status === 'queued')
  }
  if (activeFilter.value === 'completed') {
    return props.operatives.filter(o => o.status === 'completed' || o.status === 'failed' || o.status === 'cancelled')
  }
  return props.operatives
})

function statusIcon(status: string) {
  switch (status) {
    case 'running': return PhPlay
    case 'queued': return PhCircle
    case 'completed': return PhCheck
    case 'failed': return PhX
    case 'cancelled': return PhMinus
    default: return PhCircle
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--color-accent)'
    case 'queued': return 'var(--color-muted)'
    case 'completed': return 'var(--color-ok)'
    case 'failed': return 'var(--color-err)'
    case 'cancelled': return 'var(--color-muted)'
    default: return 'var(--color-muted)'
  }
}

function formatDuration(op: Operative): string {
  const start = op.startedAt ? new Date(op.startedAt).getTime() : new Date(op.createdAt).getTime()
  const end = op.completedAt ? new Date(op.completedAt).getTime() : Date.now()
  const sec = Math.floor((end - start) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return `${min}m ${remSec}s`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

function abbreviatePath(path: string): string {
  const home = '/Users/' // will be shown as ~
  if (path.includes('/Users/')) {
    const parts = path.split('/Users/')
    if (parts[1]) {
      const rest = parts[1].split('/')
      return '~/' + rest.slice(1).join('/')
    }
  }
  return path
}

function formatCost(cost: number): string {
  if (cost < 0.01) return ''
  return `$${cost.toFixed(2)}`
}
</script>

<template>
  <ViewShell title="Operatives" :insetStart="insetStart">
    <template #header-start>
      <slot name="header-start" />
    </template>
    <template #header-end>
      <BondButton v-if="operatives.some(o => o.status === 'completed' || o.status === 'failed' || o.status === 'cancelled')" variant="ghost" size="sm" icon @click="emit('clear')" v-tooltip="'Clear finished'">
        <PhTrash :size="16" />
      </BondButton>
    </template>

    <div class="operatives-view">
      <div class="operatives-filter">
        <BondTab :tabs="filterTabs" v-model="activeFilter" />
      </div>

      <div v-if="filteredOperatives.length === 0" class="operatives-empty">
        <BondText color="muted" size="sm">No operatives{{ activeFilter !== 'all' ? ' matching filter' : '' }}</BondText>
      </div>

      <div v-else class="operatives-list">
        <button
          v-for="op in filteredOperatives"
          :key="op.id"
          :class="['operative-item', { active: op.id === activeOperativeId }]"
          @click="emit('select', op.id)"
        >
          <div class="operative-status">
            <component :is="statusIcon(op.status)" :size="14" :color="statusColor(op.status)" :weight="op.status === 'running' ? 'fill' : 'bold'" />
          </div>
          <div class="operative-info">
            <BondText size="sm" weight="medium" truncate>{{ op.name }}</BondText>
            <div class="operative-meta">
              <BondText size="xs" color="muted">{{ abbreviatePath(op.workingDir) }}</BondText>
              <BondText v-if="op.status === 'running' || op.startedAt" size="xs" color="muted">{{ formatDuration(op) }}</BondText>
              <BondText v-if="formatCost(op.costUsd)" size="xs" color="muted">{{ formatCost(op.costUsd) }}</BondText>
            </div>
          </div>
          <div class="operative-actions" @click.stop>
            <BondButton v-if="op.status === 'running' || op.status === 'queued'" variant="ghost" size="sm" icon @click="emit('cancel', op.id)" v-tooltip="'Cancel'">
              <PhStop :size="14" />
            </BondButton>
            <BondButton v-else variant="ghost" size="sm" icon @click="emit('remove', op.id)" v-tooltip="'Remove'">
              <PhTrash :size="14" />
            </BondButton>
          </div>
        </button>
      </div>
    </div>
  </ViewShell>
</template>

<style scoped>
.operatives-view {
  padding: 12px 16px;
}

.operatives-filter {
  margin-bottom: 12px;
}

.operatives-empty {
  text-align: center;
  padding: 40px 16px;
}

.operatives-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.operative-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  width: 100%;
  transition: background var(--transition-fast);
}
.operative-item:hover {
  background: var(--color-tint);
}
.operative-item.active {
  background: var(--color-tint);
}

.operative-status {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.operative-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.operative-meta {
  display: flex;
  gap: 8px;
  align-items: center;
}

.operative-actions {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.operative-item:hover .operative-actions {
  opacity: 1;
}

/* Pulsing animation for running status */
.operative-item .operative-status :deep(svg) {
  transition: opacity 0.3s;
}
</style>
