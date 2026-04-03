<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from 'vue'
import { PhCaretRight } from '@phosphor-icons/vue'
import type { ActivityState } from '../composables/useChat'

const props = defineProps<{ activity: ActivityState; expanded: boolean }>()
const emit = defineEmits<{ 'update:expanded': [value: boolean] }>()

const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

const isActive = computed(() =>
  props.activity.type !== 'idle' && props.activity.type !== 'done'
)

const visible = computed(() => props.activity.type !== 'idle')

watch(() => props.activity, (state) => {
  clearInterval(timer)
  if (state.type === 'idle') { elapsed.value = 0; return }
  const start = state.startedAt
  const end = state.type === 'done' ? state.endedAt : undefined
  elapsed.value = Math.floor(((end ?? Date.now()) - start) / 1000)
  if (!end) {
    timer = setInterval(() => {
      if (props.activity.type !== 'idle' && props.activity.type !== 'done') {
        elapsed.value = Math.floor((Date.now() - props.activity.startedAt) / 1000)
      }
    }, 1000)
  }
}, { immediate: true })

// Collapse when a new query starts
watch(() => props.activity.type, (cur, prev) => {
  if (cur === 'working' && prev === 'done') {
    emit('update:expanded', false)
  }
})

onUnmounted(() => clearInterval(timer))

function toggle() {
  emit('update:expanded', !props.expanded)
}

function formatElapsed(sec: number): string {
  if (sec < 1) return ''
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

const TOOL_VERBS: Record<string, string> = {
  Read: 'Reading',
  Edit: 'Editing',
  Write: 'Writing',
  Bash: 'Running command',
  Glob: 'Searching files',
  Grep: 'Searching code',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching page',
}

function currentLabel(state: ActivityState): string {
  switch (state.type) {
    case 'working': return 'Working'
    case 'thinking': return 'Thinking'
    case 'responding': return 'Responding'
    case 'tool': {
      const verb = TOOL_VERBS[state.name] ?? state.name
      if (state.detail) {
        const filename = state.detail.split('/').pop() || state.detail
        if (!['Bash', 'Glob', 'WebSearch'].includes(state.name)) return `${verb} ${filename}`
      }
      return verb
    }
    case 'done': return 'Recent activity'
    default: return ''
  }
}

const events = computed(() => {
  const a = props.activity
  if (a.type === 'idle') return []
  return a.events
})
</script>

<template>
  <Transition name="activity-slide">
    <div v-if="visible" class="activity-bar" role="status">
      <!-- Expanded event list -->
      <Transition name="events-expand">
        <div v-if="expanded && events.length" class="activity-events">
          <div v-for="(evt, i) in events" :key="i" class="activity-event">
            <span class="event-time">{{ formatTime(evt.ts) }}</span>
            <span class="event-label">{{ evt.label }}</span>
            <span v-if="evt.durationSec" class="event-duration">{{ evt.durationSec }}s</span>
          </div>
        </div>
      </Transition>

      <!-- Main bar row -->
      <button :class="['activity-main', { 'is-done': !isActive }]" @click="toggle">
        <span class="activity-center">
          <span v-if="isActive" class="activity-dot" />
          <span class="activity-label">{{ currentLabel(activity) }}</span>
        </span>
        <span v-if="formatElapsed(elapsed)" class="activity-timer">{{ formatElapsed(elapsed) }}</span>
        <PhCaretRight
          v-if="events.length"
          :size="10"
          weight="bold"
          class="activity-chevron"
          :class="{ expanded }"
        />
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.activity-bar {
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  overflow: hidden;
}

.activity-main {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  background: none;
  cursor: pointer;
  transition: background var(--transition-fast);
  min-height: 26px;
}
.activity-main:hover {
  background: var(--color-tint);
}

.activity-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

/* Done state: hide label via opacity, keep layout stable */
.activity-main.is-done .activity-center {
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.activity-main.is-done:hover .activity-center {
  opacity: 1;
}

.activity-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
  animation: activity-pulse 2s ease-in-out infinite;
}

@keyframes activity-pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1); }
}

.activity-label {
  font-size: 12px;
  color: var(--color-muted);
  white-space: nowrap;
}

.activity-timer {
  font-size: 11px;
  color: var(--color-muted);
  opacity: 0.6;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.activity-chevron {
  color: var(--color-muted);
  opacity: 0.5;
  flex-shrink: 0;
  transition: transform var(--transition-fast);
  transform: rotate(90deg);
}
.activity-chevron.expanded {
  transform: rotate(-90deg);
}

/* Event list */
.activity-events {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 8px 2px;
  max-height: 200px;
  overflow-y: auto;
}

.activity-event {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  font-size: 11px;
}

.event-time {
  color: var(--color-muted);
  opacity: 0.45;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-size: 10px;
}

.event-label {
  color: var(--color-muted);
  opacity: 0.7;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.event-duration {
  color: var(--color-muted);
  opacity: 0.45;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* Transitions */
.activity-slide-enter-active {
  transition: opacity var(--transition-base), transform var(--transition-base);
}
.activity-slide-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}
.activity-slide-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.activity-slide-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.events-expand-enter-active,
.events-expand-leave-active {
  transition: opacity var(--transition-fast), max-height var(--transition-base);
  overflow: hidden;
}
.events-expand-enter-from,
.events-expand-leave-to {
  opacity: 0;
  max-height: 0;
}
.events-expand-enter-to,
.events-expand-leave-from {
  max-height: 200px;
}
</style>
