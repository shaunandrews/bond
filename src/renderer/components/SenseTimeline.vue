<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { SenseCapture, SenseSession } from '../../shared/sense'
import { appColor } from '../composables/useSense'
import BondText from './BondText.vue'

const props = defineProps<{
  captures: SenseCapture[]
  sessions: SenseSession[]
  activeCaptureId: string | null
  appFilter: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  preview: [id: string]
  'preview-clear': []
}>()

const containerRef = ref<HTMLElement | null>(null)
const hoverIndex = ref<number | null>(null)

function isDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

// Build time buckets: 1 bucket per minute = 1440 for a full day
const BUCKET_COUNT = 1440
const MINUTES_IN_DAY = 1440

interface Bucket {
  minute: number
  captures: SenseCapture[]
  dominantApp: string | null
  inSession: boolean
}

const buckets = computed(() => {
  const result: Bucket[] = Array.from({ length: BUCKET_COUNT }, (_, i) => ({
    minute: i,
    captures: [],
    dominantApp: null,
    inSession: false,
  }))

  // Mark which minutes are in a session
  for (const session of props.sessions) {
    const startMin = timeToMinute(session.startedAt)
    const endMin = session.endedAt ? timeToMinute(session.endedAt) : MINUTES_IN_DAY - 1
    for (let m = Math.max(0, startMin); m <= Math.min(MINUTES_IN_DAY - 1, endMin); m++) {
      result[m].inSession = true
    }
  }

  // Assign captures to buckets
  for (const cap of props.captures) {
    const min = timeToMinute(cap.capturedAt)
    if (min >= 0 && min < BUCKET_COUNT) {
      result[min].captures.push(cap)
    }
  }

  // Compute dominant app per bucket
  for (const bucket of result) {
    if (bucket.captures.length > 0) {
      const counts = new Map<string, number>()
      for (const cap of bucket.captures) {
        const key = cap.appBundleId || cap.appName || 'unknown'
        counts.set(key, (counts.get(key) || 0) + 1)
      }
      let max = 0
      let dominant: string | null = null
      for (const [app, count] of counts) {
        if (count > max) { max = count; dominant = app }
      }
      bucket.dominantApp = dominant
    }
  }

  return result
})

// Find the range of minutes that actually have data (avoid rendering 1440 bars)
const activeRange = computed(() => {
  let first = BUCKET_COUNT
  let last = -1
  for (let i = 0; i < BUCKET_COUNT; i++) {
    if (buckets.value[i].inSession || buckets.value[i].captures.length > 0) {
      if (i < first) first = i
      if (i > last) last = i
    }
  }
  if (first > last) return { start: 0, end: BUCKET_COUNT - 1 }
  // Add some padding
  return {
    start: Math.max(0, first - 15),
    end: Math.min(BUCKET_COUNT - 1, last + 15),
  }
})

const visibleBuckets = computed(() => {
  const { start, end } = activeRange.value
  return buckets.value.slice(start, end + 1)
})

const maxCaptures = computed(() => {
  let max = 0
  for (const b of visibleBuckets.value) {
    if (b.captures.length > max) max = b.captures.length
  }
  return Math.max(max, 1)
})

// Playhead position (% through visible range)
const playheadPosition = computed(() => {
  if (!props.activeCaptureId) return null
  const cap = props.captures.find(c => c.id === props.activeCaptureId)
  if (!cap) return null
  const min = timeToMinute(cap.capturedAt)
  const { start, end } = activeRange.value
  if (min < start || min > end) return null
  return ((min - start) / (end - start + 1)) * 100
})

