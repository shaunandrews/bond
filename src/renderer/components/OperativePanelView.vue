<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { PhArrowLeft, PhPlay, PhCheck, PhX, PhCircle, PhMinus, PhStop, PhTrash, PhTerminal, PhFile, PhMagnifyingGlass } from '@phosphor-icons/vue'
import type { Operative, OperativeEvent } from '../../shared/operative'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondToolbar from './BondToolbar.vue'
import BondTab from './BondTab.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import ContextGauge from './ContextGauge.vue'

const props = defineProps<{
  operatives: Operative[]
  activeOperativeId: string | null
  events: OperativeEvent[]
}>()

const emit = defineEmits<{
  select: [id: string | null]
  cancel: [id: string]
  remove: [id: string]
  clear: []
}>()

const activeOperative = computed(() =>
  props.operatives.find(o => o.id === props.activeOperativeId) ?? null
)

// --- List filter ---

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

const hasFinished = computed(() =>
  props.operatives.some(o => o.status === 'completed' || o.status === 'failed' || o.status === 'cancelled')
)

// --- List helpers ---

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
  if (min < 60) return `${min}m ${sec % 60}s`
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

function abbreviatePath(path: string): string {
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

// --- Detail helpers ---

interface DisplayBlock {
  id: string
  type: 'text' | 'tool' | 'error' | 'result'
  text?: string
  name?: string
  summary?: string
}

const displayBlocks = computed<DisplayBlock[]>(() => {
  if (!activeOperative.value) return []
  const blocks: DisplayBlock[] = []
  let currentText = ''
  let currentTextId = ''

  for (const evt of props.events) {
    if (evt.kind === 'assistant_text') {
      if (!currentText) currentTextId = `text-${evt.id}`
      currentText += (evt.data as any).text ?? ''
    } else {
      if (currentText) {
        blocks.push({ id: currentTextId, type: 'text', text: currentText })
        currentText = ''
      }
      if (evt.kind === 'assistant_tool') {
        blocks.push({
          id: `tool-${evt.id}`,
          type: 'tool',
          name: (evt.data as any).name,
          summary: (evt.data as any).summary
        })
      } else if (evt.kind === 'raw_error') {
        blocks.push({ id: `err-${evt.id}`, type: 'error', text: (evt.data as any).message })
      } else if (evt.kind === 'result') {
        blocks.push({
          id: `result-${evt.id}`,
          type: 'result',
          text: (evt.data as any).subtype === 'success'
            ? (evt.data as any).result ?? 'Completed successfully'
            : ((evt.data as any).errors ?? []).join('\n') || 'Failed'
        })
      }
    }
  }
  if (currentText) {
    blocks.push({ id: currentTextId, type: 'text', text: currentText })
  }
  return blocks
})

function toolIcon(name: string) {
  if (name === 'Bash') return PhTerminal
  if (['Read', 'Edit', 'Write', 'Glob'].includes(name)) return PhFile
  if (name === 'Grep') return PhMagnifyingGlass
  return PhTerminal
}

// Context usage from live events or stored operative record
const operativeContextUsage = computed(() => {
  if (!activeOperative.value) return { inputTokens: 0, contextWindow: 0, costUsd: 0 }
  for (let i = props.events.length - 1; i >= 0; i--) {
    const evt = props.events[i]
    if (evt.kind === 'usage_update') {
      return {
        inputTokens: (evt.data as any).inputTokens ?? 0,
        contextWindow: (evt.data as any).contextWindow ?? 0,
        costUsd: (evt.data as any).costUsd ?? 0
      }
    }
  }
  if (activeOperative.value.contextWindow) {
    return {
      inputTokens: activeOperative.value.inputTokens,
      contextWindow: activeOperative.value.contextWindow,
      costUsd: activeOperative.value.costUsd
    }
  }
  return { inputTokens: 0, contextWindow: 0, costUsd: 0 }
})

const scrollRef = ref<HTMLElement | null>(null)

watch(() => props.events.length, () => {
  if (activeOperative.value?.status === 'running') {
    nextTick(() => {
      if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight
    })
  }
})
</script>

<template>
  <div class="op-panel">
    <!-- Detail view -->
    <template v-if="activeOperative">
      <BondToolbar label="Operative detail" drag blur class="op-panel-toolbar">
        <template #start>
          <BondButton variant="ghost" size="sm" icon @click="emit('select', null)" v-tooltip="'Back to list'">
            <PhArrowLeft :size="14" weight="bold" />
          </BondButton>
          <BondText size="sm" weight="medium" truncate>{{ activeOperative.name }}</BondText>
        </template>
        <template #end>
          <BondButton v-if="activeOperative.status === 'running' || activeOperative.status === 'queued'" variant="ghost" size="sm" icon @click="emit('cancel', activeOperative.id)" v-tooltip="'Cancel'">
            <PhStop :size="14" />
          </BondButton>
          <BondButton v-else variant="ghost" size="sm" icon @click="emit('remove', activeOperative.id)" v-tooltip="'Remove'">
            <PhTrash :size="14" />
          </BondButton>
        </template>
      </BondToolbar>
      <div ref="scrollRef" class="op-panel-scroll">
        <!-- Status bar -->
        <div class="op-detail-status">
          <span :style="{ color: statusColor(activeOperative.status) }" class="op-detail-status-label">
            {{ activeOperative.status.charAt(0).toUpperCase() + activeOperative.status.slice(1) }}
          </span>
          <BondText size="xs" color="muted">{{ formatDuration(activeOperative) }}</BondText>
          <BondText v-if="activeOperative.costUsd > 0.01" size="xs" color="muted">${{ activeOperative.costUsd.toFixed(2) }}</BondText>
          <ContextGauge
            :used="operativeContextUsage.inputTokens"
            :limit="operativeContextUsage.contextWindow"
            :cost="operativeContextUsage.costUsd"
          />
        </div>
        <BondText size="xs" color="muted" class="op-detail-path">{{ abbreviatePath(activeOperative.workingDir) }}</BondText>
        <BondText v-if="activeOperative.branch" size="xs" color="muted" class="op-detail-branch">Branch: {{ activeOperative.branch }}</BondText>
        <BondText v-if="activeOperative.errorMessage" size="xs" color="err" class="op-detail-error">{{ activeOperative.errorMessage }}</BondText>

        <!-- Prompt -->
        <div v-if="activeOperative.prompt" class="op-detail-prompt">
          <MarkdownMessage :text="activeOperative.prompt" :streaming="false" />
        </div>

        <!-- Activity feed -->
        <div class="op-feed">
          <template v-for="block in displayBlocks" :key="block.id">
            <div v-if="block.type === 'tool'" class="op-feed-tool">
              <component :is="toolIcon(block.name!)" :size="12" color="var(--color-muted)" />
              <BondText size="xs" color="muted">{{ block.name }}</BondText>
              <BondText v-if="block.summary" size="xs" color="muted" truncate class="op-feed-tool-path">{{ block.summary }}</BondText>
            </div>
            <div v-else-if="block.type === 'text'" class="op-feed-text">
              <MarkdownMessage :text="block.text!" :streaming="activeOperative.status === 'running'" />
            </div>
            <div v-else-if="block.type === 'error'" class="op-feed-error">
              <BondText size="sm" color="err">{{ block.text }}</BondText>
            </div>
            <div v-else-if="block.type === 'result'" class="op-feed-result">
              <MarkdownMessage :text="block.text!" :streaming="false" />
            </div>
          </template>
          <div v-if="activeOperative.status === 'running' && displayBlocks.length === 0" class="op-feed-working">
            <BondText size="sm" color="muted">Working...</BondText>
          </div>
        </div>
      </div>
    </template>

    <!-- List view -->
    <template v-else>
      <BondToolbar label="Operatives" drag blur class="op-panel-toolbar">
        <template #middle>
          <BondText size="sm" weight="medium">Operatives</BondText>
        </template>
        <template #end>
          <BondButton v-if="hasFinished" variant="ghost" size="sm" icon @click="emit('clear')" v-tooltip="'Clear finished'">
            <PhTrash :size="14" />
          </BondButton>
        </template>
      </BondToolbar>

      <div class="op-panel-scroll">
        <div class="op-filter">
          <BondTab :tabs="filterTabs" v-model="activeFilter" />
        </div>

        <div v-if="filteredOperatives.length === 0" class="op-empty">
          <BondText color="muted" size="sm">No operatives{{ activeFilter !== 'all' ? ' matching filter' : '' }}</BondText>
        </div>
        <div v-else class="op-list">
          <button
            v-for="op in filteredOperatives"
            :key="op.id"
            :class="['op-item', { active: op.id === activeOperativeId }]"
            @click="emit('select', op.id)"
          >
            <div class="op-item-status">
              <component :is="statusIcon(op.status)" :size="14" :color="statusColor(op.status)" :weight="op.status === 'running' ? 'fill' : 'bold'" />
            </div>
            <div class="op-item-info">
              <BondText size="sm" weight="medium" truncate>{{ op.name }}</BondText>
              <BondText v-if="op.prompt" size="xs" color="muted" class="op-item-prompt">{{ op.prompt }}</BondText>
              <div class="op-item-meta">
                <BondText size="xs" color="muted">{{ abbreviatePath(op.workingDir) }}</BondText>
                <BondText size="xs" color="muted">{{ formatDuration(op) }}</BondText>
                <BondText v-if="formatCost(op.costUsd)" size="xs" color="muted">{{ formatCost(op.costUsd) }}</BondText>
              </div>
            </div>
            <div class="op-item-actions" @click.stop>
              <BondButton v-if="op.status === 'running' || op.status === 'queued'" variant="ghost" size="sm" icon @click="emit('cancel', op.id)" v-tooltip="'Cancel'">
                <PhStop :size="12" />
              </BondButton>
              <BondButton v-else variant="ghost" size="sm" icon @click="emit('remove', op.id)" v-tooltip="'Remove'">
                <PhTrash :size="12" />
              </BondButton>
            </div>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.op-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.op-panel-toolbar {
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 2;
}

.op-panel-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}

