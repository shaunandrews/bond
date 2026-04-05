<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { Operative, OperativeEvent } from '../../shared/operative'
import { PhArrowLeft, PhPlay, PhCheck, PhX, PhCircle, PhMinus, PhStop, PhTrash, PhCopy, PhTerminal, PhFile, PhMagnifyingGlass } from '@phosphor-icons/vue'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import ViewShell from './ViewShell.vue'

const props = defineProps<{
  operative: Operative
  events: OperativeEvent[]
}>()

const emit = defineEmits<{
  cancel: [id: string]
  remove: [id: string]
  back: []
}>()

const shellRef = ref<InstanceType<typeof ViewShell> | null>(null)

// Accumulate text events into blocks for display
interface DisplayBlock {
  id: string
  type: 'text' | 'tool' | 'thinking' | 'error' | 'result'
  text?: string
  name?: string
  summary?: string
}

const displayBlocks = computed<DisplayBlock[]>(() => {
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
      } else if (evt.kind === 'thinking_text') {
        // Skip thinking in the detail view — too verbose
      } else if (evt.kind === 'raw_error') {
        blocks.push({
          id: `err-${evt.id}`,
          type: 'error',
          text: (evt.data as any).message
        })
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

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--color-accent)'
    case 'completed': return 'var(--color-ok)'
    case 'failed': return 'var(--color-err)'
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
  if (path.includes('/Users/')) {
    const parts = path.split('/Users/')
    if (parts[1]) {
      const rest = parts[1].split('/')
      return '~/' + rest.slice(1).join('/')
    }
  }
  return path
}

function toolIcon(name: string) {
  if (name === 'Bash') return PhTerminal
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'Glob') return PhFile
  if (name === 'Grep') return PhMagnifyingGlass
  return PhTerminal
}

// Auto-scroll to bottom when new events arrive
watch(() => props.events.length, () => {
  if (props.operative.status === 'running') {
    nextTick(() => {
      const el = shellRef.value?.scrollAreaEl
      if (el) el.scrollTop = el.scrollHeight
    })
  }
})
</script>

<template>
  <ViewShell ref="shellRef" :title="operative.name">
    <template #header-start>
      <BondButton variant="ghost" size="sm" icon @click="emit('back')" v-tooltip="'Back to list'">
        <PhArrowLeft :size="16" weight="bold" />
      </BondButton>
    </template>
    <template #header-end>
      <BondButton v-if="operative.status === 'running' || operative.status === 'queued'" variant="ghost" size="sm" icon @click="emit('cancel', operative.id)" v-tooltip="'Cancel'">
        <PhStop :size="16" />
      </BondButton>
      <BondButton v-if="operative.status !== 'running' && operative.status !== 'queued'" variant="ghost" size="sm" icon @click="emit('remove', operative.id)" v-tooltip="'Remove'">
        <PhTrash :size="16" />
      </BondButton>
    </template>

    <div class="operative-detail">
      <!-- Header info -->
      <div class="detail-header">
        <div class="detail-status-row">
          <span class="detail-status-badge" :style="{ color: statusColor(operative.status) }">
            {{ statusLabel(operative.status) }}
          </span>
          <BondText size="xs" color="muted">{{ formatDuration(operative) }}</BondText>
          <BondText v-if="operative.costUsd > 0.01" size="xs" color="muted">${{ operative.costUsd.toFixed(2) }}</BondText>
        </div>
        <BondText size="xs" color="muted" class="detail-path">{{ abbreviatePath(operative.workingDir) }}</BondText>
        <BondText v-if="operative.branch" size="xs" color="muted">Branch: {{ operative.branch }}</BondText>
        <BondText v-if="operative.errorMessage" size="xs" color="err">{{ operative.errorMessage }}</BondText>
      </div>

      <!-- Prompt -->
      <div class="detail-section">
        <BondText size="xs" color="muted" weight="medium" class="detail-label">Prompt</BondText>
        <BondText size="sm" class="detail-prompt">{{ operative.prompt }}</BondText>
      </div>

      <!-- Activity feed -->
      <div class="detail-section">
        <BondText size="xs" color="muted" weight="medium" class="detail-label">Activity</BondText>
        <div class="activity-feed">
          <template v-for="block in displayBlocks" :key="block.id">
            <div v-if="block.type === 'tool'" class="feed-tool">
              <component :is="toolIcon(block.name!)" :size="12" color="var(--color-muted)" />
              <BondText size="xs" color="muted">{{ block.name }}</BondText>
              <BondText v-if="block.summary" size="xs" color="muted" truncate class="feed-tool-path">{{ block.summary }}</BondText>
            </div>
            <div v-else-if="block.type === 'text'" class="feed-text">
              <MarkdownMessage :text="block.text!" :streaming="operative.status === 'running'" />
            </div>
            <div v-else-if="block.type === 'error'" class="feed-error">
              <BondText size="sm" color="err">{{ block.text }}</BondText>
            </div>
            <div v-else-if="block.type === 'result'" class="feed-result">
              <MarkdownMessage :text="block.text!" :streaming="false" />
            </div>
          </template>
          <div v-if="operative.status === 'running' && displayBlocks.length === 0" class="feed-working">
            <BondText size="sm" color="muted">Working...</BondText>
          </div>
        </div>
      </div>
    </div>
  </ViewShell>
</template>

<style scoped>
.operative-detail {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-status-badge {
  font-size: 12px;
  font-weight: 600;
}

.detail-path {
  font-family: var(--font-mono);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-label {
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.detail-prompt {
  white-space: pre-wrap;
  padding: 8px 10px;
  background: var(--color-tint);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
}

.activity-feed {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.feed-tool {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}

.feed-tool-path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
}

.feed-text {
  padding: 4px 0;
}

.feed-error {
  padding: 6px 10px;
  background: color-mix(in srgb, var(--color-err) 10%, transparent);
  border-radius: var(--radius-md);
}

.feed-result {
  padding: 4px 0;
  border-top: 1px solid var(--color-border);
  margin-top: 8px;
  padding-top: 12px;
}

.feed-working {
  text-align: center;
  padding: 20px;
}
</style>
