<script setup lang="ts">
import { ref } from 'vue'
import { useAccentColor } from './composables/useAccentColor'
import BondTab from './components/BondTab.vue'
import SettingsView from './components/SettingsView.vue'
import DesignSystemView from './components/DesignSystemView.vue'
import DevComponents from './components/DevComponents.vue'
import AboutView from './components/AboutView.vue'

const tabs = [
  { id: 'settings', label: 'Settings' },
  { id: 'design', label: 'Design' },
  { id: 'components', label: 'Components' },
  { id: 'about', label: 'About' },
]

const activeTab = ref('settings')

const { load: loadAccent } = useAccentColor()
loadAccent()

function handleCreateSkill(description: string) {
  window.bond.createSkillViaChat(description)
}
</script>

<template>
  <div class="settings-window">
    <div class="sw-scroll-area">
      <header class="sw-header drag-region">
        <div class="sw-tab-wrap no-drag">
          <BondTab :tabs="tabs" v-model="activeTab" />
        </div>
      </header>

      <div class="sw-content">
        <div class="sw-content-inner">
          <SettingsView v-if="activeTab === 'settings'" @createSkill="handleCreateSkill" />
          <DesignSystemView v-else-if="activeTab === 'design'" />
          <DevComponents v-else-if="activeTab === 'components'" />
          <AboutView v-else-if="activeTab === 'about'" />
        </div>
      </div>
    </div>
  </div>
</template>

<style>
@import './app.css';

.settings-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

.sw-scroll-area {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.sw-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.875rem 1rem;
}

.sw-header::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: -24px;
  z-index: -1;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  mask-image: linear-gradient(to bottom, black 40%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, black 40%, transparent);
}

.sw-tab-wrap {
  display: flex;
}

.sw-content {
  flex: 1;
}

.sw-content-inner {
  max-width: 640px;
  margin-inline: auto;
  padding: 0.5rem 1.5rem 2rem;
}
</style>
