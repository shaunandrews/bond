<script setup lang="ts">
import { PhGlobe, PhPlay, PhStop, PhChatCircle, PhTrash, PhCheck, PhX } from '@phosphor-icons/vue'
import { ref } from 'vue'
import type { WordPressSite, WordPressSiteDetails } from '../../shared/wordpress'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'

defineProps<{
  site: WordPressSite
  details: WordPressSiteDetails | null
  loadingDetails: boolean
  toggling: boolean
  deleting: boolean
}>()

const emit = defineEmits<{
  open: []
  start: []
  stop: []
  chat: []
  delete: []
}>()

const confirmingDelete = ref(false)
</script>

<template>
  <div class="wp-site-view">
    <!-- Site header -->
    <div class="wp-site-header">
      <div class="wp-site-title-row">
        <span :class="['wp-dot', { running: site.running }]" />
        <BondText as="h2" size="xl" weight="semibold">{{ site.name }}</BondText>
      </div>
      <BondText size="sm" color="muted" mono>{{ site.path }}</BondText>
    </div>

    <!-- Quick actions -->
    <div class="wp-site-actions">
      <BondButton variant="primary" size="sm" :disabled="!site.running" @click="emit('open')">
        <PhGlobe :size="16" weight="bold" />
        Open in browser
      </BondButton>
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

    <!-- Site info -->
    <div class="wp-site-details">
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

    <!-- Content (only when details loaded) -->
    <div v-if="details" class="wp-site-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Content</BondText>
      <div class="wp-site-details">
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

    <!-- Active theme -->
    <div v-if="details && details.themes.length" class="wp-site-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Theme</BondText>
      <div class="wp-site-details">
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

    <!-- Plugins -->
    <div v-if="details && details.plugins.length" class="wp-site-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Plugins</BondText>
      <div class="wp-site-details">
        <div v-for="plugin in details.plugins" :key="plugin.name" class="detail-row" :class="{ 'detail-row--inactive': plugin.status !== 'active' }">
          <div class="plugin-name">
            <BondText size="sm" :color="plugin.status === 'active' ? 'primary' : 'muted'">{{ plugin.name }}</BondText>
            <BondText v-if="plugin.updateVersion" size="xs" color="accent">update available</BondText>
          </div>
          <BondText size="sm" color="muted" mono>{{ plugin.version }}</BondText>
        </div>
      </div>
    </div>

    <!-- Templates -->
    <div v-if="details && details.templates.length" class="wp-site-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Templates</BondText>
      <div class="wp-site-details">
        <div v-for="template in details.templates" :key="template.name" class="detail-row">
          <BondText size="sm">{{ template.title }}</BondText>
          <BondText size="sm" color="muted" mono>{{ template.name }}</BondText>
        </div>
      </div>
    </div>

    <!-- Loading details indicator -->
    <div v-if="loadingDetails" class="wp-site-loading">
      <BondText size="sm" color="muted">Loading site details...</BondText>
    </div>

    <!-- Not running hint -->
    <div v-if="!site.running && !loadingDetails && !details" class="wp-site-loading">
      <BondText size="sm" color="muted">Start the site to see themes, plugins, and content details.</BondText>
    </div>

    <!-- Admin -->
    <div class="wp-site-details">
      <div class="detail-row">
        <BondText size="sm" color="muted">Admin username</BondText>
        <BondText size="sm" mono>{{ site.adminUsername }}</BondText>
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

    <!-- Delete -->
    <div class="wp-site-danger">
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
</template>

<style scoped>
.wp-site-view {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 600px;
}

.wp-site-header {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.wp-site-title-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.wp-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-muted);
}
.wp-dot.running {
  background: var(--color-ok);
}

.wp-site-actions {
  display: flex;
  gap: 0.5rem;
}

.wp-site-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.wp-site-details {
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

.plugin-name {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.wp-site-loading {
  padding: 0.5rem 0;
}

.wp-site-danger {
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
