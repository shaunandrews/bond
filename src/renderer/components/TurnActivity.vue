<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { PhCaretRight, PhWarningCircle } from '@phosphor-icons/vue'
import type { TurnActivityData, TurnActivityEvent } from '../types/activity'

const props = defineProps<{ data: TurnActivityData }>()
defineEmits<{ approve: [requestId: string, approved: boolean] }>()

const expanded = ref(!!props.data.expanded)
const expandedEvents = ref(new Set<string>())
const fullDetails = ref(new Set<string>())
const PREVIEW_LENGTH = 600

watch(() => props.data.expanded, v => { if (v) expanded.value = true })

const nowTick = ref(Date.now())
const active = computed(() => ['working', 'responding', 'awaiting_approval'].includes(props.data.status))
// 500ms tick so the 1s-resolution counter never visibly skips a second. The
// interval exists only while the row is live — a loaded transcript page holds
// dozens of completed rows and must not keep dozens of timers firing forever.
let timer: ReturnType<typeof setInterval> | null = null
watch(active, (isActive) => {
  if (isActive && !timer) {
    nowTick.value = Date.now()
    timer = setInterval(() => { nowTick.value = Date.now() }, 500)
  } else if (!isActive && timer) {
    clearInterval(timer)
    timer = null
  }
}, { immediate: true })
onUnmounted(() => { if (timer) clearInterval(timer) })
const elapsedSec = computed(() => Math.max(0, Math.round(((props.data.endedAt ?? nowTick.value) - props.data.startedAt) / 1000)))
const toolCount = computed(() => props.data.events.filter(e => e.type === 'tool').length)
const approvalPending = computed(() => props.data.events.some(e => e.type === 'approval' && e.status === 'pending'))
const failed = computed(() => props.data.status === 'failed' || props.data.events.some(e => e.type === 'error' || (e.type === 'tool' && e.failed)))
const last = computed(() => props.data.events[props.data.events.length - 1])

