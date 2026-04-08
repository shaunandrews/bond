<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useSense } from '../composables/useSense'
import BondToolbar from './BondToolbar.vue'
import SenseDayNav from './SenseDayNav.vue'
import SenseSearch from './SenseSearch.vue'
import SenseAppLegend from './SenseAppLegend.vue'
import SenseTimeline from './SenseTimeline.vue'
import SenseDetail from './SenseDetail.vue'
import BondText from './BondText.vue'

defineProps<{
  insetStart?: boolean
}>()

const sense = useSense()

let refreshTimer: ReturnType<typeof setInterval> | null = null
const REFRESH_INTERVAL = 30_000 // 30 seconds

function startAutoRefresh() {
  stopAutoRefresh()
  if (sense.isToday.value) {
    refreshTimer = setInterval(() => {
      if (!sense.loading.value) {
        sense.loadDay(sense.date.value)
      }
    }, REFRESH_INTERVAL)
  }
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

// Re-evaluate auto-refresh when the viewed date changes
watch(() => sense.isToday.value, (isToday) => {
  if (isToday) {
    startAutoRefresh()
  } else {
    stopAutoRefresh()
  }
})

onMounted(() => {
  // Always clear stale detail view when component remounts
  sense.selectCapture('')
  // Load today's data if not already loaded
  if (sense.captures.value.length === 0 && !sense.loading.value) {
    sense.loadDay(sense.date.value)
  }
  startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>

<template>
  <div class="sense-view">
    <!-- Header toolbar -->
    <BondToolbar label="Sense timeline" drag blur :insetStart="insetStart" class="sense-header">
      <template #start>
        <slot name="header-start" />
        <SenseSearch
          :results="sense.searchResults.value"
          :query="sense.searchQuery.value"
          @search="sense.search($event)"
          @select="sense.jumpToCapture($event)"
          @clear="sense.search('')"
        />
      </template>
      <template #middle>
        <SenseDayNav
          :date="sense.date.value"
          :isToday="sense.isToday.value"
          :captureCount="sense.captures.value.length"
          :sessionCount="sense.sessions.value.length"
          @prev="sense.prevDay()"
          @next="sense.nextDay()"
          @pick="sense.loadDay($event)"
        />
      </template>
    </BondToolbar>

    <!-- Main content area -->
    <div class="sense-body">
      <!-- Loading state -->
      <div v-if="sense.loading.value" class="sense-loading">
        <div class="loading-pulse" />
        <BondText size="sm" color="muted">Loading captures...</BondText>
      </div>

      <!-- Empty state -->
      <div v-else-if="sense.captures.value.length === 0" class="sense-empty">
        <BondText size="lg" color="muted" weight="medium">No captures</BondText>
        <BondText size="sm" color="muted">No screen activity was recorded on this day.</BondText>
        <BondText size="xs" color="muted">Sense captures your screen every 15 seconds when enabled.</BondText>
      </div>

      <!-- Detail viewer -->
      <SenseDetail
        v-else
        :capture="sense.displayCapture.value"
        :image="sense.displayCaptureImage.value"
        :loadingImage="sense.displayLoadingImage.value"
      />
    </div>

    <!-- Bottom dock: app legend + timeline -->
    <div v-if="sense.captures.value.length > 0" class="sense-dock">
      <SenseAppLegend
        :apps="sense.apps.value"
        :activeFilter="sense.appFilter.value"
        @filter="sense.setAppFilter($event)"
      />
      <SenseTimeline
        :captures="sense.filteredCaptures.value"
        :sessions="sense.sessions.value"
        :activeCaptureId="sense.activeCapture.value?.id ?? null"
        :appFilter="sense.appFilter.value"
        @select="sense.selectCapture($event)"
        @preview="sense.setPreview($event)"
        @preview-clear="sense.clearPreview()"
      />
    </div>
  </div>
</template>

<style scoped>
.sense-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

.sense-header {
  position: sticky;
  top: 0;
  z-index: 10;
  flex-shrink: 0;
}

.sense-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sense-loading,
.sense-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.loading-pulse {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--color-border);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.95); }
  50% { opacity: 0.6; transform: scale(1); }
}

.sense-dock {
  flex-shrink: 0;
  border-top: 1px solid var(--color-border);
  padding: 0.375rem 1rem 0.5rem;
  background: var(--color-bg);
}
</style>
