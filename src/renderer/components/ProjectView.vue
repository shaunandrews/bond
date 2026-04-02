<script setup lang="ts">
import { PhPlay, PhStop, PhChatCircle, PhTrash, PhCheck, PhX } from '@phosphor-icons/vue'
import { ref, watch } from 'vue'
import type { WordPressSite, WordPressSiteDetails, WpSiteMap, WpThemeJson } from '../../shared/wordpress'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondTab from './BondTab.vue'
import CopyButton from './CopyButton.vue'
import SiteMapView from './SiteMapView.vue'
import ThemeTokensView from './ThemeTokensView.vue'

const props = defineProps<{
  site: WordPressSite
  details: WordPressSiteDetails | null
  loadingDetails: boolean
  toggling: boolean
  deleting: boolean
  siteMap: WpSiteMap | null
  loadingSiteMap: boolean
  themeJson: WpThemeJson | null
  loadingThemeJson: boolean
}>()

const emit = defineEmits<{
  start: []
  stop: []
  chat: []
  delete: []
  loadSiteMap: []
  loadThemeJson: []
}>()

const tabs = [
  { id: 'details', label: 'Details' },
  { id: 'map', label: 'Map' },
  { id: 'theme', label: 'Theme' }
]

const activeTab = ref('details')
const confirmingDelete = ref(false)

watch(() => props.site.id, () => {
  activeTab.value = 'details'
  confirmingDelete.value = false
})

watch(activeTab, (tab) => {
  if (tab === 'theme' && !props.themeJson && !props.loadingThemeJson && props.site.running) {
    emit('loadThemeJson')
  }
})

function openUrl(url: string) {
  window.bond.openExternal(url)
}
</script>

