<script setup lang="ts">
import { onMounted, onUnmounted, watch, computed, ref } from 'vue'
import { useSense, appColor } from '../composables/useSense'
import type { SenseCapture } from '../../shared/sense'
import BondToolbar from './BondToolbar.vue'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'
import SenseDayNav from './SenseDayNav.vue'
import SenseSearch from './SenseSearch.vue'
import SenseDetail from './SenseDetail.vue'
import { PhArrowLeft } from '@phosphor-icons/vue'

const sense = useSense()

let refreshTimer: ReturnType<typeof setInterval> | null = null
const REFRESH_INTERVAL = 30_000

function startAutoRefresh() {
  stopAutoRefresh()
  if (sense.isToday.value) {
    refreshTimer = setInterval(() => {
      if (!sense.loading.value) sense.loadDay(sense.date.value)
    }, REFRESH_INTERVAL)
  }
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

watch(() => sense.isToday.value, (isToday) => {
  if (isToday) startAutoRefresh()
  else stopAutoRefresh()
})

onMounted(() => {
  if (sense.captures.value.length === 0 && !sense.loading.value) {
    sense.loadDay(sense.date.value)
  }
  startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})

const showDetail = computed(() => !!sense.activeCapture.value)

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function isDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
</script>

<template>
  <div class="sense-panel">
    <!-- Detail view -->
    <template v-if="showDetail">
      <BondToolbar label="Sense capture" drag blur class="sense-panel-toolbar">
        <template #start>
          <BondButton variant="ghost" size="sm" icon @click="sense.selectCapture('')" v-tooltip="'Back to list'">
            <PhArrowLeft :size="14" weight="bold" />
          </BondButton>
          <BondText size="sm" weight="medium" truncate>{{ sense.activeCapture.value?.appName ?? 'Capture' }}</BondText>
        </template>
      </BondToolbar>
      <div class="sense-panel-scroll">
        <SenseDetail
          :capture="sense.activeCapture.value"
          :image="sense.activeCaptureImage.value"
          :loadingImage="sense.loadingImage.value"
        />
      </div>
    </template>

    <!-- List view -->
    <template v-else>
      <BondToolbar label="Sense" drag blur class="sense-panel-toolbar">
        <template #start>
          <BondText size="sm" weight="medium" color="muted">Sense</BondText>
        </template>
        <template #end>
          <SenseSearch
            :results="sense.searchResults.value"
            :query="sense.searchQuery.value"
            @search="sense.search($event)"
            @select="sense.jumpToCapture($event)"
            @clear="sense.search('')"
          />
        </template>
      </BondToolbar>

      <div class="sense-panel-nav">
        <SenseDayNav
          :date="sense.date.value"
          :isToday="sense.isToday.value"
          :captureCount="sense.captures.value.length"
          :sessionCount="sense.sessions.value.length"
          @prev="sense.prevDay()"
          @next="sense.nextDay()"
          @pick="sense.loadDay($event)"
        />
      </div>

      <div class="sense-panel-scroll">
        <div v-if="sense.loading.value" class="sense-panel-empty">
          <BondText size="sm" color="muted">Loading captures...</BondText>
        </div>

        <div v-else-if="sense.captures.value.length === 0" class="sense-panel-empty">
          <BondText size="sm" color="muted">No captures on this day.</BondText>
        </div>

        <div v-else class="sense-capture-list">
          <button
            v-for="cap in sense.captures.value"
            :key="cap.id"
            class="sense-capture-item"
            @click="sense.selectCapture(cap.id)"
          >
            <span
              class="capture-app-dot"
              :style="{ background: appColor(cap.appBundleId || cap.appName || 'unknown', isDark()) }"
            />
            <div class="capture-item-body">
              <BondText size="sm" truncate>{{ cap.appName }}</BondText>
              <BondText size="xs" color="muted" truncate>{{ cap.windowTitle }}</BondText>
            </div>
            <BondText size="xs" color="muted" class="capture-item-time">{{ formatTime(cap.capturedAt) }}</BondText>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sense-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.sense-panel-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  flex-shrink: 0;
}

.sense-panel-nav {
  flex-shrink: 0;
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--color-border);
}

.sense-panel-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.sense-panel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
}

.sense-capture-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0.25rem 0.375rem;
}

.sense-capture-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: var(--radius-md);
  text-align: left;
  width: 100%;
  transition: background var(--transition-fast);
}
.sense-capture-item:hover {
  background: var(--color-tint);
}

.capture-app-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.capture-item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
}

.capture-item-time {
  flex-shrink: 0;
}
</style>
