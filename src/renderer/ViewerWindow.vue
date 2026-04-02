<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import MarkdownMessage from './components/MarkdownMessage.vue'
import BondText from './components/BondText.vue'
import BondToolbar from './components/BondToolbar.vue'

const filePath = ref('')
const fileName = ref('')
const content = ref('')
const loading = ref(true)
const error = ref('')

let removeListener: (() => void) | null = null

async function loadFile(path: string) {
  const isRefresh = filePath.value === path && content.value !== ''
  filePath.value = path
  fileName.value = path.split('/').pop() ?? 'File'
  if (!isRefresh) {
    loading.value = true
    error.value = ''
  }
  try {
    const text = await window.bond.readFile(path)
    if (text === null) {
      error.value = 'File not found or cannot be read.'
    } else {
      content.value = text
      error.value = ''
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to read file.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  removeListener = window.bond.onViewerFile((path) => loadFile(path))
})

onUnmounted(() => {
  removeListener?.()
})
</script>

<template>
  <div class="viewer-window">
    <BondToolbar label="Viewer" drag>
      <template #middle>
        <BondText size="sm" weight="medium" color="muted" truncate>{{ fileName }}</BondText>
      </template>
    </BondToolbar>

    <div class="viewer-content">
      <div v-if="loading" class="viewer-status">
        <BondText size="sm" color="muted">Loading...</BondText>
      </div>
      <div v-else-if="error" class="viewer-status">
        <BondText size="sm" color="err">{{ error }}</BondText>
      </div>
      <div v-else class="viewer-body">
        <MarkdownMessage :text="content" :streaming="false" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.viewer-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.viewer-status {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem;
}

.viewer-body {
  padding: 1.5rem 2rem 3rem;
  max-width: 720px;
  margin-inline: auto;
}
</style>