<template>
  <div class="project-view" :class="{ 'is-canvas': activeTab === 'map' }">
    <!-- Header area (always constrained) -->
    <div class="project-top">
      <div class="project-header">
        <BondText as="h2" size="xl" weight="semibold">{{ site.name }}</BondText>
        <div class="project-url-row">
          <BondText as="a" size="sm" color="accent" mono :href="site.url" @click.prevent="openUrl(site.url)">{{ site.url }}</BondText>
          <CopyButton :value="site.url" />
        </div>
        <div class="project-path-row">
          <BondText size="sm" color="muted" mono>{{ site.path }}</BondText>
          <CopyButton :value="site.path" />
        </div>
      </div>

      <div class="project-actions">
        <BondButton v-if="!site.running" variant="secondary" size="sm" :disabled="toggling" @click="emit('start')">
          <PhPlay :size="14" weight="bold" />
          {{ toggling ? 'Starting...' : 'Start site' }}
        </BondButton>
        <BondButton v-else variant="secondary" size="sm" :disabled="toggling" @click="emit('stop')">
          <PhStop :size="14" weight="bold" />
          {{ toggling ? 'Stopping...' : 'Stop site' }}
        </BondButton>
        <BondButton variant="secondary" size="sm" @click="emit('chat')">
          <PhChatCircle :size="14" weight="bold" />
          Chat about this site
        </BondButton>
      </div>

      <BondTab :tabs="tabs" v-model="activeTab" />
    </div>

    <!-- Details tab -->
    <div v-if="activeTab === 'details'" class="project-content">
      <div class="project-details">
        <div class="detail-row">
          <BondText size="sm" color="muted">Status</BondText>
          <BondText v-if="toggling" size="sm" color="accent">{{ site.running ? 'Stopping...' : 'Starting...' }}</BondText>
          <BondText v-else size="sm" :color="site.running ? 'ok' : 'muted'">{{ site.running ? 'Running' : 'Stopped' }}</BondText>
        </div>
        <div class="detail-row">
          <BondText size="sm" color="muted">URL</BondText>
          <BondText size="sm" mono>{{ site.url }}</BondText>
        </div>
        <div v-if="site.customDomain" class="detail-row">
          <BondText size="sm" color="muted">Custom domain</BondText>
          <BondText size="sm" mono>{{ site.customDomain }}</BondText>
        </div>
        <div class="detail-row">
          <BondText size="sm" color="muted">Port</BondText>
          <BondText size="sm" mono>{{ site.port }}</BondText>
        </div>
        <div v-if="details" class="detail-row">
          <BondText size="sm" color="muted">WordPress</BondText>
          <BondText size="sm" mono>{{ details.wpVersion }}</BondText>
        </div>
        <div class="detail-row">
          <BondText size="sm" color="muted">PHP</BondText>
          <BondText size="sm" mono>{{ site.phpVersion }}</BondText>
        </div>
        <div class="detail-row">
          <BondText size="sm" color="muted">HTTPS</BondText>
          <BondText size="sm">{{ site.enableHttps ? 'Enabled' : 'Disabled' }}</BondText>
        </div>
        <div class="detail-row">
          <BondText size="sm" color="muted">Auto-start</BondText>
          <BondText size="sm">{{ site.autoStart ? 'Yes' : 'No' }}</BondText>
        </div>
        <div class="detail-row">
          <BondText size="sm" color="muted">Auto-update</BondText>
          <BondText size="sm">{{ site.isWpAutoUpdating ? 'Yes' : 'No' }}</BondText>
        </div>
      </div>

      <div v-if="details" class="project-section">
        <BondText as="h3" size="sm" weight="semibold" color="muted">Content</BondText>
        <div class="project-details">
          <div v-if="details.siteTitle" class="detail-row">
            <BondText size="sm" color="muted">Site title</BondText>
            <BondText size="sm">{{ details.siteTitle }}</BondText>
          </div>
          <div v-if="details.tagline" class="detail-row">
            <BondText size="sm" color="muted">Tagline</BondText>
            <BondText size="sm">{{ details.tagline }}</BondText>
          </div>
          <div class="detail-row">
            <BondText size="sm" color="muted">Posts</BondText>
            <BondText size="sm">{{ details.postCount }}</BondText>
          </div>
          <div class="detail-row">
            <BondText size="sm" color="muted">Pages</BondText>
            <BondText size="sm">{{ details.pageCount }}</BondText>
          </div>
          <div class="detail-row">
            <BondText size="sm" color="muted">Users</BondText>
            <BondText size="sm">{{ details.userCount }}</BondText>
          </div>
          <div v-if="details.permalinkStructure" class="detail-row">
            <BondText size="sm" color="muted">Permalinks</BondText>
            <BondText size="sm" mono>{{ details.permalinkStructure }}</BondText>
          </div>
        </div>
      </div>

      <div v-if="details && details.themes.length" class="project-section">
        <BondText as="h3" size="sm" weight="semibold" color="muted">Theme</BondText>
        <div class="project-details">
          <div v-for="theme in details.themes.filter(t => t.status === 'active')" :key="theme.name" class="detail-row">
            <BondText size="sm">{{ theme.name }}</BondText>
            <BondText size="sm" color="muted" mono>{{ theme.version }}</BondText>
          </div>
          <div v-for="theme in details.themes.filter(t => t.status !== 'active')" :key="theme.name" class="detail-row detail-row--inactive">
            <BondText size="sm" color="muted">{{ theme.name }}</BondText>
            <BondText size="sm" color="muted" mono>{{ theme.version }}</BondText>
          </div>
        </div>
      </div>

      <div v-if="details && details.plugins.length" class="project-section">
        <BondText as="h3" size="sm" weight="semibold" color="muted">Plugins</BondText>
        <div class="project-details">
          <div v-for="plugin in details.plugins" :key="plugin.name" class="detail-row" :class="{ 'detail-row--inactive': plugin.status !== 'active' }">
            <div class="plugin-name">
              <BondText size="sm" :color="plugin.status === 'active' ? 'primary' : 'muted'">{{ plugin.name }}</BondText>
              <BondText v-if="plugin.updateVersion" size="xs" color="accent">update available</BondText>
            </div>
            <BondText size="sm" color="muted" mono>{{ plugin.version }}</BondText>
          </div>
        </div>
      </div>

      <div v-if="details && details.templates.length" class="project-section">
        <BondText as="h3" size="sm" weight="semibold" color="muted">Templates</BondText>
        <div class="project-details">
          <div v-for="template in details.templates" :key="template.name" class="detail-row">
            <BondText size="sm">{{ template.title }}</BondText>
            <BondText size="sm" color="muted" mono>{{ template.name }}</BondText>
          </div>
        </div>
      </div>

      <div v-if="loadingDetails" class="project-loading">
        <BondText size="sm" color="muted">Loading site details...</BondText>
      </div>
      <div v-if="!site.running && !loadingDetails && !details" class="project-loading">
        <BondText size="sm" color="muted">Start the site to see themes, plugins, and content details.</BondText>
      </div>

      <div class="project-details">
        <div class="detail-row">
          <BondText size="sm" color="muted">Admin username</BondText>
          <div class="detail-value-copy">
            <BondText size="sm" mono>{{ site.adminUsername || 'admin' }}</BondText>
            <CopyButton :value="site.adminUsername || 'admin'" />
          </div>
        </div>
        <div class="detail-row">
          <BondText size="sm" color="muted">Admin password</BondText>
          <div class="detail-value-copy">
            <BondText size="sm" mono>{{ site.adminPassword }}</BondText>
            <CopyButton :value="site.adminPassword" />
          </div>
        </div>
        <div v-if="site.adminEmail" class="detail-row">
          <BondText size="sm" color="muted">Admin email</BondText>
          <BondText size="sm" mono>{{ site.adminEmail }}</BondText>
        </div>
        <div class="detail-row">
          <BondText size="sm" color="muted">Path</BondText>
          <BondText size="sm" mono>{{ site.path }}</BondText>
        </div>
        <div v-if="site.enableXdebug != null" class="detail-row">
          <BondText size="sm" color="muted">Xdebug</BondText>
          <BondText size="sm">{{ site.enableXdebug ? 'Enabled' : 'Disabled' }}</BondText>
        </div>
        <div v-if="site.enableDebugLog != null" class="detail-row">
          <BondText size="sm" color="muted">Debug log</BondText>
          <BondText size="sm">{{ site.enableDebugLog ? 'Enabled' : 'Disabled' }}</BondText>
        </div>
        <div v-if="site.enableDebugDisplay != null" class="detail-row">
          <BondText size="sm" color="muted">Debug display</BondText>
          <BondText size="sm">{{ site.enableDebugDisplay ? 'Enabled' : 'Disabled' }}</BondText>
        </div>
      </div>

      <div class="project-danger">
        <div v-if="!confirmingDelete" class="danger-row">
          <div>
            <BondText size="sm" weight="medium">Delete site</BondText>
            <BondText size="sm" color="muted">Remove this site and move its files to the trash.</BondText>
          </div>
          <BondButton variant="danger" size="sm" :disabled="deleting" @click="confirmingDelete = true">
            <PhTrash :size="14" weight="bold" />
            Delete
          </BondButton>
        </div>
        <div v-else class="danger-row">
          <BondText size="sm" color="err">Are you sure? This will delete <strong>{{ site.name }}</strong> and trash its files.</BondText>
          <div class="danger-actions">
            <BondButton variant="danger" size="sm" :disabled="deleting" @click="emit('delete')">
              <PhCheck :size="14" weight="bold" />
              {{ deleting ? 'Deleting...' : 'Yes, delete' }}
            </BondButton>
            <BondButton variant="ghost" size="sm" :disabled="deleting" @click="confirmingDelete = false">
              <PhX :size="14" weight="bold" />
              Cancel
            </BondButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Map tab (fills all available space) -->
    <div v-else-if="activeTab === 'map'" class="project-canvas">
      <div v-if="!site.running" class="project-loading canvas-msg">
        <BondText size="sm" color="muted">Start the site to view the site map.</BondText>
      </div>
      <SiteMapView v-else-if="siteMap" :siteMap="siteMap" :siteUrl="site.url" :refreshing="loadingSiteMap" @refresh="emit('loadSiteMap')" />
      <div v-else-if="loadingSiteMap" class="project-loading canvas-msg">
        <BondText size="sm" color="muted">Loading site map...</BondText>
      </div>
      <div v-else class="project-loading canvas-msg">
        <BondText size="sm" color="muted">No site map data available.</BondText>
      </div>
    </div>

    <!-- Theme tab -->
    <div v-else-if="activeTab === 'theme'" class="project-content">
      <div v-if="loadingThemeJson" class="project-loading">
        <BondText size="sm" color="muted">Loading theme data...</BondText>
      </div>
      <div v-else-if="!site.running" class="project-loading">
        <BondText size="sm" color="muted">Start the site to view theme data.</BondText>
      </div>
      <ThemeTokensView v-else-if="themeJson" :themeJson="themeJson" />
      <div v-else class="project-loading">
        <BondText size="sm" color="muted">This theme does not include a theme.json file. Theme tokens are only available for block themes.</BondText>
      </div>
    </div>
  </div>
</template>

<style scoped>
.project-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* Header area — always padded and constrained */
.project-top {
  padding: 1.5rem 1.5rem 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 640px;
}

/* Scrollable content for Details and Theme tabs */
.project-content {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 640px;
}

/* Canvas area — fills remaining space, no max-width */
.project-canvas {
  flex: 1;
  min-height: 0;
  display: flex;
}

.canvas-msg {
  padding: 1.5rem;
}

.project-header {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.project-url-row,
.project-path-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.project-url-row a {
  cursor: pointer;
}
.project-url-row a:hover {
  text-decoration: underline;
}

.project-actions {
  display: flex;
  gap: 0.5rem;
}

.project-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.project-details {
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

.detail-value-copy {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.plugin-name {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.project-loading {
  padding: 0.5rem 0;
}

.project-danger {
  border: 1px solid var(--color-err);
  border-radius: var(--radius-lg);
  padding: 0.875rem;
}

.danger-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.danger-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}
</style>