.op-filter {
  margin-bottom: 8px;
}

.op-empty {
  text-align: center;
  padding: 40px 16px;
}

.op-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.op-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  width: 100%;
  transition: background var(--transition-fast);
}
.op-item:hover { background: var(--color-tint); }
.op-item.active { background: var(--color-tint); }

.op-item-status { flex-shrink: 0; display: flex; align-items: center; }
.op-item-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.op-item-prompt {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.4;
}
.op-item-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.op-item-actions { flex-shrink: 0; opacity: 0; transition: opacity var(--transition-fast); }
.op-item:hover .op-item-actions { opacity: 1; }

/* Detail */
.op-detail-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.op-detail-status-label {
  font-size: 12px;
  font-weight: 600;
}
.op-detail-path, .op-detail-branch {
  font-family: var(--font-mono);
  margin-bottom: 4px;
  display: block;
}
.op-detail-error {
  display: block;
  margin-bottom: 8px;
}

.op-detail-prompt {
  margin-top: 8px;
  padding: 10px;
  background: var(--color-tint);
  border-radius: var(--radius-md);
  font-size: 13px;
  line-height: 1.5;
}

.op-feed {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
  border-top: 1px solid var(--color-border);
  padding-top: 10px;
}

.op-feed-tool {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 0;
}
.op-feed-tool-path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
}
.op-feed-text { padding: 2px 0; }
.op-feed-error {
  padding: 6px 8px;
  background: color-mix(in srgb, var(--color-err) 10%, transparent);
  border-radius: var(--radius-md);
}
.op-feed-result {
  padding: 4px 0;
  border-top: 1px solid var(--color-border);
  margin-top: 6px;
  padding-top: 8px;
}
.op-feed-working {
  text-align: center;
  padding: 16px;
}
</style>