function timeToMinute(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

function minuteToTime(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${m.toString().padStart(2, '0')} ${period}`
}

function barHeight(bucket: Bucket): string {
  if (bucket.captures.length === 0) return '0%'
  return `${Math.max(8, (bucket.captures.length / maxCaptures.value) * 100)}%`
}

function barColor(bucket: Bucket): string {
  if (!bucket.dominantApp) return 'var(--color-muted)'
  if (props.appFilter && bucket.dominantApp !== props.appFilter) {
    return isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
  }
  return appColor(bucket.dominantApp, isDark())
}

function barOpacity(bucket: Bucket): number {
  if (props.appFilter && bucket.dominantApp !== props.appFilter) return 0.3
  return 1
}

function handleBarClick(index: number) {
  const bucket = visibleBuckets.value[index]
  if (!bucket || bucket.captures.length === 0) return
  // Pick the middle capture
  const cap = bucket.captures[Math.floor(bucket.captures.length / 2)]
  emit('select', cap.id)
}

function handleMouseEnter(index: number) {
  hoverIndex.value = index
  const bucket = visibleBuckets.value[index]
  if (bucket && bucket.captures.length > 0) {
    const cap = bucket.captures[Math.floor(bucket.captures.length / 2)]
    emit('preview', cap.id)
  }
}

function handleMouseLeave() {
  hoverIndex.value = null
  emit('preview-clear')
}

// Scroll-to-scrub
function handleWheel(e: WheelEvent) {
  e.preventDefault()
  if (props.captures.length === 0) return

  const currentId = props.activeCaptureId
  const caps = props.appFilter
    ? props.captures.filter(c => c.appBundleId === props.appFilter || c.appName === props.appFilter)
    : props.captures
  if (caps.length === 0) return

  const currentIdx = currentId ? caps.findIndex(c => c.id === currentId) : -1
  const delta = Math.sign(e.deltaY)
  const step = Math.max(1, Math.floor(Math.abs(e.deltaY) / 30))
  let nextIdx = currentIdx + delta * step
  nextIdx = Math.max(0, Math.min(caps.length - 1, nextIdx))

  emit('select', caps[nextIdx].id)
}

// Keyboard navigation
function handleKeyDown(e: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return
  e.preventDefault()

  const caps = props.appFilter
    ? props.captures.filter(c => c.appBundleId === props.appFilter || c.appName === props.appFilter)
    : props.captures
  if (caps.length === 0) return

  const currentIdx = props.activeCaptureId ? caps.findIndex(c => c.id === props.activeCaptureId) : -1

  if (e.shiftKey) {
    // Jump to next/prev session boundary
    const currentCap = currentIdx >= 0 ? caps[currentIdx] : null
    const currentSessionId = currentCap?.sessionId
    if (e.key === 'ArrowRight') {
      const next = caps.findIndex((c, i) => i > currentIdx && c.sessionId !== currentSessionId)
      if (next >= 0) emit('select', caps[next].id)
    } else {
      // Find previous session start
      for (let i = currentIdx - 1; i >= 0; i--) {
        if (caps[i].sessionId !== currentSessionId) {
          emit('select', caps[i].id)
          break
        }
      }
    }
  } else {
    const nextIdx = e.key === 'ArrowRight'
      ? Math.min(caps.length - 1, currentIdx + 1)
      : Math.max(0, currentIdx - 1)
    emit('select', caps[nextIdx].id)
  }
}

onMounted(() => {
  containerRef.value?.addEventListener('wheel', handleWheel, { passive: false })
})

onUnmounted(() => {
  containerRef.value?.removeEventListener('wheel', handleWheel)
})
</script>

<template>
  <div
    ref="containerRef"
    class="sense-timeline"
    tabindex="0"
    @keydown="handleKeyDown"
    @mouseleave="handleMouseLeave"
  >
    <!-- Time labels -->
    <div class="time-labels">
      <BondText size="xs" color="muted">{{ minuteToTime(activeRange.start) }}</BondText>
      <BondText size="xs" color="muted">{{ minuteToTime(Math.floor((activeRange.start + activeRange.end) / 2)) }}</BondText>
      <BondText size="xs" color="muted">{{ minuteToTime(activeRange.end) }}</BondText>
    </div>

    <!-- Density bars -->
    <div class="bars-container">
      <div
        v-for="(bucket, i) in visibleBuckets"
        :key="bucket.minute"
        :class="['bar-slot', { 'in-session': bucket.inSession, 'has-captures': bucket.captures.length > 0 }]"
        @click="handleBarClick(i)"
        @mouseenter="handleMouseEnter(i)"
      >
        <div
          class="bar"
          :style="{
            height: barHeight(bucket),
            background: barColor(bucket),
            opacity: barOpacity(bucket),
          }"
        />
      </div>

      <!-- Playhead -->
      <div
        v-if="playheadPosition != null"
        class="playhead"
        :style="{ left: playheadPosition + '%' }"
      />

      <!-- Hover time indicator -->
      <div
        v-if="hoverIndex != null"
        class="hover-time"
        :style="{ left: `${(hoverIndex / visibleBuckets.length) * 100}%` }"
      >
        <BondText size="xs" color="muted">{{ minuteToTime(visibleBuckets[hoverIndex]?.minute ?? 0) }}</BondText>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sense-timeline {
  padding: 0.5rem 1rem;
  outline: none;
  user-select: none;
}

.time-labels {
  display: flex;
  justify-content: space-between;
  padding: 0 2px;
  margin-bottom: 0.25rem;
}

.bars-container {
  position: relative;
  display: flex;
  align-items: flex-end;
  height: 72px;
  gap: 0;
}

.bar-slot {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
  cursor: pointer;
  position: relative;
}

.bar-slot::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--color-border);
  opacity: 0.3;
}

.bar-slot.in-session::after {
  opacity: 0.6;
  background: var(--color-muted);
}

.bar {
  width: 100%;
  min-height: 0;
  border-radius: 1px 1px 0 0;
  transition: height 0.08s ease;
}

.bar-slot:hover .bar {
  filter: brightness(1.2);
}

.bar-slot.has-captures {
  cursor: pointer;
}

.playhead {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 2px;
  background: var(--color-accent, var(--color-text-primary));
  border-radius: 1px;
  pointer-events: none;
  z-index: 2;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.2);
}

.playhead::before {
  content: '';
  position: absolute;
  top: -2px;
  left: -3px;
  width: 8px;
  height: 8px;
  background: var(--color-accent, var(--color-text-primary));
  border-radius: 50%;
}

.hover-time {
  position: absolute;
  bottom: calc(100% + 4px);
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 10;
  white-space: nowrap;
}
</style>