function formatDuration(sec: number) {
  if (sec < 1) return 'briefly'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

function statusLabel() {
  if (props.data.status === 'awaiting_approval') return 'Approval needed'
  if (props.data.status === 'failed') return 'Failed'
  if (props.data.status === 'cancelled') return 'Cancelled'
  if (props.data.status === 'done') {
    const bits = [props.data.events.some(e => e.type === 'thinking')
      ? `Thought for ${formatDuration(elapsedSec.value)}`
      : `Worked for ${formatDuration(elapsedSec.value)}`]
    if (toolCount.value) bits.push(`Used ${toolCount.value} ${toolCount.value === 1 ? 'tool' : 'tools'}`)
    return bits.join(' · ')
  }
  if (last.value?.type === 'thinking') return 'Thinking'
  if (last.value?.type === 'tool') return last.value.failed ? `${last.value.label} failed` : last.value.label
  if (last.value?.type === 'responding') return 'Responding'
  return 'Working'
}

function duration(start: number, end?: number) {
  // nowTick (not Date.now()) so live durations are reactive — the interval
  // drives re-renders even when no stream chunks are arriving
  const sec = Math.max(0, Math.round(((end ?? nowTick.value) - start) / 1000))
  return sec < 1 ? '' : formatDuration(sec)
}

function time(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function hasDetail(evt: TurnActivityEvent) {
  return evt.type === 'thinking' || evt.type === 'tool' || evt.type === 'approval' || evt.type === 'error'
}

function eventEnd(evt: TurnActivityEvent): number | undefined {
  return 'endTs' in evt ? evt.endTs : undefined
}

function toggleEvent(id: string) {
  const next = new Set(expandedEvents.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expandedEvents.value = next
}

function detailText(value: unknown) {
  if (value == null) return ''
  try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) } catch { return '' }
}

function displayedDetail(key: string, value: unknown) {
  const text = detailText(value)
  return !fullDetails.value.has(key) && text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text
}

function toggleFull(key: string) {
  const next = new Set(fullDetails.value)
  next.has(key) ? next.delete(key) : next.add(key)
  fullDetails.value = next
}

function eventTone(evt: TurnActivityEvent) {
  if (evt.type === 'error' || (evt.type === 'tool' && evt.failed)) return 'text-err'
  if (evt.type === 'approval' && evt.status === 'pending') return 'text-accent'
  return 'text-muted'
}
</script>

<template>
  <div class="turn-activity" :class="{ active, failed, 'needs-approval': approvalPending }" role="status">
    <button class="activity-compact" @click="expanded = !expanded">
      <span v-if="active" class="activity-dot" />
      <PhWarningCircle v-else-if="failed" :size="13" class="text-err" />
      <span class="activity-label">{{ statusLabel() }}</span>
      <span v-if="active && toolCount" class="activity-tool-count">· {{ toolCount }} {{ toolCount === 1 ? 'tool' : 'tools' }}</span>
      <span v-if="active && duration(props.data.startedAt)" class="activity-duration">{{ duration(props.data.startedAt) }}</span>
      <PhCaretRight :size="11" class="activity-chevron" :class="{ expanded }" />
    </button>

    <div v-if="expanded" class="activity-timeline">
      <div v-for="evt in props.data.events" :key="evt.id" class="activity-event">
        <button class="event-row" :class="eventTone(evt)" @click="hasDetail(evt) && toggleEvent(evt.id)">
          <span class="event-time">{{ time(evt.ts) }}</span>
          <span class="event-title">{{ evt.label }}</span>
          <span v-if="duration(evt.ts, eventEnd(evt))" class="event-duration">{{ duration(evt.ts, eventEnd(evt)) }}</span>
          <PhCaretRight v-if="hasDetail(evt)" :size="9" class="event-chevron" :class="{ expanded: expandedEvents.has(evt.id) }" />
        </button>
        <div v-if="expandedEvents.has(evt.id)" class="event-detail">
          <template v-if="evt.type === 'thinking'">
            <pre>{{ evt.text }}</pre>
          </template>
          <template v-else-if="evt.type === 'tool'">
            <div v-if="evt.input" class="detail-block">
              <span>Input</span><pre>{{ displayedDetail(`${evt.id}:input`, evt.input) }}</pre>
              <button v-if="detailText(evt.input).length > PREVIEW_LENGTH" class="detail-toggle" @click="toggleFull(`${evt.id}:input`)">{{ fullDetails.has(`${evt.id}:input`) ? 'Show less' : 'Show full input' }}</button>
            </div>
            <div v-if="evt.output" class="detail-block">
              <span>Output</span><pre>{{ displayedDetail(`${evt.id}:output`, evt.output) }}</pre>
              <button v-if="detailText(evt.output).length > PREVIEW_LENGTH" class="detail-toggle" @click="toggleFull(`${evt.id}:output`)">{{ fullDetails.has(`${evt.id}:output`) ? 'Show less' : 'Show full output' }}</button>
            </div>
          </template>
          <template v-else-if="evt.type === 'approval'">
            <div v-if="evt.description" class="approval-desc">{{ evt.description }}</div>
            <pre>{{ detailText(evt.input) }}</pre>
            <div v-if="evt.status === 'pending'" class="approval-actions">
              <button @click.stop="$emit('approve', evt.requestId, true)">Allow</button>
              <button @click.stop="$emit('approve', evt.requestId, false)">Deny</button>
            </div>
            <div v-else class="approval-status">{{ evt.status === 'approved' ? 'Allowed' : evt.status === 'denied' ? 'Denied' : 'Cancelled' }}</div>
          </template>
          <template v-else-if="evt.type === 'error'">
            <pre>{{ evt.text }}</pre>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.turn-activity { align-self: center; width: min(92%, 620px); font-size: 11px; color: var(--color-muted); }
.activity-compact { width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid transparent; background: none; color: inherit; border-radius: var(--radius-lg); padding: 3px 8px; cursor: pointer; }
.activity-compact:hover, .turn-activity.needs-approval .activity-compact, .turn-activity.failed .activity-compact { background: var(--color-tint); border-color: var(--color-border); }
.activity-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--color-accent); animation: pulse 1.2s infinite; }
.activity-label { font-weight: 500; color: var(--color-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-compact > :not(.activity-label) { flex-shrink: 0; }
.activity-duration, .activity-tool-count, .event-duration, .event-time { opacity: .72; font-variant-numeric: tabular-nums; }
.activity-chevron, .event-chevron { transition: transform var(--transition-fast); }
.activity-chevron.expanded, .event-chevron.expanded { transform: rotate(90deg); }
.activity-timeline { margin-top: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--color-surface) 76%, transparent); overflow: hidden; }
.event-row { width: 100%; display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px; align-items: center; padding: 6px 8px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.event-row:hover { background: var(--color-tint); }
.event-title { color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-detail { border-top: 1px solid var(--color-border); padding: 8px 10px 10px 72px; background: rgba(0,0,0,.03); }
.detail-block + .detail-block { margin-top: 8px; }
.detail-block span, .approval-desc, .approval-status { display: block; margin-bottom: 4px; color: var(--color-muted); }
.detail-toggle { margin-top: 5px; padding: 0; border: 0; background: none; color: var(--color-accent); font: inherit; cursor: pointer; }
.detail-toggle:hover { text-decoration: underline; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: 11px/1.45 var(--font-mono); color: var(--color-muted); }
.approval-actions { display: flex; gap: 8px; margin-top: 8px; }
.approval-actions button { padding: 3px 9px; border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text-primary); cursor: pointer; }
.approval-actions button:first-child { background: var(--color-accent); color: white; border-color: var(--color-accent); }
@keyframes pulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
</style>
