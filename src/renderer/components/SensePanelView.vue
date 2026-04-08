<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useSense } from '../composables/useSense'
import BondToolbar from './BondToolbar.vue'
import BondText from './BondText.vue'
import SenseDayNav from './SenseDayNav.vue'
import SenseSearch from './SenseSearch.vue'
import SenseDetail from './SenseDetail.vue'
import SenseAppLegend from './SenseAppLegend.vue'
import SenseTimeline from './SenseTimeline.vue'

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
  sense.selectCapture('')
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
  <div class="sense-panel">
    <!-- Toolbar: search | date nav -->
    <BondToolbar label="Sense" drag blur class="sense-panel-toolbar">
      <template #start>
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
    <div class="sense-panel-body">
      <div v-if="sense.loading.value" class="sense-panel-empty">
        <BondText size="sm" color="muted">Loading captures...</BondText>
      </div>

      <div v-else-if="sense.captures.value.length === 0" class="sense-panel-empty">
        <BondText size="sm" color="muted">No captures on this day.</BondText>
      </div>

      <SenseDetail
        v-else
        :capture="sense.displayCapture.value"
        :image="sense.displayCaptureImage.value"
        :loadingImage="sense.displayLoadingImage.value"
      />
    </div>

    <!-- Bottom dock: app legend + timeline scrubber -->
    <div v-if="sense.captures.value.length > 0" class="sense-panel-dock">
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
.sense-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.sense-panel-toolbar {
  flex-shrink: 0;
  z-index: 10;
}

.sense-panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sense-panel-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
}

.sense-panel-dock {
  flex-shrink: 0;
  border-top: 1px solid var(--color-border);
  padding: 0.375rem 1rem 0.5rem;
  background: var(--color-bg);
}
</style>
